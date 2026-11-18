import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { makeServer } from "../build/server.js";
import { env, jwt, NOW, provider, modelResult, silent } from "./fixtures.mjs";

async function app(t, options = {}) {
  const server = makeServer({ env, now: () => NOW, logger: silent, provider: provider(), model: async () => modelResult(), ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path = "/trade/api/signal/analyze", body = { symbol: "BTCUSDT" }, headers = {}) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json", "X-JWT-Token": jwt(), ...headers }, body: JSON.stringify(body) });
  return { url, request };
}
test("health and CORS work before business configuration; unauthorized calls do not touch providers", async t => {
  let calls = 0;
  const { url } = await app(t, { env: {}, provider: provider({ snapshot: async () => { calls++; throw new Error(); } }) });
  const health = await fetch(url + "/trade/api/signal/health");
  assert.equal(health.status, 200); assert.equal((await health.json()).nodeMajor, 24);
  const preflight = await fetch(url + "/trade/api/signal/analyze", { method: "OPTIONS", headers: { Origin: "https://www.yanxiao.me", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-jwt-token,content-type" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), "https://www.yanxiao.me");
  const denied = await fetch(url + "/trade/api/signal/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: '{}' });
  assert.equal(denied.status, 401); assert.equal(calls, 0);
});
test("full prefix and CDN-rewritten root paths return opportunities using only X-JWT-Token", async t => {
  const { request } = await app(t);
  for (const path of ["/trade/api/signal/analyze", "/trade/api/signal/", "/analyze", "/"]) {
    const response = await request(path, { symbol: "BTCUSDT" }, { Authorization: "OSS cdn-origin-signature", Origin: "https://www.yanxiao.me" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "candidate"); assert.ok(result.requestId); assert.equal(result.opportunity.triggerVerified, false);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const wrong = await request("/trade/api/signal/analyze", { symbol: "BTCUSDT" }, { "X-JWT-Token": "", Authorization: jwt() });
  assert.equal(wrong.status, 401);
});
test("wrong scope, origin, symbol, media type and oversized bodies fail before market fetch", async t => {
  let calls = 0;
  const { request, url } = await app(t, { provider: provider({ snapshot: async () => { calls++; throw new Error(); } }) });
  const cases = [
    ["/analyze", { symbol: "BTCUSDT" }, { "X-JWT-Token": jwt({ scope: "trading:sync" }) }, 401],
    ["/analyze", { symbol: "BTCUSDT" }, { Origin: "https://evil.test" }, 403],
    ["/analyze", { symbol: "ETHUSDT" }, {}, 400],
    ["/analyze", { symbol: "BTCUSDT", apiKey: "do-not-accept" }, {}, 400],
    ["/analyze", { symbol: "BTCUSDT" }, { "content-type": "text/plain" }, 415],
    ["/analyze", { symbol: "x".repeat(5000) }, {}, 413],
    ["/trade/api/sync", { symbol: "BTCUSDT" }, {}, 404],
  ];
  for (const [path, body, headers, status] of cases) assert.equal((await request(path, body, headers)).status, status);
  const preflight = await fetch(url + "/analyze", { method: "OPTIONS", headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 403); assert.equal(calls, 0);
});
test("one active analysis is allowed; no model queue builds up on a small instance", async t => {
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  const wait = new Promise(r => { release = r; });
  const { request } = await app(t, { model: async () => { entered(); await wait; return modelResult(); } });
  const first = request(); await ready;
  const busy = await request(); assert.equal(busy.status, 429); assert.equal((await busy.json()).error.code, "BUSY");
  release(); assert.equal((await first).status, 200);
});
test("unexpected provider/model errors are sanitized in both HTTP response and logs", async t => {
  const logs = [];
  const { request } = await app(t, { model: async () => { throw new Error("private-token-and-url"); }, logger: { info: x => logs.push(x), error: x => logs.push(x) } });
  const response = await request(); assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("private-token"), false); assert.equal(logs.join("").includes("private-token"), false);
});
test("RAM-invoked boot probe requires neither JWT nor a Bailian key and cannot trigger analysis", async t => {
  const { url } = await app(t, { env: {} });
  for (const path of ["/", "/invoke"]) {
    const response = await fetch(url + path, { method: "POST", headers: { "x-fc-request-id": "platform-probe", "content-type": "application/octet-stream" }, body: '{"action":"health"}' });
    assert.equal(response.status, 200); assert.equal((await response.json()).service, "binance-market-signal");
  }
});
