import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const state = { now: NOW + 10000, marketFailure, missingCloses: 0 };
  const scannerFetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ host: url.hostname, path: url.pathname, params: url.searchParams, method: options.method ?? "GET" });
    if (url.hostname === "scan-test.oss-cn-hangzhou.aliyuncs.com") {
      assert.match(options.headers.authorization, /^OSS4-HMAC-SHA256 Credential=/);
      if (options.method === "POST") {
        assert.equal(url.searchParams.has("append"), true);
        assert.equal(options.headers["content-type"], "application/x-ndjson");
        assert.equal(options.headers["content-md5"], createHash("md5").update(options.body).digest("base64"));
        const previous = objects.get(url.pathname) ?? "";
        const length = Buffer.byteLength(previous);
        if (Number(url.searchParams.get("position")) !== length) {
          return new Response(null, { status: 409, headers: { "x-oss-next-append-position": String(length) } });
        }
        objects.set(url.pathname, previous + options.body);
        return new Response(null);
      }
      const object = objects.get(url.pathname);
      return typeof object === "string" ? new Response(object) : object ? Response.json(object) :
        new Response(null, { status: 404, headers: { "x-oss-request-id": "test-oss-id" } });
    }
    assert.equal(url.hostname, "fapi.binance.com");
    assert.equal(options.headers["X-MBX-APIKEY"], undefined);
    if (state.marketFailure) return new Response(null, { status: 429 });
    if (url.pathname === "/fapi/v1/time") return Response.json({ serverTime: state.now });
    assert.equal(url.pathname, "/fapi/v1/klines");
    const timeframe = url.searchParams.get("interval");
    const values = klines(INTERVAL_MS[timeframe], Number(url.searchParams.get("endTime")));
    return Response.json(timeframe === "15m" && state.missingCloses ? values.slice(0, -1 - state.missingCloses) : values);
  };
  const runtime = makeServer({ env: { SIGNAL_ORDER_OSS_BUCKET: "scan-test", SIGNAL_ORDER_OSS_REGION: "cn-hangzhou",
    ACCESS_KEY_ID: "test-oss-id", ACCESS_KEY_SECRET: "test-oss-secret-key", ...envOverride }, now: () => state.now,
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
  return { post, invoke, calls, objects, logs, state, modelCalls: () => modelCalls };
}

const auth = { "X-JWT-Token": jwt() };
const rowsAt = (app, time = NOW) => {
  const hour = Math.floor(time / INTERVAL_MS["1h"]) * INTERVAL_MS["1h"];
  const key = `/private/market-signal-scanner/v1/BTCUSDT/runs/${hour}.ndjson`;
  return (app.objects.get(key) || "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
};

test("every invocation scans the latest available closed data and produces a separate row even for the same candle", async t => {
  const app = await server(t, { OSS_BUCKET: "scan-test", OSS_REGION: "cn-hangzhou", SIGNAL_ORDER_OSS_BUCKET: "other-legacy-bucket" });
  assert.equal((await app.post("/trade/api/signal/scans", { version: 2 })).status, 401);
  assert.equal(app.calls.length, 0);
  const scan = await app.invoke();
  assert.equal(scan.status, 200, JSON.stringify(scan));
  assert.equal(scan.data.status, "none");
  assert.equal(scan.data.candleClosedAt, NOW);
  assert.equal(scan.data.scannedAt, NOW + 10000);
  const prior = app.state.now;
  app.state.now += 20000;
  // Replayed delivery of the same triggerTime still scans the current exchange data.
  const repeated = await app.invoke();
  assert.equal(repeated.data.candleClosedAt, NOW);
  assert.equal(repeated.data.scannedAt, app.state.now);
  assert.equal(rowsAt(app).length, 2);
  assert.notEqual(rowsAt(app)[0].id, rowsAt(app)[1].id);
  assert.equal(app.modelCalls(), 0);
  const market = app.calls.filter(call => call.host === "fapi.binance.com");
  assert.equal(market.length, 8);
  assert.deepEqual(market.filter(call => call.params.get("interval") === "15m").map(call => call.params.get("endTime")),
    [String(prior), String(app.state.now)]);
  assert.ok(market.filter(call => ["1h", "4h"].includes(call.params.get("interval"))).every(call =>
    call.params.get("endTime") === String(NOW - 2 * period)));
  const read = await app.post("/trade/api/signal/scans", { version: 2 }, auth);
  assert.deepEqual(read.data.records.map(row => row.scannedAt), [app.state.now, prior]);
  assert.equal(read.data.records[0].rules.length, 2);
  assert.equal(read.data.next, `${read.data.from}:`);
  const older = await app.post("/scans", { version: 2, before: read.data.next }, auth);
  assert.deepEqual(older.data.records, []);
  assert.equal((await app.post("/scans", { version: 2, before: `${app.state.now + period}:` }, auth)).status, 400);
  assert.equal((await app.post("/scans", { version: 2, action: "run" }, auth)).status, 400);
  assert.ok(app.logs.some(log => log.includes("market_scan_recorded")));
});

test("at a publication delay the scanner uses the preceding closed candle, then the newly published candle on the next invocation", async t => {
  const app = await server(t);
  app.state.missingCloses = 1;
  const delayed = await app.invoke();
  assert.equal(delayed.data.candleClosedAt, NOW - period);
  app.state.missingCloses = 0;
  const available = await app.invoke();
  assert.equal(available.data.candleClosedAt, NOW);
  app.state.missingCloses = 2;
  const stale = await app.invoke();
  assert.equal(stale.data.status, "error");
  assert.equal(stale.data.errorCode, "INVALID_MARKET_DATA");
  assert.equal(rowsAt(app).length, 3);
});

test("invalid events are rejected and an earlier failure never stops the next invocation", async t => {
  const app = await server(t, {}, true);
  assert.equal((await app.post("/invoke", timer)).status, 404);
  assert.equal((await app.invoke({ ...timer, triggerTime: "bad-time" })).data.error.code, "INVALID_SCAN_TIMER");
  assert.equal((await app.invoke(timer, { Origin: "https://yanxiao.me" })).status, 401);
  assert.equal((await app.invoke({ ...timer, triggerName: "unknown" })).status, 401);
  assert.equal(app.calls.length, 0);
  const failure = await app.invoke();
  assert.deepEqual([failure.status, failure.data.status, failure.data.errorCode], [200, "error", "BINANCE_RATE_LIMITED"]);
  app.state.marketFailure = false;
  const next = await app.invoke({ ...timer, triggerTime: new Date(NOW - period).toISOString() });
  assert.equal(next.data.candleClosedAt, NOW);
  assert.equal(rowsAt(app).length, 2);
  assert.equal(app.modelCalls(), 0);
});

test("scan history includes legacy rows and paginates concurrent records with the same scan time", async t => {
  const app = await server(t);
  await app.invoke();
  const [record] = rowsAt(app);
  const shard = [...app.objects.keys()][0];
  app.objects.set(shard, Array.from({ length: 17 }, (_, i) => JSON.stringify({ ...record, id: `run-${String(i).padStart(2, "0")}` })).join("\n") + "\n");
  app.objects.set(`/private/market-signal-scanner/v1/BTCUSDT/${NOW}.json`, {
    symbol: "BTCUSDT", slot: NOW, rulesVersion: "v1", status: "none", close: record.close, rvol20: record.rvol20, trend4h: record.trend4h, rules: record.rules,
  });
  const first = (await app.post("/scans", { version: 2 }, auth)).data;
  assert.equal(first.records.length, 16);
  assert.equal(first.records[0].id, "run-16");
  const next = (await app.post("/scans", { version: 2, before: first.next }, auth)).data;
  assert.deepEqual(next.records.map(row => row.id), ["run-00", `legacy-${NOW}`]);
  assert.equal(next.records[1].scannedAt, null);
  assert.equal(next.records[1].candleClosedAt, NOW);
  assert.equal((await app.post("/scans", {}, auth)).data.records[0].slot, NOW);
});

test("missing scanner credentials leave existing model analysis independent", async t => {
  const app = await server(t, { ...env, SIGNAL_ORDER_OSS_BUCKET: "" });
  const failure = await app.invoke();
  assert.equal(failure.status, 503);
  assert.equal(failure.data.error.code, "SCAN_STORAGE_CONFIGURATION");
  assert.equal(JSON.parse(app.logs.at(-1)).configurationField, "SIGNAL_ORDER_OSS_BUCKET");
  assert.ok(app.logs.every(line => !line.includes("test-oss-secret-key")));
  const analyzed = await app.post("/analyze", { symbol: "BTCUSDT" }, { "X-JWT-Token": jwt() });
  assert.equal(analyzed.status, 200);
  assert.equal(app.modelCalls(), 1);
  assert.equal(app.calls.length, 0);
});
