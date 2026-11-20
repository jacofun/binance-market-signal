import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketMarketDataProvider } from "../build/websocket-market.js";
import { loadConfig } from "../build/config.js";
import { env, klines, NOW, marketFetch } from "./fixtures.mjs";
import { INTERVAL_MS } from "../build/market.js";

class Socket extends EventTarget {
  closed = false;
  close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event("close")); } }
}
test("WebSocket adapter bootstraps via REST, consumes prices, bounds bars and repairs gaps", async t => {
  const socket = new Socket();
  let calls = 0;
  const config = loadConfig(env);
  const market = new WebSocketMarketDataProvider(config, async url => { calls++; return marketFetch(url); }, () => NOW, url => {
    assert.ok(url.startsWith("wss://fstream.binance.com/market/stream?streams="));
    assert.ok(url.includes("btcusdt@kline_15m"));
    assert.ok(!url.includes("btcusdt@kline_1d"));
    return socket;
  });
  t.after(() => market.close());
  const first = await market.snapshot("BTCUSDT", AbortSignal.timeout(2000));
  assert.equal(first.source, "websocket"); assert.equal(first.frames.length, 3);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ data: { e: "markPriceUpdate", s: "BTCUSDT", E: NOW, p: "10005", i: "10000", r: "0.0001", T: NOW + 3600000 } }) }));
  const count = calls;
  assert.equal((await market.quote("BTCUSDT", AbortSignal.timeout(1000))).price, 10005);
  assert.equal(calls, count);
  await market.snapshot("BTCUSDT", AbortSignal.timeout(2000));
  assert.equal(calls - count, 2); // server time and OI, candles/quote served from cache
  const rows = market.bars.get("BTCUSDT:15m");
  rows.splice(30, 1);
  await market.snapshot("BTCUSDT", AbortSignal.timeout(2000));
  assert.equal(market.bars.get("BTCUSDT:15m").length, 200);
  socket.close();
  const afterClose = calls;
  await market.quote("BTCUSDT", AbortSignal.timeout(1000));
  assert.equal(calls, afterClose + 1);
});
test("malformed stream events close the socket and shutdown prevents reconnect", async () => {
  const socket = new Socket();
  let connections = 0;
  const market = new WebSocketMarketDataProvider(loadConfig(env), marketFetch, () => NOW, () => { connections++; return socket; });
  socket.dispatchEvent(new MessageEvent("message", { data: "bad-json" }));
  assert.equal(socket.closed, true);
  market.close();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(connections, 1);
});

test("a provisional WebSocket bar cannot replace a missing final bar at the new close", async t => {
  const socket = new Socket();
  let now = NOW + 2000;
  let pendingClose = true;
  const boundary = NOW + INTERVAL_MS["15m"];
  const market = new WebSocketMarketDataProvider(loadConfig(env), async url => {
    if (url.pathname.endsWith("/time")) return Response.json({ serverTime: now });
    if (url.pathname.endsWith("/klines")) {
      const interval = url.searchParams.get("interval");
      const end = Number(url.searchParams.get("endTime"));
      const rows = klines(INTERVAL_MS[interval], end);
      if (end === boundary && pendingClose) {
        pendingClose = false;
        return Response.json(rows.slice(0, -2));
      }
      rows.at(-2)[4] = end === boundary ? "10050" : "10010";
      return Response.json(rows);
    }
    if (url.pathname.endsWith("/premiumIndex")) return Response.json({ symbol: "BTCUSDT", markPrice: "10000",
      indexPrice: "10000", lastFundingRate: "0", time: now, nextFundingTime: now + INTERVAL_MS["1h"] });
    return marketFetch(url);
  }, () => now, () => socket);
  t.after(() => market.close());
  await market.snapshot("BTCUSDT", AbortSignal.timeout(2500));
  now = boundary + 2000;
  market.ingest({ e: "kline", s: "BTCUSDT", k: { i: "15m", x: false, t: NOW, T: boundary - 1, c: "10088" } });
  const result = await market.snapshot("BTCUSDT", AbortSignal.timeout(2500));
  const short = result.frames.find(frame => frame.interval === "15m");
  assert.equal(short.lastCloseTime, boundary - 1);
  assert.equal(short.close, 10050);
  assert.equal(pendingClose, false);
});
