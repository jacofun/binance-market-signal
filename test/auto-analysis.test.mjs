import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { AUTO_ANALYSIS_TRIGGER, reserveAutoAnalysisSlot } from "../build/auto-analysis.js";
import { INTERVAL_MS } from "../build/market.js";
import { makeServer } from "../build/server.js";
import { jwt, klines, NOW } from "./fixtures.mjs";

const period = INTERVAL_MS["15m"];
const storage = "/private/market-signal-auto-analysis/v1/BTCUSDT/slots";
const legacy = "/private/market-signal-scanner/v1/BTCUSDT";
const archive = "/private/.trading/owner/market-signals";
const demoHost = "demo-fapi.binance.com";
const scanId = "f33b92e5-7ade-471a-b3c4-d638b5e1b542";
const legacyAnalysisId = "e547a3bc-f391-422e-a5e4-45082bff7f83";

function candles(interval, at, state) {
  return klines(INTERVAL_MS[interval], at).map((row, i) => {
    const close = 10000 + (i - 199) * 0.5;
    const high = interval === "1h" && i === 185 && !state.noOrder ? 10140 : close + 39;
    const low = interval === "1h" && i === 195 ? 9995 : close - 1;
    const volume = interval === "15m" && i === 199 && !state.noTrigger ? 20 : 10;
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
  let reads15m = 0;
  const analysisFetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname.endsWith("aliyuncs.com") && url.hostname.startsWith("auto-analysis-test.")) {
      const current = objects.get(url.pathname);
      const ossHeaders = { "x-oss-request-id": "mock-oss-id" };
      if (state.rejectQuota && url.pathname.startsWith(storage)) return new Response(null, { status: 503, headers: ossHeaders });
      if (state.rejectArchive && url.pathname.includes("/review-queue/")) return new Response(null, { status: 403, headers: ossHeaders });
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
    if (interval === "15m" && ++reads15m === 1 && state.delayClose) rows.splice(199, 1);
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
    if (url.pathname.endsWith("/positionRisk")) return Response.json([...orders.values()].filter(order => Number(order.executedQty) > 0)
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
        positionSide: params.positionSide, side: params.side, executedQty: state.entryQty ?? "0.001", avgPrice: "10000.1" };
      orders.set(params.newClientOrderId, entry);
      return state.unknownEntry ? Response.json({ code: -1007 }, { status: 503 }) : Response.json(entry);
    }
    const row = algo ? protection.get(url.searchParams.get("clientAlgoId")) : orders.get(url.searchParams.get("origClientOrderId"));
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
  return { state, objects, marketCalls, submissions, logs, post, timer, invoke, ticket,
    recover: () => timer("market-order-protection"),
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

test("the timer pulls only REST 4h/1h/15m candles and archives a deterministic M2 candidate", async t => {
  const app = await testServer(t, "1", { now: NOW + 5000, delayClose: true });
  const result = await app.invoke();
  assert.equal(result.status, "completed", JSON.stringify({ result, logs: app.logs }));
  const saved = app.saved(result.analysisId);
  assert.equal(saved.status, "candidate");
  assert.equal(saved.market.source, "rest");
  assert.equal(saved.decisionSource, "deterministic");
  assert.equal(saved.m1Trigger.triggered, true);
  assert.equal(saved.m2Order.direction, "long");
  assert.deepEqual(saved.automaticAnalysis, { triggeredAt: app.state.now, candleClosedAt: NOW });
  assert.deepEqual(saved.model, { name: "m1-m2", promptVersion: "deterministic-m1-m2-v1", inputTokens: null, outputTokens: null });
  assert.deepEqual(app.marketCalls.filter(call => call.interval).map(call => call.interval).sort(), ["15m", "15m", "1h", "4h"]);
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
  assert.equal([...app.objects.keys()].filter(key => key.startsWith(archive)).length, 0);
  app.state.now += period;
  app.state.noTrigger = false;
  app.state.noOrder = true;
  const watch = await app.invoke();
  assert.equal(watch.status, "completed", JSON.stringify({ watch, logs: app.logs }));
  assert.equal(app.saved(watch.analysisId).status, "watch");
  assert.equal(app.saved(watch.analysisId).m2Order, null);
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
  assert.equal([...objects.keys()].filter(key => key.startsWith(archive + "/records/")).length, 1);
  first.state.now = Date.UTC(2026, 10, 18, 16, 0, 5);
  assert.equal((await first.invoke()).status, "completed");
  assert.equal([...objects.keys()].filter(key => key.startsWith(storage)).length, 2);
  assert.equal([...objects.keys()].filter(key => key.startsWith(archive + "/records/")).length, 2);
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

test("scan history v3 includes REST M1 runs, pre-upgrade slots and linked archives", async t => {
  const app = await testServer(t, "1");
  const oldSlot = NOW - period;
  app.objects.set(`${storage}/2026-11-18.ndjson`, JSON.stringify({ closedAt: oldSlot, status: "no_trigger" }) + "\n");
  const recent = await app.invoke();
  assert.equal(recent.status, "completed");
  const hour = Math.floor(NOW / 3600000) * 3600000;
  const oldScan = { id: scanId, time: NOW + 1000, status: "error" };
  app.objects.set(`${legacy}/runs/${hour}.ndjson`, JSON.stringify(oldScan) + "\n");
  const v2 = (await app.post("/scans", { version: 2 }, app.ticket())).data;
  assert.deepEqual(v2.records, [oldScan]);
  const query = () => app.post("/scans", { version: 3 }, app.ticket());
  const { http, data } = await query();
  assert.equal(http, 200);
  const [current, old, preUpgrade] = data.records;
  assert.equal(current.kind, "deterministic");
  assert.equal(current.status, "triggered");
  assert.equal(current.m1.score, 100);
  assert.equal(current.opportunityStatus, "candidate");
  assert.equal(current.analysisId, recent.analysisId);
  assert.deepEqual(old, oldScan);
  assert.deepEqual(preUpgrade, { kind: "deterministic", symbol: "BTCUSDT", id: `m1-slot-${oldSlot}`,
    time: oldSlot, scannedAt: null, candleClosedAt: oldSlot, status: "no_trigger" });
  const lookup = { action: "analysis", scanId: current.id, analysisId: current.analysisId };
  assert.equal((await app.post("/scans", lookup, app.ticket())).data.result.analysisId, current.analysisId);
  assert.equal((await app.post("/scans", { ...lookup, scanId }, app.ticket())).http, 404);
  app.objects.delete(`${archive}/records/${current.analysisId}.json`);
  assert.equal((await query()).data.records[0].analysisId, undefined);
});
