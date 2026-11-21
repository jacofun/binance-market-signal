import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { autoAnalysisLimit, reserveAutoAnalysisQuota } from "../build/auto-analysis.js";
import { INTERVAL_MS, parseCandles } from "../build/market.js";
import { makeServer } from "../build/server.js";
import { env, jwt, klines, marketFetch, NOW, proposal, provider, quote, snapshot } from "./fixtures.mjs";

const period = INTERVAL_MS["15m"];
const storage = "/private/market-signal-scanner/v1/BTCUSDT/auto-analysis";
const archive = "/private/.trading/owner/market-signals";
const noSetup = proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [] });
const upstreamId = "f33b92e5-7ade-471a-b3c4-d638b5e1b542";
const demoHost = "demo-fapi.binance.com";

function scannerCandles(frame, at) {
  const rows = klines(INTERVAL_MS[frame], at, frame === "1m" ? 212 : 201);
  if (frame === "1h") {
    rows[170][2] = "12000";
    rows[180][2] = "10200";
  } else if (frame === "15m") {
    rows[199][2] = "10300";
    rows[199][4] = "10280";
    rows[199][5] = "30";
  } else if (frame === "4h") {
    rows.forEach((row, i) => {
      const close = 9700 + 2 * i;
      [row[1], row[2], row[3], row[4]] = [close, close + 4, close - 4, close].map(String);
    });
  }
  return rows;
}

async function testServer(t, limit, state = { now: NOW + 5000 }, objects = new Map()) {
  const requests = [];
  const logs = [];
  const marketHosts = new Set();
  const submissions = [];
  const orders = new Map();
  const protection = new Map();
  let reads15m = 0;
  const scannerFetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname.endsWith("aliyuncs.com") && url.hostname.startsWith("auto-analysis-test.")) {
      const current = objects.get(url.pathname);
      const ossHeaders = { "x-oss-request-id": "mock-oss-id" };
      if (state.rejectQuota && url.pathname.includes("/quota/")) return new Response(null, { status: 503, headers: ossHeaders });
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
    if (url.hostname === "dashscope.aliyuncs.com") {
      requests.push(JSON.parse(options.body));
      if (state.modelTimeout) throw new Error("simulated transport failure");
      state.now += state.modelElapsed ?? 0;
      return Response.json({ request_id: upstreamId, usage: { prompt_tokens: 123, completion_tokens: 54 },
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(state.invalidModel ? {} : state.proposal ?? noSetup) } }] });
    }
    marketHosts.add(url.hostname);
    assert.equal(url.hostname, state.autoOrder && state.execution ? demoHost : "fapi.binance.com");
    if (url.pathname.endsWith("/time")) return Response.json({ serverTime: state.now });
    if (!url.pathname.endsWith("/klines")) return marketFetch(input);
    const timeframe = url.searchParams.get("interval");
    const candles = scannerCandles(timeframe, Number(url.searchParams.get("endTime")));
    if (timeframe === "1m" && state.movementPct) {
      const close = 10010 * (1 + state.movementPct / 100);
      const latestClosed = candles.at(-2);
      latestClosed[4] = String(close);
      latestClosed[2] = String(Math.max(10100, close));
      latestClosed[3] = String(Math.min(9900, close));
    }
    if (timeframe === "15m") {
      if (state.lowVolumeBreakout) candles[199][5] = "10";
      if (++reads15m === 2 && state.delayAnalysisClose) return Response.json(candles.slice(0, -2));
    }
    return Response.json(candles);
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
      return scannerFetch(input, options);
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
    if (url.pathname.endsWith("/premiumIndex")) return Response.json({ symbol: "BTCUSDT", markPrice: "10000", time: state.now });
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
  const market = provider({
    snapshot: async () => {
      if (state.invalidMarket) throw Error("simulated unavailable market");
      const current = snapshot();
      current.asOf = state.now;
      current.quote.time = state.now;
      if (state.proposal?.direction === "short") current.frames[1].zones.push({
        ...current.frames[1].zones[0], id: "short-entry", kind: "resistance", lower: 9980, upper: 10020,
      });
      for (const frame of current.frames) frame.recentCandles =
        parseCandles(klines(INTERVAL_MS[frame.interval], state.now), frame.interval, state.now);
      current.frames[2].lastCloseTime = Math.floor(state.now / period) * period - 1 + (state.stale ? period : 0);
      return current;
    },
    quote: async () => quote({ time: state.now, price: state.finalMark ?? 10000 }),
  });
  const runtime = makeServer({
    env: { ...env, DASHSCOPE_MODEL: "kimi-k3.1-pro", OSS_BUCKET: "auto-analysis-test", OSS_REGION: "cn-hangzhou",
      ACCESS_KEY_ID: "test-oss-id", ACCESS_KEY_SECRET: "test-oss-secret-key", SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT: limit,
      SIGNAL_AUTO_ORDER_EXECUTE: state.autoOrder ? "true" : undefined,
      SIGNAL_MAX_ANALYSIS_AGE_MS: state.modelElapsed ? "100000" : undefined,
      SIGNAL_ORDER_EXECUTE: state.execution ? "true" : undefined, SIGNAL_ORDER_MODE: "demo", BINANCE_BASE_URL: `https://${demoHost}`,
      BINANCE_API_KEY: "test-binance-apikey", BINANCE_API_SECRET: "test-binance-secret" },
    now: () => state.now, provider: state.realMarket ? undefined : market, scannerFetch, orderFetch,
    logger: { info: line => logs.push(JSON.parse(line)), error: line => logs.push(JSON.parse(line)) },
  });
  runtime.listen(0, "127.0.0.1");
  await once(runtime, "listening");
  t.after(() => { runtime.closeAllConnections(); runtime.close(); });
  async function post(path, body, headers) {
    const response = await fetch(`http://127.0.0.1:${runtime.address().port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  return {
    requests, objects, logs, state, marketHosts, submissions,
    invoke: () => post("/invoke", { triggerName: "binance-market-scanner", triggerTime: new Date(state.now).toISOString() },
      { "x-fc-control-path": "/invoke", "x-fc-request-id": "test-trigger" }),
    list: () => post("/scans", { version: 2 }, { "X-JWT-Token": jwt() }),
    recover: () => post("/invoke", { triggerName: "market-order-protection", triggerTime: new Date(state.now).toISOString() },
      { "x-fc-control-path": "/invoke", "x-fc-request-id": "test-trigger" }),
    lookup: analysisId => post("/orders", { action: "status", analysisId },
      { "X-JWT-Token": jwt({ scope: "trading:orders:read", iat: Math.floor(state.now / 1000), exp: Math.floor(state.now / 1000) + 120 }) }),
  };
}

test("automatic quota has no default and rejects invalid values", async t => {
  assert.equal(autoAnalysisLimit({}), undefined);
  assert.equal(autoAnalysisLimit({ SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT: "0" }), 0);
  assert.equal(autoAnalysisLimit({ SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT: "7" }), 7);
  assert.throws(() => autoAnalysisLimit({ SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT: "-1" }), { code: "AUTO_ANALYSIS_CONFIGURATION" });
  for (const limit of [undefined, "0", "garbage"]) {
    const app = await testServer(t, limit);
    const result = await app.invoke();
    assert.equal(result.status, "passed");
    assert.equal(result.autoAnalysis.status, limit === "garbage" ? "failed" : "disabled");
    assert.equal(app.requests.length, 0);
  }
});

test("a qualified timer sends one protected IOC, archives the decision and supports owner lookup", async t => {
  const app = await testServer(t, "3", { now: NOW + 5000, autoOrder: true, execution: true, proposal: proposal(),
    entryStatus: "EXPIRED", entryQty: "0.0005" });
  await app.recover();
  const { autoAnalysis } = await app.invoke();
  assert.equal(autoAnalysis.status, "completed", JSON.stringify(autoAnalysis));
  assert.deepEqual(autoAnalysis.order, { status: "accepted", clientId: app.submissions[0].newClientOrderId,
    protection: "active", exchangeStatus: "EXPIRED", executedQty: "0.0005" });
  assert.deepEqual([...app.marketHosts], [demoHost]);
  assert.match(app.requests[0].messages[0].content, /本次候选会进入即时下单复核/);
  assert.match(app.requests[0].messages[0].content, /如果某个尚未发生的条件是交易成立的必要前提，才为该条件等待/);
  assert.equal(app.submissions[0].timeInForce, "IOC");
  assert.equal(app.submissions[0].newOrderRespType, "RESULT");
  assert.equal(app.submissions[0].price, "10000.1");
  assert.equal(app.submissions[0].quantity, "0.001");
  assert.deepEqual(app.submissions.slice(1).map(order => [order.type, order.triggerPrice, order.closePosition]),
    [["STOP_MARKET", "9900", "true"], ["TAKE_PROFIT_MARKET", "10200", "true"]]);
  assert.equal((await app.lookup(autoAnalysis.analysisId)).protection.state, "active");
  assert.equal((await app.list()).records[0].autoAnalysis.order.clientId, autoAnalysis.order.clientId);
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  assert.equal(app.requests.length, 1);
  assert.equal(app.submissions.length, 3);
});

test("auto ordering is gated by the two switches, market eligibility, heartbeat and deadline", async t => {
  const short = proposal({ direction: "short", stopLoss: 10100, targets: [{ price: 9700, reason: "支撑", zoneId: "down" }] });
  short.research.entryZoneId = "short-entry";
  for (const [override, expected, status = "completed"] of [
    [{ autoOrder: false }, undefined],
    [{ execution: false }, "ORDER_EXECUTION_DISABLED"],
    [{ proposal: noSetup }, "AUTO_ORDER_NOT_CANDIDATE"],
    [{ proposal: proposal({ entry: { min: 9979.9, max: 10010 } }) }, "AUTO_ORDER_NOT_CANDIDATE"],
    [{ finalMark: 10020 }, "AUTO_ORDER_NOT_CANDIDATE"],
    [{ proposal: short }, "AUTO_ORDER_SCAN_DIRECTION_MISMATCH"],
    [{ noHeartbeat: true }, "ORDER_RECOVERY_NOT_READY"],
    [{ askPrice: "10020.1" }, "ORDER_RULE_CHANGED"],
    [{ proposal: proposal({ stopLoss: 8900 }) }, "ORDER_RULE_CHANGED"],
    [{ modelElapsed: 94000 }, "AUTO_ORDER_DEADLINE"],
    [{ rejectArchive: true }, undefined, "failed"],
    [{ invalidModel: true }, undefined, "failed"],
  ]) {
    const state = { now: NOW + 5000, autoOrder: true, execution: true, proposal: proposal(), ...override };
    const app = await testServer(t, "1", state);
    if (!state.noHeartbeat) await app.recover();
    const { autoAnalysis } = await app.invoke();
    assert.equal(autoAnalysis.status, status, JSON.stringify({ override, autoAnalysis }));
    assert.equal(autoAnalysis.order?.code, expected, JSON.stringify({ override, autoAnalysis }));
    assert.equal(app.submissions.length, 0);
    if (override.proposal?.entry?.min === 9979.9) {
      const saved = JSON.parse(app.objects.get(`${archive}/records/${autoAnalysis.analysisId}.json`));
      assert.equal(saved.decision.reasons[0].code, "entry_out_of_bounds");
      assert.equal(saved.opportunity.entry, null);
    }
  }
});

test("an IOC without a fill exits without protection and an ambiguous response recovers without resubmitting", async t => {
  const state = { now: NOW + 5000, autoOrder: true, execution: true, proposal: proposal(), entryStatus: "EXPIRED", entryQty: "0" };
  const unfilled = await testServer(t, "1", state);
  await unfilled.recover();
  assert.equal((await unfilled.invoke()).autoAnalysis.order.protection, "not_required");
  assert.equal(unfilled.submissions.length, 1);
  assert.ok(![...unfilled.objects.keys()].some(path => path.endsWith("/locks/btcusdt.json")));

  const ambiguous = await testServer(t, "2", { ...state, entryStatus: "FILLED", entryQty: "0.001", unknownEntry: true });
  await ambiguous.recover();
  const { autoAnalysis } = await ambiguous.invoke();
  assert.equal(autoAnalysis.order.status, "unknown");
  assert.equal(ambiguous.submissions.length, 1);
  ambiguous.state.now = NOW + 60000;
  const recovered = await ambiguous.recover();
  assert.equal(recovered.protection.state, "active");
  assert.equal(recovered.clientId, autoAnalysis.order.clientId);
  assert.equal((await ambiguous.invoke()).autoAnalysis.status, "duplicate");
  assert.deepEqual(ambiguous.submissions.map(order => order.type), ["LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]);
});

test("demo REST analysis retries a delayed response and gives Kimi the same close as the scanner", async t => {
  const app = await testServer(t, "1", { now: NOW + 5000, autoOrder: true, execution: true, realMarket: true, delayAnalysisClose: true });
  const result = await app.invoke();
  assert.equal(result.autoAnalysis.status, "completed", JSON.stringify(result));
  assert.equal(result.autoAnalysis.order.code, "AUTO_ORDER_NOT_CANDIDATE");
  assert.deepEqual([...app.marketHosts], [demoHost]);
  const { snapshot, scanEvidence } = JSON.parse(app.requests[0].messages[1].content);
  const short = snapshot.frames.find(frame => frame.interval === "15m");
  assert.equal(snapshot.source, "rest");
  assert.equal(short.latestClosedAt, scanEvidence.candleClosedAt);
  assert.equal(short.recentCandles.at(-1)[0], scanEvidence.candleClosedAt - period);
  assert.equal(short.recentCandles.at(-1)[4], scanEvidence.close);
});

test("qualified timer sends the actual checks once and archives the independent decision for the review worker", async t => {
  const app = await testServer(t, "1");
  const run = await app.invoke();
  assert.equal(run.status, "passed");
  assert.equal(run.autoAnalysis?.status, "completed", JSON.stringify(run));
  assert.equal(app.requests.length, 1);
  const [request] = app.requests;
  assert.equal(request.model, "kimi-k3.1-pro");
  assert.match(request.messages[0].content, /专业交易员视角独立决策/);
  assert.match(request.messages[0].content, /最大合理盈利空间/);
  assert.match(request.messages[0].content, /顺大周期、逆小周期/);
  assert.match(request.messages[0].content, /invalidationConditions 区分【未入场失效】和【持仓提前退出】/);
  assert.match(request.messages[0].content, /selectablePriceRange/);
  const { style, scanEvidence } = JSON.parse(request.messages[1].content);
  assert.equal(style, "trend");
  assert.equal(scanEvidence.candleClosedAt, NOW);
  assert.equal(scanEvidence.scanId, run.requestId);
  assert.equal(scanEvidence.rules[0].status, "passed");
  assert.equal(scanEvidence.rules[0].checks.find(check => check.code === "rvol20").value, 3);
  assert.equal(scanEvidence.rules[1].status, "none");
  const { analysisId } = run.autoAnalysis;
  const saved = JSON.parse(app.objects.get(`${archive}/records/${analysisId}.json`));
  assert.equal(saved.status, "none");
  assert.equal(saved.decision.modelStatus, "none");
  assert.equal(saved.decision.reasons[0].code, "model_none");
  const completed = app.logs.find(log => log.event === "market_auto_analysis_completed" && log.analysisId === analysisId);
  assert.equal(completed.modelStatus, "none");
  assert.deepEqual(completed.decisionReasons, ["model_none"]);
  assert.equal(completed.modelSummary, undefined);
  assert.equal(saved.model.promptVersion, "market-research-v4-volume-timing-v8-auto-scan-movement-v2");
  assert.equal(saved.orderPermit, undefined);
  assert.deepEqual(saved.scanEvidence, scanEvidence);
  assert.ok(saved.market.chart.every(frame => frame.candles.length === 200));
  assert.equal([...app.objects.keys()].filter(key => key.includes("/review-queue/")).length, 3);
  assert.equal(JSON.parse([...app.objects].find(([key]) => key.includes(`${archive}/index/`))[1]).source, "auto_scan");
  assert.equal((await app.list()).records[0].autoAnalysis.analysisId, analysisId);
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  app.state.now += period;
  assert.equal((await app.invoke()).autoAnalysis.status, "daily_limit");
  assert.equal(app.requests.length, 1);
});

test("quota is atomic across invocations and resets at the Beijing day boundary", async t => {
  let body = "1\n";
  const mockStore = { readJsonLines: async () => body.trim().split("\n").map(JSON.parse), appendJsonLineAt: async (_key, row, position) => {
    if (position !== Buffer.byteLength(body)) return Buffer.byteLength(body);
    body += JSON.stringify(row) + "\n";
    return null;
  } };
  const claim = { eventAt: NOW, direction: "short", severe: true };
  const concurrent = await Promise.all(Array.from({ length: 7 }, () => reserveAutoAnalysisQuota(mockStore, NOW, 3, claim)));
  assert.equal(concurrent.filter(x => x === "reserved").length, 1);
  assert.equal(concurrent.filter(x => x === "duplicate").length, 6);
  const app = await testServer(t, "1", { now: Date.UTC(2026, 10, 18, 15, 45) + 1000 });
  assert.equal((await app.invoke()).autoAnalysis.status, "completed");
  app.state.now += period;
  assert.equal((await app.invoke()).autoAnalysis.status, "episode");
  app.state.now += period;
  assert.equal((await app.invoke()).autoAnalysis.status, "completed");
  assert.equal(app.requests.length, 2);
  assert.equal(app.objects.get(`${storage}/quota/2026-11-18.ndjson`).trim().split("\n").length, 1);
  assert.equal(app.objects.get(`${storage}/quota/2026-11-19.ndjson`).trim().split("\n").length, 1);
});

test("separate FC instances cannot call twice for the same candle or exceed the shared daily quota", async t => {
  const objects = new Map();
  const first = await testServer(t, "1", { now: NOW + 1000 }, objects);
  const second = await testServer(t, "1", { now: NOW + 2000 }, objects);
  const same = await Promise.all([first.invoke(), second.invoke()]);
  assert.deepEqual(same.map(run => run.autoAnalysis.status).sort(), ["completed", "duplicate"]);
  second.state.now += period;
  assert.equal((await second.invoke()).autoAnalysis.status, "daily_limit");
  assert.equal(first.requests.length + second.requests.length, 1);
});

test("preflight failures do not spend a model call; sent timeouts and invalid outputs do and are not retried", async t => {
  const app = await testServer(t, "3");
  app.state.invalidMarket = true;
  assert.equal((await app.invoke()).autoAnalysis.stage, "market_snapshot");
  app.state.invalidMarket = false;
  app.state.stale = true;
  assert.equal((await app.invoke()).autoAnalysis.status, "stale");
  app.state.stale = false;
  app.state.modelTimeout = true;
  assert.equal((await app.invoke()).autoAnalysis.errorCode, "MODEL_TIMEOUT");
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  app.state.now += 2 * period;
  app.state.modelTimeout = false;
  app.state.invalidModel = true;
  assert.equal((await app.invoke()).autoAnalysis.errorCode, "INVALID_MODEL_OUTPUT");
  assert.ok(app.logs.some(log => log.event === "market_auto_analysis_failed" && log.upstreamRequestId === upstreamId && log.inputTokens === 123));
  app.state.now += period;
  assert.equal((await app.invoke()).autoAnalysis.status, "reserved_quota");
  assert.equal(app.requests.length, 2);
});

test("minute movement alone wakes Kimi, deduplicates an episode and leaves trading disabled for it", async t => {
  const app = await testServer(t, "3", { now: NOW + 185000, movementPct: -0.8, autoOrder: true, execution: true, proposal: proposal() });
  const first = await app.invoke();
  assert.equal(first.candleClosedAt, null);
  assert.equal(first.trigger.kind, "movement");
  assert.equal(first.trigger.direction, "short");
  assert.equal(first.trigger.severe, false, JSON.stringify(first));
  assert.equal(first.autoAnalysis.order.code, "AUTO_ORDER_RESEARCH_ONLY");
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  app.state.now += 60000;
  assert.equal((await app.invoke()).autoAnalysis.status, "episode");
  app.state.movementPct = -1.3;
  const escalation = await app.invoke();
  assert.equal(escalation.trigger.severe, true);
  assert.equal(escalation.autoAnalysis.status, "completed", JSON.stringify({ escalation, logs: app.logs }));
  assert.equal(app.requests.length, 2);
  const request = JSON.parse(app.requests[1].messages[1].content);
  assert.equal(request.scanEvidence.trigger.severe, true);
  assert.deepEqual(request.scanEvidence.rules, []);
  assert.equal(app.submissions.length, 0);
  assert.doesNotMatch(app.requests[1].messages[0].content, /本次候选会进入即时下单复核/);
});

test("ordinary alerts leave a slot for a later severe move", async t => {
  const app = await testServer(t, "2", { now: NOW + 185000, movementPct: -0.8 });
  const first = await app.invoke();
  assert.equal(first.trigger.severe, false, JSON.stringify(first));
  assert.equal(first.autoAnalysis.status, "completed");
  app.state.now += 30 * 60000;
  assert.equal((await app.invoke()).autoAnalysis.status, "reserved_quota");
  app.state.movementPct = -1.3;
  assert.equal((await app.invoke()).autoAnalysis.status, "completed");
  app.state.now += 30 * 60000;
  assert.equal((await app.invoke()).autoAnalysis.status, "daily_limit");
  assert.equal(app.requests.length, 2);
});

test("a low-volume crossing triggers research but fails the order gate", async t => {
  const app = await testServer(t, "3", { now: NOW + 5000, lowVolumeBreakout: true,
    autoOrder: true, execution: true, proposal: proposal() });
  const scan = await app.invoke();
  assert.equal(scan.trigger.kind, "structure");
  assert.equal(scan.autoAnalysis.order.code, "AUTO_ORDER_SCAN_DIRECTION_MISMATCH");
  assert.equal(app.requests.length, 1);
  const { scanEvidence } = JSON.parse(app.requests[0].messages[1].content);
  assert.equal(scanEvidence.rules[0].status, "filtered");
  assert.equal(app.submissions.length, 0);
});

test("a simultaneous movement and qualified breakout dispatch one research-only analysis", async t => {
  const app = await testServer(t, "3", { now: NOW + 5000, movementPct: 1.3,
    autoOrder: true, execution: true, proposal: proposal() });
  const scan = await app.invoke();
  assert.equal(scan.trigger.kind, "movement");
  assert.equal(scan.autoAnalysis.order.code, "AUTO_ORDER_RESEARCH_ONLY");
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  assert.equal(app.requests.length, 1);
  const { scanEvidence } = JSON.parse(app.requests[0].messages[1].content);
  assert.equal(scanEvidence.rules[0].status, "passed");
  assert.equal(app.submissions.length, 0);
});

test("quota storage errors fail closed and archive errors retain the recorded scan without causing another call", async t => {
  const app = await testServer(t, "3");
  app.state.rejectQuota = true;
  assert.equal((await app.invoke()).autoAnalysis.stage, "quota");
  assert.equal(app.requests.length, 0);
  app.state.now += period;
  app.state.rejectQuota = false;
  app.state.rejectArchive = true;
  assert.equal((await app.invoke()).autoAnalysis.stage, "archive");
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  assert.equal(app.requests.length, 1);
});
