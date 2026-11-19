import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { scanRules } from "../build/market-scanner.js";
import { INTERVAL_MS } from "../build/market.js";
import { makeServer } from "../build/server.js";
import { env, jwt, NOW, klines, modelResult, provider } from "./fixtures.mjs";

const period = INTERVAL_MS["15m"];
const ruleZone = (id, kind, lower, upper, confirmedAt = NOW - 4 * period) =>
  ({ id, kind, lower, upper, confirmedAt, status: "active" });
const candle = (openTime, close, high = close + 1, low = close - 1) => ({ openTime, close, high, low });
const candles = (prev, last) => [candle(NOW - 3 * period, 100), prev, last];
const short = (recentCandles, rvol = 2) => ({ recentCandles, atr14: 5, volumePrice: [{ volumeRatio20: rvol }] });
const htf = { trend: "up" };
const resistance = ruleZone("a", "resistance", 100, 102);
const higher = ruleZone("b", "resistance", 113, 115);
const lower = ruleZone("c", "support", 85, 90);

test("15m breakout records volume, trend, distance and obstruction checks before passing", () => {
  const data = candles(candle(NOW - 2 * period, 101), candle(NOW - period, 104));
  const hourly = { zones: [resistance, higher, lower] };
  const [passed] = scanRules(short(data), hourly, htf);
  assert.equal(passed.kind, "breakout");
  assert.equal(passed.zone.id, "a");
  assert.equal(passed.direction, "long");
  assert.equal(passed.status, "passed");
  assert.equal(passed.checks.find(check => check.code === "rvol20").expected, 1.5);
  const [weak] = scanRules(short(data, 1.1), hourly, { trend: "down" });
  assert.equal(weak.status, "filtered");
  assert.deepEqual(weak.checks.filter(check => check.passed === false).map(check => check.code), ["rvol20", "trend_4h"]);
  const [blocked] = scanRules(short(data), { zones: [resistance, ruleZone("blocking", "resistance", 105, 108)] }, htf);
  assert.equal(blocked.checks.find(check => check.code === "room_atr").passed, false);
  const [alreadyOutside] = scanRules(short(candles(candle(NOW - 2 * period, 103), candle(NOW - period, 104))), hourly, htf);
  assert.equal(alreadyOutside.status, "none");
});

test("reclaim waits for a confirming close and only considers zones known before the sweep", () => {
  const sweep = candle(NOW - period, 101, 105);
  const zones = { zones: [resistance, higher, lower] };
  const [, watch] = scanRules(short(candles(candle(NOW - 2 * period, 100), sweep)), zones, htf);
  assert.equal(watch.status, "watch");
  assert.equal(watch.checks.find(check => check.code === "next_close").passed, null);
  const prior = candle(NOW - 2 * period, 101, 105);
  const [, confirmed] = scanRules(short(candles(prior, candle(NOW - period, 99))), zones, htf);
  assert.equal(confirmed.status, "passed");
  assert.equal(confirmed.direction, "short");
  const [, invalidated] = scanRules(short(candles(prior, candle(NOW - period, 103))), zones, htf);
  assert.equal(invalidated.status, "filtered");
  assert.equal(invalidated.checks.find(check => check.code === "next_close").passed, false);
  const future = ruleZone("future", "resistance", 100, 102, NOW - period);
  const [, notKnown] = scanRules(short(candles(prior, candle(NOW - period, 99))), { zones: [future, lower] }, htf);
  assert.equal(notKnown.status, "none");
});

const timer = { triggerName: "binance-market-scanner", triggerTime: new Date(NOW).toISOString(), payload: "" };
async function server(t, envOverride = {}, marketFailure = false) {
  const calls = [];
  const objects = new Map();
  const logs = [];
  let modelCalls = 0;
  const scannerFetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ host: url.hostname, path: url.pathname, params: url.searchParams, method: options.method ?? "GET" });
    if (url.hostname === "scan-test.oss-cn-hangzhou.aliyuncs.com") {
      assert.match(options.headers.authorization, /^OSS4-HMAC-SHA256 Credential=/);
      if (options.method === "PUT") {
        assert.equal(options.headers["x-oss-forbid-overwrite"], "true");
        if (objects.has(url.pathname)) return new Response(null, { status: 409 });
        objects.set(url.pathname, JSON.parse(options.body));
        return new Response(null);
      }
      return objects.has(url.pathname) ? Response.json(objects.get(url.pathname)) :
        new Response(null, { status: 404, headers: { "x-oss-request-id": "test-oss-id" } });
    }
    assert.equal(url.hostname, "fapi.binance.com");
    assert.equal(options.headers["X-MBX-APIKEY"], undefined);
    if (marketFailure) return new Response(null, { status: 429 });
    if (url.pathname === "/fapi/v1/time") return Response.json({ serverTime: NOW + 10000 });
    assert.equal(url.pathname, "/fapi/v1/klines");
    return Response.json(klines(INTERVAL_MS[url.searchParams.get("interval")], Number(url.searchParams.get("endTime"))));
  };
  const runtime = makeServer({ env: { SIGNAL_ORDER_OSS_BUCKET: "scan-test", SIGNAL_ORDER_OSS_REGION: "cn-hangzhou",
    ACCESS_KEY_ID: "test-oss-id", ACCESS_KEY_SECRET: "test-oss-secret-key", ...envOverride }, now: () => NOW + 10000,
    scannerFetch, provider: provider(), model: async () => { modelCalls++; return modelResult(); },
    logger: { info: line => logs.push(line), error: line => logs.push(line) } });
  runtime.listen(0, "127.0.0.1");
  await once(runtime, "listening");
  t.after(() => { runtime.closeAllConnections(); runtime.close(); });
  const post = async (path, input, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${runtime.address().port}${path}`, { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  };
  const invoke = (input = timer, headers = {}) => post("/invoke", input, { "x-fc-request-id": "fc-test", ...headers });
  return { post, invoke, calls, objects, logs, modelCalls: () => modelCalls };
}

test("FC scan uses only public market REST and OSS, produces one row and exposes a bounded read page", async t => {
  const app = await server(t);
  const unauth = await app.post("/trade/api/signal/scans", {});
  assert.equal(unauth.status, 401);
  assert.equal(app.calls.length, 0);
  const scan = await app.invoke();
  assert.equal(scan.status, 200, JSON.stringify(scan));
  assert.equal(scan.data.status, "none");
  assert.equal(app.objects.size, 1);
  assert.equal(app.modelCalls(), 0);
  const market = app.calls.filter(call => call.host === "fapi.binance.com");
  assert.equal(market.length, 4);
  assert.equal(market.find(call => call.params.get("interval") === "15m").params.get("endTime"), String(NOW));
  assert.ok(market.filter(call => ["1h", "4h"].includes(call.params.get("interval"))).every(call =>
    call.params.get("endTime") === String(NOW - 2 * period)));
  assert.equal((await app.invoke()).data.duplicate, true);
  assert.equal(app.calls.filter(call => call.host === "fapi.binance.com").length, 4);
  const read = await app.post("/trade/api/signal/scans", {}, { "X-JWT-Token": jwt() });
  assert.equal(read.data.records[0].slot, NOW);
  assert.equal(read.data.records[0].rules.length, 2);
  assert.equal(read.data.next, NOW - 15 * period);
  const older = await app.post("/scans", { before: read.data.next }, { "X-JWT-Token": jwt() });
  assert.deepEqual(older.data.records, []);
  assert.equal((await app.post("/scans", { before: NOW + 2 * period }, { "X-JWT-Token": jwt() })).status, 400);
  assert.equal((await app.post("/scans", { action: "run" }, { "X-JWT-Token": jwt() })).status, 400);
  assert.ok(app.logs.some(log => log.includes("market_scan_recorded")));
});

test("invalid events are rejected and a failed scan still leaves a diagnostic row", async t => {
  const app = await server(t, {}, true);
  assert.equal((await app.post("/invoke", timer)).status, 404);
  assert.equal((await app.invoke({ ...timer, triggerTime: new Date(NOW - period).toISOString() })).data.error.code, "INVALID_SCAN_TIMER");
  assert.equal((await app.invoke(timer, { Origin: "https://yanxiao.me" })).status, 401);
  assert.equal((await app.invoke({ ...timer, triggerName: "unknown" })).status, 401);
  assert.equal(app.calls.length, 0);
  const failure = await app.invoke();
  assert.deepEqual([failure.status, failure.data.status, failure.data.errorCode], [200, "error", "BINANCE_RATE_LIMITED"]);
  assert.equal(app.modelCalls(), 0);
});

test("missing scanner credentials leave existing model analysis independent", async t => {
  const app = await server(t, { ...env, SIGNAL_ORDER_OSS_BUCKET: "" });
  assert.equal((await app.invoke()).data.error.code, "SCAN_STORAGE_CONFIGURATION");
  const analyzed = await app.post("/analyze", { symbol: "BTCUSDT" }, { "X-JWT-Token": jwt() });
  assert.equal(analyzed.status, 200);
  assert.equal(app.modelCalls(), 1);
  assert.equal(app.calls.length, 0);
});
