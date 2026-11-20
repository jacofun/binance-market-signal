import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { autoAnalysisLimit, reserveAutoAnalysisQuota } from "../build/auto-analysis.js";
import { INTERVAL_MS, parseCandles } from "../build/market.js";
import { makeServer } from "../build/server.js";
import { env, jwt, klines, NOW, proposal, provider, quote, snapshot } from "./fixtures.mjs";

const period = INTERVAL_MS["15m"];
const storage = "/private/market-signal-scanner/v1/BTCUSDT/auto-analysis";
const archive = "/private/.trading/owner/market-signals";
const noSetup = proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [] });
const upstreamId = "f33b92e5-7ade-471a-b3c4-d638b5e1b542";

function scannerCandles(frame, at) {
  const rows = klines(INTERVAL_MS[frame], at);
  if (frame === "1h") {
    rows[170][2] = "12000";
    rows[180][2] = "10200";
  } else if (frame === "15m") {
    rows[199][2] = "10300";
    rows[199][4] = "10280";
    rows[199][5] = "30";
  } else {
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
        assert.equal(options.headers["x-oss-forbid-overwrite"], "true");
        if (current) return new Response(null, { status: 409 });
        objects.set(url.pathname, options.body);
        return new Response(null);
      }
      return current === undefined ? new Response(null, { status: 404, headers: ossHeaders }) : new Response(current);
    }
    if (url.hostname === "dashscope.aliyuncs.com") {
      requests.push(JSON.parse(options.body));
      if (state.modelTimeout) throw new Error("simulated transport failure");
      return Response.json({ request_id: upstreamId, usage: { prompt_tokens: 123, completion_tokens: 54 },
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(state.invalidModel ? {} : noSetup) } }] });
    }
    assert.equal(url.hostname, "fapi.binance.com");
    if (url.pathname.endsWith("/time")) return Response.json({ serverTime: state.now });
    const timeframe = url.searchParams.get("interval");
    return Response.json(scannerCandles(timeframe, Number(url.searchParams.get("endTime"))));
  };
  const market = provider({
    snapshot: async () => {
      if (state.invalidMarket) throw Error("simulated unavailable market");
      const current = snapshot();
      current.asOf = state.now;
      current.quote.time = state.now;
      for (const frame of current.frames) frame.recentCandles =
        parseCandles(klines(INTERVAL_MS[frame.interval], state.now), frame.interval, state.now);
      current.frames[2].lastCloseTime = Math.floor(state.now / period) * period - 1 + (state.stale ? period : 0);
      return current;
    },
    quote: async () => quote({ time: state.now }),
  });
  const runtime = makeServer({
    env: { ...env, DASHSCOPE_MODEL: "kimi-k3.1-pro", OSS_BUCKET: "auto-analysis-test", OSS_REGION: "cn-hangzhou",
      ACCESS_KEY_ID: "test-oss-id", ACCESS_KEY_SECRET: "test-oss-secret-key", SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT: limit },
    now: () => state.now, provider: market, scannerFetch,
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
    requests, objects, logs, state,
    invoke: () => post("/invoke", { triggerName: "binance-market-scanner", triggerTime: new Date(state.now).toISOString() },
      { "x-fc-control-path": "/invoke", "x-fc-request-id": "test-trigger" }),
    list: () => post("/scans", { version: 2 }, { "X-JWT-Token": jwt() }),
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
  let bytes = 0;
  const mockStore = { appendJsonLineAt: async (_key, token, position) => {
    assert.equal(token, 1);
    if (position !== bytes) return bytes;
    bytes += 2;
    return null;
  } };
  const concurrent = await Promise.all(Array.from({ length: 7 }, () => reserveAutoAnalysisQuota(mockStore, "2026-11-18", 3)));
  assert.equal(concurrent.filter(Boolean).length, 3);
  const app = await testServer(t, "1", { now: Date.UTC(2026, 10, 18, 15, 45) + 1000 });
  assert.equal((await app.invoke()).autoAnalysis.status, "completed");
  app.state.now += period;
  assert.equal((await app.invoke()).autoAnalysis.status, "completed");
  assert.equal(app.requests.length, 2);
  assert.equal(app.objects.get(`${storage}/quota/2026-11-18.ndjson`), "1\n");
  assert.equal(app.objects.get(`${storage}/quota/2026-11-19.ndjson`), "1\n");
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
  const app = await testServer(t, "2");
  app.state.invalidMarket = true;
  assert.equal((await app.invoke()).autoAnalysis.stage, "market_snapshot");
  app.state.invalidMarket = false;
  app.state.stale = true;
  assert.equal((await app.invoke()).autoAnalysis.status, "stale");
  app.state.stale = false;
  app.state.modelTimeout = true;
  assert.equal((await app.invoke()).autoAnalysis.errorCode, "MODEL_TIMEOUT");
  assert.equal((await app.invoke()).autoAnalysis.status, "duplicate");
  app.state.now += period;
  app.state.modelTimeout = false;
  app.state.invalidModel = true;
  assert.equal((await app.invoke()).autoAnalysis.errorCode, "INVALID_MODEL_OUTPUT");
  assert.ok(app.logs.some(log => log.event === "market_auto_analysis_failed" && log.upstreamRequestId === upstreamId && log.inputTokens === 123));
  app.state.now += period;
  assert.equal((await app.invoke()).autoAnalysis.status, "daily_limit");
  assert.equal(app.requests.length, 2);
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
