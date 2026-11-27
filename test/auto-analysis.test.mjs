import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { AUTO_ANALYSIS_TRIGGER, reserveAutoAnalysisSlot } from "../build/auto-analysis.js";
import { INTERVAL_MS } from "../build/market.js";
import { makeServer } from "../build/server.js";
import { jwt, klines, NOW } from "./fixtures.mjs";

const period = INTERVAL_MS["5m"];
const storage = "/private/market-signal-auto-analysis/v1/BTCUSDT/slots";
const legacy = "/private/market-signal-scanner/v1/BTCUSDT";
const archive = "/private/.trading/owner/market-signals";
const tradeLogs = `${archive}/records/trade-results/v1`;
const archiveRecord = key => key.startsWith(`${archive}/records/`) && !key.startsWith(tradeLogs);
const demoHost = "demo-fapi.binance.com";
const scanId = "f33b92e5-7ade-471a-b3c4-d638b5e1b542";
const legacyAnalysisId = "e547a3bc-f391-422e-a5e4-45082bff7f83";

function candles(interval, at, state) {
  return klines(INTERVAL_MS[interval], at).map((row, i) => {
    const close = 10000 + (i - 199) * 0.5;
    const high = interval === "1h" && i === 185 && !state.noOrder ? 10140 : close + 39;
    const low = interval === "1h" && i === 195 ? 9995 : close - 1;
    const highVolume = interval === "5m" && !state.noTrigger || interval === "15m" && state.noTrigger;
    const volume = i === 199 && highVolume ? 20 : 10;
    [row[1], row[2], row[3], row[4], row[5]] = [close, high, low, close, volume].map(String);
    return row;
  });
}

async function testServer(t, limit, state = { now: NOW + 5000 }, objects = new Map()) {
  const logs = [];
  const marketCalls = [];
  const submissions = [];
  const orders = new Map();
  const protection = new Map();
  let reads5m = 0;
  const analysisFetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname.endsWith("aliyuncs.com") && url.hostname.startsWith("auto-analysis-test.")) {
      const current = objects.get(url.pathname);
      const ossHeaders = { "x-oss-request-id": "mock-oss-id" };
      if (state.rejectQuota && url.pathname.startsWith(storage)) return new Response(null, { status: 503, headers: ossHeaders });
      if (state.rejectArchive && url.pathname.includes("/review-queue/")) return new Response(null, { status: 403, headers: ossHeaders });
      if (state.rejectTradeLogs && url.pathname.startsWith(tradeLogs)) return new Response(null, { status: 403, headers: ossHeaders });
      if (options.method === "POST") {
        const length = Buffer.byteLength(current ?? "");
        if (Number(url.searchParams.get("position")) !== length) return new Response(null, {
          status: 409, headers: { ...ossHeaders, "x-oss-next-append-position": String(length) },
        });
        objects.set(url.pathname, (current ?? "") + options.body);
        return new Response(null);
      }
      if (options.method === "PUT") {
        const heartbeat = url.pathname.endsWith("/protection/heartbeat.json");
        if (!heartbeat) assert.equal(options.headers["x-oss-forbid-overwrite"], "true");
        if (current && !heartbeat) return new Response(null, { status: 409 });
        objects.set(url.pathname, options.body);
        return new Response(null);
      }
      return current === undefined ? new Response(null, { status: 404, headers: ossHeaders }) : new Response(current);
    }
    marketCalls.push({ host: url.hostname, path: url.pathname, interval: url.searchParams.get("interval") });
    assert.equal(url.hostname, state.autoOrder && state.execution ? demoHost : "fapi.binance.com");
    if (url.pathname.endsWith("/time")) return Response.json({ serverTime: state.now });
    if (url.pathname.endsWith("/exchangeInfo")) return Response.json({ symbols: [{ symbol: "BTCUSDT",
      contractType: "PERPETUAL", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.10" }] }] });
    if (url.pathname.endsWith("/premiumIndex")) return Response.json({ symbol: "BTCUSDT",
      markPrice: String(state.mark ?? 10000), indexPrice: "10000", lastFundingRate: "0",
      nextFundingTime: state.now + 3600000, time: state.now });
    if (url.pathname.endsWith("/openInterestHist")) {
      return Response.json([{ symbol: "BTCUSDT", timestamp: state.now - 1000, sumOpenInterest: "100", sumOpenInterestValue: "1000000" }]);
    }
    assert.ok(url.pathname.endsWith("/klines"), url.pathname);
    const interval = url.searchParams.get("interval");
    const rows = candles(interval, Number(url.searchParams.get("endTime")), state);
    if (interval === "5m" && ++reads5m === 1 && state.delayClose) rows.splice(199, 1);
    return Response.json(rows);
  };
  const orderFetch = async (input, options) => {
    const url = new URL(input);
    if (url.search === "?versioning") return new Response("<VersioningConfiguration/>");
    if (url.hostname.endsWith(".aliyuncs.com")) {
      if (options.method === "DELETE") {
        assert.match(url.pathname, /locks\/btcusdt\.json$/);
        objects.delete(url.pathname);
        return new Response(null, { status: 204 });
      }
      return analysisFetch(input, options);
    }
    assert.equal(url.hostname, demoHost);
    if (url.pathname.endsWith("/exchangeInfo")) {
      const lot = { minQty: "0.001", maxQty: "20", stepSize: "0.001" };
      return Response.json({ symbols: [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING",
        contractType: "PERPETUAL", orderTypes: ["LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"], timeInForce: ["IOC"],
        filters: [{ filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "0.1" },
          { filterType: "LOT_SIZE", ...lot }, { filterType: "MARKET_LOT_SIZE", ...lot },
          { filterType: "MIN_NOTIONAL", notional: "5" }, { filterType: "PERCENT_PRICE", multiplierUp: "1.1", multiplierDown: "0.9" }] }] });
    }
    if (url.pathname.endsWith("/premiumIndex")) return Response.json({ symbol: "BTCUSDT", markPrice: String(state.mark ?? 10000), time: state.now });
    if (url.pathname.endsWith("/bookTicker")) return Response.json({ symbol: "BTCUSDT", bidPrice: "9999.9", bidQty: "1",
      askPrice: state.askPrice ?? "10000.1", askQty: "1", time: state.now });
    if (url.pathname.endsWith("/dual")) return Response.json({ dualSidePosition: true });
    if (url.pathname.endsWith("/positionRisk")) return Response.json([...orders.values()].filter(order => !state.closed && Number(order.executedQty) > 0)
      .map(order => ({ symbol: "BTCUSDT", positionSide: order.positionSide,
        positionAmt: order.positionSide === "LONG" ? order.executedQty : "-" + order.executedQty })));
    if (url.pathname.endsWith("/openOrders") || url.pathname.endsWith("/openAlgoOrders")) return Response.json([]);
    const algo = url.pathname.endsWith("/algoOrder");
    assert.ok(algo || url.pathname.endsWith("/order"));
    if (options.method === "POST") {
      const params = Object.fromEntries(new URLSearchParams(options.body));
      submissions.push(params);
      if (algo) {
        const event = { symbol: "BTCUSDT", algoId: 52, clientAlgoId: params.clientAlgoId, algoStatus: "NEW", orderType: params.type,
          positionSide: params.positionSide, side: params.side, workingType: params.workingType,
          closePosition: params.closePosition === "true", triggerPrice: params.triggerPrice };
        protection.set(params.clientAlgoId, event);
        return Response.json(event);
      }
      assert.ok([...objects.keys()].some(path => path.startsWith(archive + "/index/")));
      assert.ok([...objects.keys()].some(path => path.endsWith("/intent.json")));
      const entry = { symbol: "BTCUSDT", orderId: 45, clientOrderId: params.newClientOrderId, status: state.entryStatus ?? "FILLED",
        positionSide: params.positionSide, side: params.side, executedQty: state.entryQty ?? "0.001", avgPrice: "10000.1", updateTime: state.now };
      orders.set(params.newClientOrderId, entry);
      return state.unknownEntry ? Response.json({ code: -1007 }, { status: 503 }) : Response.json(entry);
    }
    if (url.searchParams.get("orderId") === "62" && state.closed) return Response.json({ symbol: "BTCUSDT", orderId: 62,
      positionSide: "LONG", side: "SELL", status: "FILLED", executedQty: state.exitQty ?? "0.001", avgPrice: "10150.1", updateTime: state.closed });
    const row = algo ? protection.get(url.searchParams.get("clientAlgoId")) : orders.get(url.searchParams.get("origClientOrderId"));
    if (row && options.method === "DELETE") row.algoStatus = "CANCELED";
    return row ? Response.json(row) : Response.json({ code: -2013 }, { status: 400 });
  };
  const server = makeServer({
    env: { OSS_BUCKET: "auto-analysis-test", OSS_REGION: "cn-hangzhou", ACCESS_KEY_ID: "test-oss-id",
      ACCESS_KEY_SECRET: "test-oss-secret-key", SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT: limit,
      // A legacy manual-model setting must not select the timer engine.
      USE_DETERMINISTIC_MODELS: "false", MARKET_DATA_MODE: "websocket",
      SIGNAL_AUTO_ORDER_EXECUTE: state.autoOrder ? "true" : undefined,
      SIGNAL_ORDER_EXECUTE: state.execution ? "true" : undefined,
      SIGNAL_ORDER_MODE: "demo", BINANCE_BASE_URL: `https://${demoHost}`, SIGNAL_ORDER_MAX_RISK_USDT: state.maxRisk,
      BINANCE_API_KEY: "test-binance-apikey", BINANCE_API_SECRET: "test-binance-secret" },
    now: () => state.now, analysisFetch, orderFetch,
    model: async () => assert.fail("timer called the model"),
    logger: { info: line => logs.push(JSON.parse(line)), error: line => logs.push(JSON.parse(line)) },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function post(path, body, headers) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { http: response.status, data: await response.json() };
  }
  const timer = (name, time = state.now, headers) => post("/invoke", { triggerName: name, triggerTime: new Date(time).toISOString() },
    { "x-fc-control-path": "/invoke", "x-fc-request-id": "test-trigger", ...headers });
  const invoke = async time => {
    const { http, data } = await timer(AUTO_ANALYSIS_TRIGGER, time);
    assert.equal(http, 200);
    return data;
  };
  const ticket = (scope = "trading:sync") => {
    const iat = Math.floor(state.now / 1000);
    return { "X-JWT-Token": jwt({ iat, exp: iat + 120, scope }) };
  };
  const execution = async (analysis, requestedScanId = analysis.requestId, scope = "trading:sync") =>
    post("/scans", { action: "execution", analysisId: analysis.analysisId, scanId: requestedScanId }, ticket(scope));
  return { state, objects, marketCalls, submissions, logs, post, timer, invoke, ticket, protection, execution,
    recover: () => timer("market-order-protection"),
    decision: id => JSON.parse(objects.get(`${tradeLogs}/decisions/${id}.json`)),
    outcome: (id, phase = "analysis") => JSON.parse(objects.get(`${tradeLogs}/outcomes/${id}/${phase}.json`)),
    saved: id => JSON.parse(objects.get(`${archive}/records/${id}.json`)) };
}

test("retired timer and untrusted events cannot start analysis", async t => {
  const app = await testServer(t, "1");
  assert.equal((await app.timer("binance-market-scanner")).http, 401);
  assert.equal((await app.timer(AUTO_ANALYSIS_TRIGGER, app.state.now, { "x-fc-control-path": "/http-invoke" })).http, 401);
  assert.equal((await app.timer(AUTO_ANALYSIS_TRIGGER, app.state.now, { Origin: "https://yanxiao.me" })).http, 401);
  assert.equal((await app.timer(AUTO_ANALYSIS_TRIGGER, app.state.now + 6000)).data.error.code, "INVALID_AUTO_ANALYSIS_TIMER");
  assert.equal((await app.invoke(NOW - period)).status, "stale");
  assert.deepEqual(app.marketCalls, []);
  assert.equal(app.objects.size, 0);
});

test("unset and zero daily limit disable the timer without pulling market data", async t => {
  for (const [limit, status] of [[undefined, "disabled"], ["0", "disabled"], ["bad", "failed"]]) {
    const app = await testServer(t, limit);
    assert.equal((await app.invoke()).status, status);
    assert.deepEqual(app.marketCalls, []);
  }
});

test("the timer uses fresh REST 5m volume evidence alongside the 4h/1h/15m structure", async t => {
  const close = NOW + period;
  const app = await testServer(t, "1", { now: close + 5000, delayClose: true });
  const result = await app.invoke();
  assert.equal(result.status, "completed", JSON.stringify({ result, logs: app.logs }));
  const saved = app.saved(result.analysisId);
  assert.equal(saved.status, "candidate");
  assert.equal(saved.market.source, "rest");
  assert.equal(saved.decisionSource, "deterministic");
  assert.equal(saved.m1Trigger.triggered, true);
  assert.equal(saved.m2Order.direction, "long");
  assert.deepEqual(saved.automaticAnalysis, { triggeredAt: app.state.now, candleClosedAt: close, candleInterval: "5m" });
  assert.equal(saved.market.triggerFrame.lastCloseTime, close - 1);
  assert.equal(saved.market.frames.find(frame => frame.interval === "15m").lastCloseTime, NOW - 1);
  assert.equal(saved.m1Trigger.keyFeatures.triggerInterval, "5m");
  assert.equal(saved.m2Order.keyFeatures.atr15m, saved.market.frames.find(frame => frame.interval === "15m").atr14);
  assert.equal(saved.opportunity.evidence[0].metric, "5m.volumePrice");
  assert.deepEqual(saved.model, { name: "m1-m2", promptVersion: "deterministic-m1-m2-v2-5m", inputTokens: null, outputTokens: null });
  const decision = app.decision(result.analysisId);
  assert.equal(decision.schemaVersion, 1);
  assert.equal(decision.recordType, "decision");
  assert.equal(decision.requestId, result.requestId);
  assert.equal(decision.scanId, result.requestId);
  assert.equal(decision.deterministicVersion, saved.model.promptVersion);
  assert.deepEqual(decision.m1, saved.m1Trigger);
  assert.deepEqual(decision.m2, saved.m2Order);
  assert.equal(decision.snapshot.triggerCandles.length, 200);
  assert.equal(decision.snapshot.triggerCandles.at(-1).closeTime, close - 1);
  assert.equal(app.outcome(result.analysisId).reason, "auto_execution_disabled");
  assert.deepEqual(app.marketCalls.filter(call => call.interval).map(call => call.interval).sort(), ["15m", "1h", "4h", "5m", "5m"]);
  assert.ok(saved.market.chart.every(frame => frame.candles.length === 200));
  assert.equal([...app.objects.keys()].filter(key => key.includes("/review-queue/")).length, 3);
  assert.ok([...app.objects.keys()].every(key => !key.startsWith(legacy)));
  assert.deepEqual(app.submissions, []);
});

test("M1 runs on each close, no-signal slots do not use quota, and a failed M2 stays a watch", async t => {
  const app = await testServer(t, "1", { now: NOW + 5000, noTrigger: true });
  const idle = await app.invoke();
  assert.equal(idle.status, "no_trigger");
  assert.equal(idle.m1Trigger.triggered, false);
  assert.equal((await app.invoke()).status, "duplicate");
  assert.equal([...app.objects.keys()].filter(archiveRecord).length, 0);
  const misses = [...app.objects.entries()].filter(([key]) => key.startsWith(`${tradeLogs}/decisions/`));
  assert.equal(misses.length, 1);
  assert.equal(JSON.parse(misses[0][1]).slot, "no_trigger");
  app.state.now += period;
  app.state.noTrigger = false;
  app.state.noOrder = true;
  const watch = await app.invoke();
  assert.equal(watch.status, "completed", JSON.stringify({ watch, logs: app.logs }));
  assert.equal(app.saved(watch.analysisId).status, "watch");
  assert.equal(app.saved(watch.analysisId).m2Order, null);
  const reason = app.saved(watch.analysisId).decision.reasons[0];
  assert.equal(reason.code, "m2_no_order");
  assert.match(reason.message, /^M2 未生成方案。.+/);
  assert.equal((await app.post("/scans", { version: 4 }, app.ticket())).data.records[0].decisionReason, reason.message);
  app.state.now += period;
  app.state.noOrder = false;
  const capped = await app.invoke();
  assert.equal(capped.status, "daily_limit");
  assert.equal(capped.m1Trigger.triggered, true);
  app.state.now += period;
  app.state.noTrigger = true;
  assert.equal((await app.invoke()).status, "no_trigger");
  assert.equal([...app.objects.keys()].filter(key => key.startsWith(storage)).length, 1);
});

test("a slot claim is atomic across instances and the limit resets at Beijing midnight", async t => {
  const objects = new Map();
  const first = await testServer(t, "1", { now: NOW + 5000 }, objects);
  const second = await testServer(t, "1", { now: NOW + 5000 }, objects);
  const results = await Promise.all([first.invoke(), second.invoke()]);
  assert.deepEqual(results.map(result => result.status).sort(), ["completed", "duplicate"]);
  assert.equal([...objects.keys()].filter(archiveRecord).length, 1);
  first.state.now = Date.UTC(2026, 10, 18, 16, 0, 5);
  assert.equal((await first.invoke()).status, "completed");
  assert.equal([...objects.keys()].filter(key => key.startsWith(storage)).length, 2);
  assert.equal([...objects.keys()].filter(archiveRecord).length, 2);
});

test("corrupt ledger fails closed without appending", async () => {
  const store = { readJsonLines: async () => [{ closedAt: NOW, status: "unknown" }],
    appendJsonLineAt: async () => assert.fail("corrupt ledger was appended") };
  await assert.rejects(reserveAutoAnalysisSlot(store, NOW, 1, true), { code: "AUTO_ANALYSIS_QUOTA_UNCONFIRMED" });
});

test("a validated M2 candidate reaches protected IOC with the same market endpoint", async t => {
  const app = await testServer(t, "2", { now: NOW + 5000, autoOrder: true, execution: true });
  await app.recover();
  const result = await app.invoke();
  assert.equal(result.status, "completed");
  assert.equal(result.order.status, "accepted");
  assert.equal(result.order.protection, "active");
  assert.ok(app.marketCalls.every(call => call.host === demoHost));
  const order = app.saved(result.analysisId).m2Order;
  assert.equal(app.submissions[0].timeInForce, "IOC");
  assert.deepEqual(app.submissions.slice(1).map(item => [item.type, Number(item.triggerPrice)]),
    [["STOP_MARKET", order.stopLoss], ["TAKE_PROFIT_MARKET", order.takeProfits[0].price]]);
  assert.equal((await app.invoke()).status, "duplicate");
  assert.equal(app.submissions.length, 3);
});

test("trade results join IOC submission to a reconciled protective fill", async t => {
  const app = await testServer(t, "1", { now: NOW + 5000, autoOrder: true, execution: true });
  await app.recover();
  const { analysisId, order } = await app.invoke();
  const submission = app.outcome(analysisId, "submission");
  assert.equal(submission.finalStatus, null);
  assert.equal(submission.execution.clientId, order.clientId);
  assert.equal(submission.execution.mode, "demo");
  assert.equal(submission.execution.submission.timeInForce, "IOC");
  const target = [...app.protection.values()].find(leg => leg.orderType === "TAKE_PROFIT_MARKET");
  Object.assign(target, { algoStatus: "FINISHED", actualOrderId: "62" });
  app.state.closed = app.state.now + 30000;
  app.state.now += 60000;
  assert.equal((await app.recover()).data.protection.state, "closed");
  const terminal = app.outcome(analysisId, "terminal");
  assert.equal(terminal.schemaVersion, 1);
  assert.equal(terminal.analysisId, analysisId);
  assert.equal(terminal.finalStatus, "win");
  assert.equal(terminal.grossRealizedPnlUsdt, 0.15);
  assert.equal(terminal.exitPrice, 10150.1);
  assert.equal(terminal.exitTime, app.state.closed);
  assert.equal(terminal.holdingDurationMs, 30000);
  assert.equal(terminal.exits[0].orderId, "62");
  assert.ok(terminal.rMultiple > 0);
});

test("zero-fill IOC is expired and trade log outages do not block execution", async t => {
  const app = await testServer(t, "2", { now: NOW + 5000, autoOrder: true, execution: true,
    entryStatus: "EXPIRED", entryQty: "0" });
  await app.recover();
  const expired = await app.invoke();
  assert.equal(app.outcome(expired.analysisId, "terminal").finalStatus, "expired");
  const report = (await app.execution(expired)).data.execution;
  assert.equal(report.state, "unfilled");
  assert.equal(report.exchangeStatus, "EXPIRED");
  assert.equal(report.executedQty, "0");
  assert.equal((await app.execution(expired, scanId)).http, 404);
  assert.equal((await app.execution(expired, expired.requestId, "trading:orders:read")).http, 401);
  app.state.now += period;
  app.state.rejectTradeLogs = true;
  app.state.entryStatus = "FILLED";
  app.state.entryQty = "0.001";
  await app.recover();
  const filled = await app.invoke();
  assert.equal(filled.order.protection, "active");
  assert.equal(app.logs.filter(log => log.event === "trade_result_log_failed").length, 2);
});

test("protected execution still enforces recovery, price risk and both order switches", async t => {
  for (const [state, code] of [
    [{ execution: false }, "ORDER_EXECUTION_DISABLED"],
    [{ noHeartbeat: true }, "ORDER_RECOVERY_NOT_READY"],
    [{ maxRisk: "0.01" }, "ORDER_RULE_CHANGED"],
  ]) {
    const app = await testServer(t, "1", { now: NOW + 5000, autoOrder: true, execution: true, ...state });
    if (!state.noHeartbeat) await app.recover();
    const result = await app.invoke();
    assert.equal(result.status, "completed");
    assert.equal(result.order.code, code);
    assert.equal(app.outcome(result.analysisId).finalStatus, "not_executed");
    const report = (await app.execution(result)).data.execution;
    assert.equal(report.state, "blocked");
    assert.equal(report.reasonCode, code);
    if (code === "ORDER_RULE_CHANGED") assert.match(report.message, /超过配置上限 0\.01 USDT/);
    assert.deepEqual(app.submissions, []);
  }
});

test("quota and archive write failures prevent automatic submission", async t => {
  for (const [state, stage] of [[{ rejectQuota: true }, "quota"], [{ rejectArchive: true }, "archive"]]) {
    const app = await testServer(t, "1", { now: NOW + 5000, autoOrder: true, execution: true, ...state });
    await app.recover();
    const result = await app.invoke();
    assert.equal(result.status, "failed");
    assert.equal(result.stage, stage);
    assert.deepEqual(app.submissions, []);
  }
});

test("legacy scan rows and linked analyses remain readable to the existing owner API", async t => {
  const app = await testServer(t, "1");
  const legacyRecord = { schemaVersion: 4, analysisId: legacyAnalysisId, requestId: scanId, market: { chart: [] } };
  const hour = Math.floor(NOW / 3600000) * 3600000;
  const pending = { id: scanId, time: NOW, status: "passed", autoAnalysis: { status: "pending" } };
  const outcome = { status: "completed", analysisId: legacyAnalysisId };
  app.objects.set(`${legacy}/runs/${hour}.ndjson`,
    [pending, ...Array.from({ length: 16 }, (_, i) => ({ ...pending, id: `run-${String(i).padStart(2, "0")}`,
      time: NOW - 1000, status: "none", autoAnalysis: undefined }))].map(row => JSON.stringify(row)).join("\n") + "\n");
  app.objects.set(`${legacy}/${NOW}.json`, JSON.stringify({ symbol: "BTCUSDT", slot: NOW, status: "none" }));
  app.objects.set(`${legacy}/auto-analysis/outcomes/${scanId}.json`, JSON.stringify(outcome));
  app.objects.set(`${archive}/records/${legacyAnalysisId}.json`, JSON.stringify({ ...legacyRecord, orderPermit: "private-permit" }));
  const first = (await app.post("/scans", { version: 2 }, app.ticket())).data;
  assert.equal(first.records.length, 16);
  assert.equal(first.records[0].scannedAt, null);
  assert.deepEqual(first.records[1].autoAnalysis, outcome);
  const next = (await app.post("/scans", { version: 2, before: first.next }, app.ticket())).data;
  assert.deepEqual(next.records.map(row => row.id), ["run-01", "run-00"]);
  const query = { action: "analysis", scanId, analysisId: legacyAnalysisId };
  assert.equal((await app.post("/scans", query, app.ticket("trading:orders:read"))).http, 401);
  assert.deepEqual((await app.post("/scans", query, app.ticket())).data.result, legacyRecord);
  assert.equal((await app.post("/scans", { ...query, analysisId: scanId }, app.ticket())).http, 404);
  assert.deepEqual(app.marketCalls, []);
});

test("scan history v4 includes 5m runs and pre-upgrade slots while v3 preserves its 15m contract", async t => {
  const app = await testServer(t, "1", { now: NOW + period + 5000 });
  const oldSlot = NOW - INTERVAL_MS["15m"];
  app.objects.set(`${storage}/2026-11-18.ndjson`, JSON.stringify({ closedAt: oldSlot, status: "no_trigger" }) + "\n");
  const recent = await app.invoke();
  assert.equal(recent.status, "completed");
  const hour = Math.floor(NOW / 3600000) * 3600000;
  const oldScan = { id: scanId, time: NOW + 1000, status: "error" };
  app.objects.set(`${legacy}/runs/${hour}.ndjson`, JSON.stringify(oldScan) + "\n");
  const v2 = (await app.post("/scans", { version: 2 }, app.ticket())).data;
  assert.deepEqual(v2.records, [oldScan]);
  const v3 = (await app.post("/scans", { version: 3 }, app.ticket())).data;
  assert.deepEqual(v3.records.map(row => row.candleClosedAt ?? null), [null, oldSlot]);
  assert.equal(v3.records[1].candleInterval, undefined);
  const query = () => app.post("/scans", { version: 4 }, app.ticket());
  const { http, data } = await query();
  assert.equal(http, 200);
  const [current, old, preUpgrade] = data.records;
  assert.equal(current.kind, "deterministic");
  assert.equal(current.candleInterval, "5m");
  assert.equal(current.candleClosedAt, NOW + period);
  assert.equal(current.status, "triggered");
  assert.equal(current.m1.score, 100);
  assert.equal(current.opportunityStatus, "candidate");
  assert.equal(current.analysisId, recent.analysisId);
  assert.deepEqual(old, oldScan);
  assert.deepEqual(preUpgrade, { kind: "deterministic", symbol: "BTCUSDT", id: `m1-slot-${oldSlot}`,
    time: oldSlot, scannedAt: null, candleClosedAt: oldSlot, candleInterval: "15m", status: "no_trigger" });
  const lookup = { action: "analysis", scanId: current.id, analysisId: current.analysisId };
  assert.equal((await app.post("/scans", lookup, app.ticket())).data.result.analysisId, current.analysisId);
  assert.equal((await app.post("/scans", { ...lookup, scanId }, app.ticket())).http, 404);
  app.objects.delete(`${archive}/records/${current.analysisId}.json`);
  assert.equal((await query()).data.records[0].analysisId, undefined);
});

test("upgrading within the same day preserves the old 15m slot claim and quota", async t => {
  const app = await testServer(t, "1");
  app.objects.set(`${storage}/2026-11-18.ndjson`, JSON.stringify({ closedAt: NOW, status: "reserved" }) + "\n");
  assert.equal((await app.invoke()).status, "duplicate");
  app.state.now += period;
  assert.equal((await app.invoke()).status, "daily_limit");
});
