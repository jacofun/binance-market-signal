import test from "node:test";
import assert from "node:assert/strict";
import { RestMarketDataProvider, parseCandles, frame } from "../build/market.js";
import { loadConfig } from "../build/config.js";
import { env, NOW, klines, marketFetch } from "./fixtures.mjs";

test("only contiguous closed candles enter indicators, with known ATR and volume ratio", () => {
  const bars = parseCandles(klines(3600000), "1h", NOW);
  assert.equal(bars.length, 200);
  assert.equal(bars.at(-1).closeTime, Math.floor(NOW / 3600000) * 3600000 - 1);
  const f = frame(bars, "1h");
  assert.equal(f.ema20, 10010); assert.equal(f.ema50, 10010); assert.equal(f.atr14, 200); assert.equal(f.volumeRatio20, 1);
  assert.equal(f.recentCandles.length, 24);
  for (const rows of [klines(3600000).slice(0, -2), klines(3600000).filter((_, i) => i !== 30), klines(3600000).slice(-20)]) assert.throws(() => parseCandles(rows, "1h", NOW));
  const broken = klines(3600000); broken[20][4] = "Infinity";
  assert.throws(() => parseCandles(broken, "1h", NOW));
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
  const result = await market.snapshot("BTCUSDT", AbortSignal.timeout(1000));
  assert.equal(result.frames.length, 3); assert.equal(result.openInterest.length, 1); assert.equal(peak, 2);
});
test("optional OI failure is explicit, but rate limits stop analysis", async () => {
  const config = loadConfig(env);
  const market = new RestMarketDataProvider(config, (url) => String(url).includes("openInterestHist") ? Promise.resolve(new Response("bad", { status: 500 })) : marketFetch(url), () => NOW);
  const snapshot = await market.snapshot("BTCUSDT", AbortSignal.timeout(1000));
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
