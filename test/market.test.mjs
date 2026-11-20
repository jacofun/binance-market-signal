import test from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_INTERVALS, INTERVAL_MS, RestMarketDataProvider, parseCandles, frame } from "../build/market.js";
import { loadConfig } from "../build/config.js";
import { env, NOW, klines, marketFetch } from "./fixtures.mjs";
import { limited } from "../build/http.js";

test("only contiguous closed candles enter indicators, with known ATR and volume ratio", () => {
  const bars = parseCandles(klines(3600000), "1h", NOW);
  assert.equal(bars.length, 200);
  assert.equal(bars.at(-1).closeTime, Math.floor(NOW / 3600000) * 3600000 - 1);
  const f = frame(bars, "1h");
  assert.equal(f.ema20, 10010); assert.equal(f.ema50, 10010); assert.equal(f.atr14, 200); assert.equal(f.volumeRatio20, 1);
  assert.equal(f.recentCandles.length, 200);
  for (const rows of [klines(3600000).slice(0, -2), klines(3600000).filter((_, i) => i !== 30), klines(3600000).slice(-20)]) assert.throws(() => parseCandles(rows, "1h", NOW));
  const broken = klines(3600000); broken[20][4] = "Infinity";
  assert.throws(() => parseCandles(broken, "1h", NOW));
});
test("closed candles produce volume-price evidence and confirmed historical levels", () => {
  const rows = klines(900000);
  rows[40][2] = "10500";
  rows[42][3] = "9500";
  const latest = rows.at(-2);
  latest[4] = "10100";
  latest[5] = "25";
  latest[9] = "15";
  rows.at(-1)[2] = "15000";
  const result = frame(parseCandles(rows, "15m", NOW), "15m");
  assert.equal(result.priceLevels.high200, 10500);
  assert.deepEqual(result.priceLevels.swingHighs, [10500]);
  assert.deepEqual(result.priceLevels.swingLows, [9500]);
  assert.equal(result.high20, 10100);
  const recent = result.volumePrice.at(-1);
  assert.equal(recent.openTime, latest[0]);
  assert.ok(Math.abs(recent.closeChangePct - (10100 / 10010 - 1) * 100) < 1e-9);
  assert.equal(recent.volumeRatio20, 2.5);
  assert.equal(recent.takerBuyShare, 0.6);
});
test("REST snapshot uses no account secrets and caps parallel calls at two", async () => {
  let active = 0, peak = 0;
  const request = async (url, options) => {
    assert.equal(new URL(url).origin, "https://fapi.binance.com");
    assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, undefined);
    peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 2));
    try { return await marketFetch(url); } finally { active--; }
  };
  const market = new RestMarketDataProvider(loadConfig(env), request, () => NOW);
  const result = await market.snapshot("BTCUSDT", AbortSignal.timeout(2500));
  assert.deepEqual(result.frames.map(f => [f.interval, f.recentCandles.length]), [["4h", 200], ["1h", 200], ["15m", 200]]);
  assert.equal(result.openInterest.length, 1); assert.equal(peak, 2);
});

test("a snapshot crossing a shared boundary refreshes the three frames and retries a delayed close", async () => {
  const boundary = Date.UTC(2026, 10, 19, 12);
  let now = boundary - 100;
  let waiting15m = true;
  const requested = new Map(ANALYSIS_INTERVALS.map(interval => [interval, []]));
  const market = new RestMarketDataProvider(loadConfig(env), async (url) => {
    if (url.pathname.endsWith("/time")) return Response.json({ serverTime: now });
    if (url.pathname.endsWith("/premiumIndex")) {
      now = boundary + 2000;
      return Response.json({ symbol: "BTCUSDT", markPrice: "10000", indexPrice: "10000", lastFundingRate: "0",
        time: now, nextFundingTime: now + INTERVAL_MS["1h"] });
    }
    if (url.pathname.endsWith("/klines")) {
      const interval = url.searchParams.get("interval");
      const end = Number(url.searchParams.get("endTime"));
      requested.get(interval).push(end);
      const rows = klines(INTERVAL_MS[interval], end);
      rows.at(-3)[4] = "10001";
      rows.at(-2)[4] = "10050";
      rows.at(-1)[4] = "10070";
      if (interval === "15m" && end === boundary && waiting15m) {
        waiting15m = false;
        return Response.json(rows.slice(0, -2));
      }
      return Response.json(rows);
    }
    return marketFetch(url);
  }, () => now);
  const result = await market.snapshot("BTCUSDT", AbortSignal.timeout(2500));
  assert.equal(result.asOf, boundary + 2000);
  for (const interval of ANALYSIS_INTERVALS) {
    const current = result.frames.find(frame => frame.interval === interval);
    assert.equal(current.recentCandles.length, 200);
    assert.equal(current.lastCloseTime, boundary - 1);
    assert.equal(current.recentCandles.at(-1).openTime, boundary - INTERVAL_MS[interval]);
    assert.equal(current.recentCandles.at(-1).close, 10050);
    assert.deepEqual(requested.get(interval), [boundary - INTERVAL_MS[interval], boundary, ...(interval === "15m" ? [boundary] : [])]);
  }
});

test("the snapshot fails with the affected timeframe when the latest close stays unpublished", async () => {
  const market = new RestMarketDataProvider(loadConfig(env), async (url) => {
    if (url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "15m") {
      return Response.json(klines(INTERVAL_MS["15m"], NOW).slice(0, -2));
    }
    return marketFetch(url);
  }, () => NOW);
  await assert.rejects(market.snapshot("BTCUSDT", AbortSignal.timeout(6000)), {
    code: "MARKET_CANDLE_NOT_READY", message: /15m/,
  });
});
test("optional OI failure is explicit, but rate limits stop analysis", async () => {
  const config = loadConfig(env);
  const market = new RestMarketDataProvider(config, (url) => String(url).includes("openInterestHist") ? Promise.resolve(new Response("bad", { status: 500 })) : marketFetch(url), () => NOW);
  const snapshot = await market.snapshot("BTCUSDT", AbortSignal.timeout(2500));
  assert.deepEqual(snapshot.openInterest, []); assert.equal(snapshot.warnings.length, 1);
  const limited = new RestMarketDataProvider(config, async () => new Response("secret upstream URL", { status: 429, headers: { "retry-after": "30" } }), () => NOW);
  await assert.rejects(limited.snapshot("BTCUSDT", AbortSignal.timeout(1000)), { code: "BINANCE_RATE_LIMITED", retryAfter: 30 });
});
test("stale and future quotes are rejected, transport errors are sanitized", async () => {
  for (const time of [NOW - 30000, NOW + 10000]) {
    const market = new RestMarketDataProvider(loadConfig(env), async () => new Response(JSON.stringify({ symbol: "BTCUSDT", markPrice: "10000", indexPrice: "10000", lastFundingRate: "0", time, nextFundingTime: NOW + 3600000 })), () => NOW);
    await assert.rejects(market.quote("BTCUSDT", AbortSignal.timeout(1000)), { code: "STALE_MARKET_DATA" });
  }
  const market = new RestMarketDataProvider(loadConfig(env), async () => { throw new Error("https://secret-url/key"); });
  await assert.rejects(market.quote("BTCUSDT", AbortSignal.timeout(1000)), error => !error.message.includes("secret-url") && error.code === "BINANCE_TIMEOUT");
});

test("concurrent upstream tasks preserve the first failure", async () => {
  const first = new Error("first request failure");
  const later = new Error("later request failure");
  await assert.rejects(limited([
    async () => { throw first; },
    async () => { await Promise.resolve(); throw later; },
  ]), error => error === first);
});
