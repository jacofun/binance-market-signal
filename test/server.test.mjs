import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { makeServer } from "../build/server.js";
import { analyzeWithModel } from "../build/model.js";
import { loadConfig } from "../build/config.js";
import { RestMarketDataProvider } from "../build/market.js";
import { env, jwt, NOW, provider, modelResult, proposal, silent, snapshot } from "./fixtures.mjs";

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
test("shared ticket reaches analysis without FC metadata headers or JWT environment settings", async t => {
  const { request } = await app(t, { env: { DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY, SIGNAL_COOLDOWN_SECONDS: "0" } });
  for (const headers of [{}, { "x-fc-control-path": "/invoke" }, { "x-fc-function-name": "unexpected-name" }, { "x-fc-request-id": "" }]) {
    const response = await request("/analyze", { symbol: "BTCUSDT" }, headers);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "candidate");
  }
});
test("malformed token, origin, symbol, media type and oversized bodies fail before market fetch", async t => {
  let calls = 0;
  const { request, url } = await app(t, { provider: provider({ snapshot: async () => { calls++; throw new Error(); } }) });
  const cases = [
    ["/analyze", { symbol: "BTCUSDT" }, { "X-JWT-Token": "Bearer malformed" }, 401],
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
test("upstream model diagnostics reach response and logs without raw provider text", async t => {
  const logs = [];
  const { request } = await app(t, {
    model: (...args) => analyzeWithModel(...args, async () => new Response(JSON.stringify({ error: { code: "InvalidParameter", message: "secret-provider-text" } }), {
      status: 400, headers: { "x-request-id": "5a5096c5-8e7e-47d7-8998-e4cf310cd50c" },
    })),
    logger: { info: x => logs.push(x), error: x => logs.push(x) },
  });
  const response = await request(); const body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.error.code, "MODEL_UNAVAILABLE");
  assert.equal(body.error.upstreamStatus, 400); assert.equal(body.error.upstreamCode, "InvalidParameter");
  assert.equal(body.error.upstreamRequestId, "5a5096c5-8e7e-47d7-8998-e4cf310cd50c");
  const log = logs.map(x => JSON.parse(x)).find(x => x.event === "analysis_failed");
  assert.equal(log.requestId, body.requestId); assert.equal(log.upstreamStatus, 400); assert.equal(log.upstreamCode, "InvalidParameter");
  assert.equal(JSON.stringify(body).includes("secret-provider-text"), false);
  assert.equal(logs.join("").includes("secret-provider-text"), false);
});
test("model output diagnostics reach HTTP and logs without content or reasoning", async t => {
  const logs = [];
  const { request } = await app(t, {
    model: (...args) => analyzeWithModel(...args, async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "private-incomplete-output", reasoning_content: "private-reasoning" } }],
      usage: { prompt_tokens: 100, completion_tokens: 2000 },
    }))),
    logger: { info: x => logs.push(x), error: x => logs.push(x) },
  });
  const response = await request(); const body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.error.code, "INVALID_MODEL_OUTPUT");
  assert.equal(body.error.outputReason, "truncated"); assert.equal(body.error.finishReason, "length");
  assert.equal(body.error.outputTokens, 2000);
  const log = logs.map(x => JSON.parse(x)).find(x => x.event === "analysis_failed");
  assert.equal(log.requestId, body.requestId); assert.equal(log.outputReason, "truncated");
  assert.equal(JSON.stringify(body).includes("private-"), false);
  assert.equal(logs.join("").includes("private-"), false);
});
test("zone failures log precise reasons and safe market context while preserving the HTTP contract", async t => {
  for (const reason of ["zone_not_found", "zone_broken", "entry_out_of_bounds", "stop_too_far", "target_out_of_bounds"]) {
    await t.test(reason, async t => {
      const logs = [];
      const market = snapshot();
      const zone = market.frames[1].zones[0];
      zone.id = "1h:support:1795000000000";
      const modelProposal = proposal();
      modelProposal.research.entryZoneId = zone.id;
      modelProposal.research.stopZoneId = zone.id;
      let field = "research.entryZoneId";
      if (reason === "zone_not_found") modelProposal.research.entryZoneId = "private-invalid-zone";
      if (reason === "zone_broken") zone.status = "broken";
      if (reason === "entry_out_of_bounds") modelProposal.entry.min = 9979.9;
      if (reason === "stop_too_far") { modelProposal.stopLoss = 9800; field = "stopLoss"; }
      if (reason === "target_out_of_bounds") { modelProposal.targets[0].price = 10230; field = "targets[0].price"; }
      modelProposal.summary = "private-model-prose";
      const { request } = await app(t, {
        provider: provider({ snapshot: async () => market }),
        model: (...args) => analyzeWithModel(...args, async () => new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(modelProposal), reasoning_content: "private-model-reasoning" } }],
          request_id: "5a5096c5-8e7e-47d7-8998-e4cf310cd50c",
        }))),
        logger: { info: x => logs.push(x), error: x => logs.push(x) },
      });
      const response = await request();
      const body = await response.json();
      const log = JSON.parse(logs[0]);
      assert.equal(response.status, 502);
      assert.equal(body.error.outputField, field);
      assert.equal(body.error.outputReason, reason === "target_out_of_bounds" ? "unsupported_target" : "unsupported_zone");
      assert.equal(body.error.validation, undefined);
      assert.equal(body.error.exception, undefined);
      assert.equal(log.requestId, body.requestId);
      assert.equal(log.stage, "proposal_validation");
      assert.equal(log.symbol, "BTCUSDT");
      assert.equal(log.style, "trend");
      assert.equal(log.httpStatus, 502);
      assert.ok(log.codeVersion);
      assert.equal(log.upstreamRequestId, body.error.upstreamRequestId);
      assert.equal(log.validation.reason, reason);
      assert.equal(log.validation.snapshotAsOf, NOW);
      if (reason === "zone_not_found") {
        assert.equal(log.validation.zoneReference, "malformed");
        assert.equal(log.validation.requestedZoneId, undefined);
        assert.equal(log.validation.zoneCount, 5);
      }
      if (reason === "zone_broken" || reason === "entry_out_of_bounds") {
        assert.equal(log.validation.zone.lower, 9980);
        assert.equal(log.validation.zone.upper, 10020);
        assert.deepEqual(log.validation.entry, modelProposal.entry);
      }
      if (reason === "stop_too_far") {
        assert.equal(log.validation.stopDistance, 180);
        assert.equal(log.validation.hourlyAtr, 100);
      }
      assert.ok(log.exception[0].frames.some(frame => frame.startsWith("model.js:")));
      assert.equal(logs.join("").includes("private-"), false);
    });
  }
});

test("Binance connection failures retain the nested native cause, stage and request path in logs", async t => {
  const logs = [];
  const cause = Object.assign(new Error("private-network-address"), { code: "ENOTFOUND" });
  const fetchError = new TypeError("private-fetch-text", { cause });
  const market = new RestMarketDataProvider(loadConfig(env), async () => { throw fetchError; }, () => NOW);
  const { request } = await app(t, { provider: market, logger: { info: x => logs.push(x), error: x => logs.push(x) } });
  const response = await request();
  assert.equal(response.status, 504);
  const payload = await response.json();
  const log = JSON.parse(logs[0]);
  assert.equal(payload.error.code, "BINANCE_TIMEOUT");
  assert.equal(payload.error.exception, undefined);
  assert.equal(log.stage, "market_snapshot");
  assert.equal(log.marketEndpoint, "/fapi/v1/time");
  assert.deepEqual(log.exception.map(({ name, code }) => [name, code]), [
    ["AppError", "BINANCE_TIMEOUT"], ["TypeError", undefined], ["Error", "ENOTFOUND"],
  ]);
  assert.equal(logs.join("").includes("private-"), false);
});

test("model connection and malformed JSON keep distinct original exception types in logs", async t => {
  for (const mode of ["connection", "json"]) {
    await t.test(mode, async t => {
      const logs = [];
      const requestModel = async () => {
        if (mode === "connection") {
          throw new TypeError("private-fetch-text", { cause: Object.assign(new Error("private-socket-text"), { code: "UND_ERR_SOCKET" }) });
        }
        return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "private-model-output" } }] }));
      };
      const { request } = await app(t, { model: (...args) => analyzeWithModel(...args, requestModel), logger: { info: x => logs.push(x), error: x => logs.push(x) } });
      const response = await request();
      const body = await response.json();
      const log = JSON.parse(logs[0]);
      assert.equal(log.stage, "model");
      if (mode === "connection") {
        assert.equal(body.error.code, "MODEL_TIMEOUT");
        assert.equal(log.exception[2].code, "UND_ERR_SOCKET");
      } else {
        assert.equal(body.error.outputReason, "invalid_json");
        assert.equal(log.exception[1].name, "SyntaxError");
      }
      assert.equal(logs.join("").includes("private-"), false);
    });
  }
});

test("RAM-invoked boot probe requires neither JWT nor a Bailian key and cannot trigger analysis", async t => {
  const { url } = await app(t, { env: {} });
  for (const path of ["/", "/invoke"]) {
    const response = await fetch(url + path, { method: "POST", headers: { "x-fc-request-id": "platform-probe", "content-type": "application/octet-stream" }, body: '{"action":"health"}' });
    assert.equal(response.status, 200); assert.equal((await response.json()).service, "binance-market-signal");
  }
});
