import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { makeServer } from "../build/server.js";
import { env, jwt, NOW, provider, modelResult, publicKey } from "./fixtures.mjs";

const settings = {
  ...env, SIGNAL_ORDER_MODE: "demo", BINANCE_BASE_URL: "https://demo-fapi.binance.com",
  BINANCE_API_KEY: "test-binance-apikey", BINANCE_API_SECRET: "test-binance-secret",
  ACCESS_KEY_ID: "test-oss-key", ACCESS_KEY_SECRET: "test-oss-secret-123",
  SIGNAL_ORDER_OSS_BUCKET: "orders-bucket", SIGNAL_ORDER_OSS_REGION: "cn-hangzhou",
  SIGNAL_ORDER_JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }),
  SIGNAL_ORDER_SIGNING_SECRET: "b".repeat(64),
};
const digest = text => createHash("sha256").update(text).digest("hex");
const readToken = (sub = "owner") => jwt({ scope: "trading:orders:read", sub });
const submitToken = (draft, at = NOW) => jwt({ scope: "trading:orders:submit",
  iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 30, intent: digest(draft) });
const grid = { minQty: "0.001", maxQty: "20", stepSize: "0.001" };
function symbolRules(notional = "5") {
  return { symbols: [{
    symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
    orderTypes: ["MARKET", "LIMIT", "STOP"], timeInForce: ["GTC", "GTX"],
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "0.1" },
      { filterType: "LOT_SIZE", ...grid }, { filterType: "MARKET_LOT_SIZE", ...grid },
      { filterType: "MIN_NOTIONAL", notional }, { filterType: "PERCENT_PRICE", multiplierUp: "1.1", multiplierDown: "0.9" },
    ],
  }] };
}
const ossHeader = { "x-oss-request-id": "test-object-request-id" };
const makeMock = () => {
  const objects = new Map();
  const calls = [];
  const state = { clock: NOW, markPrice: "10000", notional: "5", quoteAge: 0, positions: [],
    hedge: true, versioning: "", post: "accepted", failStoreWrite: false, orders: new Map() };
  async function mockFetch(url, options) {
    const u = new URL(url);
    const { headers, method, body } = options;
    calls.push({ host: u.hostname, path: u.pathname, method, params: new URLSearchParams(method === "POST" ? body : u.search) });
    assert.equal(options.redirect, "error");
    if (u.hostname.endsWith(".aliyuncs.com")) {
      assert.equal(u.hostname, "orders-bucket.oss-cn-hangzhou.aliyuncs.com");
      assert.match(headers.authorization, /^OSS4-HMAC-SHA256 Credential=test-oss-key\/20261118\/cn-hangzhou\/oss\/aliyun_v4_request,Signature=[a-f0-9]{64}$/);
      if (u.search === "?versioning") return new Response(`<VersioningConfiguration>${state.versioning}</VersioningConfiguration>`);
      if (method === "GET") return objects.has(u.pathname) ? Response.json(objects.get(u.pathname), { headers: ossHeader }) : new Response(null, { status: 404, headers: ossHeader });
      if (method === "PUT") {
        assert.equal(headers["x-oss-forbid-overwrite"], "true");
        if (state.failStoreWrite && u.pathname.endsWith("/intent.json")) return new Response(null, { status: 403, headers: ossHeader });
        if (objects.has(u.pathname)) return new Response(null, { status: 409, headers: ossHeader });
        objects.set(u.pathname, JSON.parse(body));
        return new Response(null);
      }
      if (method === "DELETE") { objects.delete(u.pathname); return new Response(null, { status: 204 }); }
      throw new Error("Unexpected OSS request");
    }
    assert.equal(u.hostname, "demo-fapi.binance.com");
    const params = calls.at(-1).params;
    if (headers["X-MBX-APIKEY"]) {
      assert.equal(headers["X-MBX-APIKEY"], settings.BINANCE_API_KEY);
      assert.equal(params.get("recvWindow"), "3000");
      const signed = new URLSearchParams(params);
      const signature = signed.get("signature");
      signed.delete("signature");
      assert.equal(createHmac("sha256", settings.BINANCE_API_SECRET).update(signed.toString()).digest("hex"), signature);
    }
    if (u.pathname.endsWith("/exchangeInfo")) return Response.json(symbolRules(state.notional));
    if (u.pathname.endsWith("/premiumIndex")) return Response.json({ symbol: "BTCUSDT", markPrice: state.markPrice, time: state.clock - state.quoteAge });
    if (u.pathname.endsWith("/bookTicker")) return Response.json({ symbol: "BTCUSDT", bidPrice: "9999.9", askPrice: "10000.1",
      askQty: "0.50", bidQty: "0.50", time: state.clock - state.quoteAge });
    if (u.pathname.endsWith("/dual")) return Response.json({ dualSidePosition: state.hedge });
    if (u.pathname.endsWith("/positionRisk")) return Response.json(state.positions);
    if (u.pathname.endsWith("/openOrders") || u.pathname.endsWith("/openAlgoOrders")) return Response.json([]);
    const algo = u.pathname.endsWith("/algoOrder");
    assert.ok(algo || u.pathname.endsWith("/order"));
    if (method === "POST") {
      if (state.post === "rejected") return Response.json({ code: -2019, msg: "must never log raw API data" }, { status: 400 });
      const clientId = params.get(algo ? "clientAlgoId" : "newClientOrderId");
      const order = algo ? { symbol: "BTCUSDT", algoId: 44, clientAlgoId: clientId, algoStatus: "NEW" } :
        { symbol: "BTCUSDT", orderId: 45, clientOrderId: clientId, status: "FILLED", executedQty: "0.001", avgPrice: "10000.1" };
      state.orders.set(clientId, order);
      if (state.post === "unknown") return Response.json({ code: -1007, msg: "must never log raw API data" }, { status: 503 });
      return Response.json(order);
    }
    const order = state.orders.get(params.get(algo ? "clientAlgoId" : "origClientOrderId"));
    return order ? Response.json(order) : Response.json({ code: -2013 }, { status: 400 });
  }
  return { state, mockFetch, calls, objects };
};
async function start(t, override = {}) {
  const mock = makeMock();
  const logs = [];
  const server = makeServer({ env: { ...settings, ...override }, logger: { info: value => logs.push(value), error: value => logs.push(value) },
    now: () => mock.state.clock, model: async () => modelResult(), provider: provider(), orderFetch: mock.mockFetch });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = async (data, token, path = "/trade/api/signal/orders") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "X-JWT-Token": token } : {}) }, body: JSON.stringify(data) });
    return { http: response.status, data: await response.json() };
  };
  const analyze = (token = jwt()) => request({ symbol: "BTCUSDT" }, token, "/trade/api/signal/analyze");
  const preview = async () => {
    const { data } = await analyze();
    assert.ok(data.orderPermit);
    const result = await request({ action: "preview", permit: data.orderPermit }, readToken());
    assert.equal(result.http, 200, JSON.stringify(result.data));
    return result.data;
  };
  const submit = (option, token = submitToken(option.draft, mock.state.clock)) => request({ action: "submit", draft: option.draft }, token, "/orders");
  const query = (analysisId, subject) => request({ action: "status", analysisId }, readToken(subject));
  return { ...mock, analyze, request, preview, submit, query, logs };
}
const posts = app => app.calls.filter(call => call.method === "POST" && call.path.startsWith("/fapi/"));

test("analysis succeeds with feature disabled, incomplete configuration or an unverifiable order identity", async t => {
  for (const [settings, token] of [
    [{ SIGNAL_ORDER_MODE: "off" }, jwt()],
    [{ SIGNAL_ORDER_OSS_BUCKET: "" }, jwt()],
    [{}, jwt({ scope: "forged" })],
    [{}, jwt().replace(/\.[^.]+$/, ".forged")],
  ]) {
    const app = await start(t, settings);
    const result = await app.analyze(token);
    assert.equal(result.http, 200);
    assert.equal(result.data.orderPermit, undefined);
    assert.equal(result.data.status, "candidate");
    assert.deepEqual(app.calls, []);
  }
});

test("preview lists choices without signed Binance requests or storage writes, and check-only tickets cannot submit", async t => {
  const app = await start(t);
  const preview = await app.preview();
  assert.equal(preview.quantity, "0.001");
  assert.equal(preview.mode, "demo");
  const [market, limit, conditional] = preview.options;
  assert.deepEqual(preview.options.map(o => o.kind), ["market", "limit", "conditional"]);
  assert.equal(market.price, "10000.1");
  assert.equal(limit.price, "9990");
  assert.equal(conditional.triggerPrice, "10010");
  assert.ok(app.calls.every(call => call.method === "GET" && !call.params.has("signature")));
  assert.equal((await app.submit(market, readToken())).http, 401);
  assert.equal((await app.submit(market, submitToken(limit.draft))).http, 401);
  const tampered = { draft: market.draft.replace(/^./, "X") };
  assert.equal((await app.submit(tampered)).data.error.code, "INVALID_ORDER_DRAFT");
  const permit = (await app.analyze()).data.orderPermit;
  assert.equal((await app.request({ action: "preview", permit }, readToken("another-owner"))).http, 400);
  assert.deepEqual(posts(app), []);
});

test("concurrent confirmation of different choices can create only one Binance order", async t => {
  const app = await start(t);
  const preview = await app.preview();
  const results = await Promise.all(preview.options.map(option => app.submit(option)));
  const accepted = results.find(result => result.data.state === "accepted");
  assert.ok(accepted);
  assert.equal(results.filter(r => r.http === 409).length, 2);
  assert.equal(posts(app).length, 1);
  assert.equal((await app.submit(preview.options[0])).data.error.code, "ORDER_ALREADY_RESERVED");
  assert.equal((await app.query(preview.analysisId)).data.clientId, accepted.data.clientId);
  assert.equal((await app.query(preview.analysisId, "other-owner")).data.state, "not_recorded");
  assert.equal([...app.objects.keys()].filter(path => path.endsWith("/locks/btcusdt.json")).length, 0);
  assert.equal(posts(app)[0].params.get("positionSide"), "LONG");
  assert.equal(posts(app)[0].params.get("quantity"), "0.001");
  assert.equal(posts(app)[0].params.has("closePosition"), false);
});

test("a conditional uses the signed algo endpoint and market execution stays separate", async t => {
  const app = await start(t, { SIGNAL_ORDER_QUANTITY: "0.002" });
  const preview = await app.preview();
  const result = await app.submit(preview.options.find(option => option.kind === "conditional"));
  assert.equal(result.data.exchangeStatus, "NEW");
  const [call] = posts(app);
  assert.equal(call.path, "/fapi/v1/algoOrder");
  assert.equal(call.params.get("triggerPrice"), "10010");
  assert.equal(call.params.get("price"), "10010");
  assert.equal(call.params.get("workingType"), "MARK_PRICE");
  assert.equal(call.params.get("algoType"), "CONDITIONAL");
  assert.equal(call.params.get("timeInForce"), "GTC");
  assert.equal(call.params.get("quantity"), "0.002");
  assert.equal((await app.query(preview.analysisId)).data.exchangeStatus, "NEW");
});

test("failed prechecks never send orders and preserve analysis behavior", async t => {
  const scenarios = [
    [{ hedge: false }, "ORDER_HEDGE_MODE_REQUIRED"],
    [{ positions: [{ symbol: "BTCUSDT", positionAmt: "0.001" }] }, "ORDER_ACCOUNT_BUSY"],
    [{ markPrice: "10200" }, "ORDER_QUOTE_CHANGED"],
    [{ quoteAge: 5001 }, "ORDER_QUOTE_CHANGED"],
    [{ notional: "50" }, "ORDER_RULE_CHANGED"],
    [{ clock: NOW + 30000 }, "ORDER_DRAFT_EXPIRED"],
    [{ versioning: "<Status>Suspended</Status>" }, "ORDER_STORAGE_VERSIONING"],
    [{ failStoreWrite: true }, "ORDER_STORAGE_UNAVAILABLE"],
  ];
  for (const [update, expected] of scenarios) {
    const app = await start(t);
    const preview = await app.preview();
    Object.assign(app.state, update);
    const result = await app.submit(preview.options[0]);
    assert.equal(result.data.error?.code, expected, JSON.stringify(result));
    assert.deepEqual(posts(app), []);
    assert.equal((await app.analyze()).http, 200);
  }
});

test("ambiguous transmission leaves an OSS lock and status queries can find the accepted order without reposting", async t => {
  const app = await start(t);
  const preview = await app.preview();
  app.state.post = "unknown";
  const first = await app.submit(preview.options[0]);
  assert.equal(first.data.state, "unknown");
  assert.equal(first.data.exchangeCode, -1007);
  assert.equal(first.data.reconciliationRequired, true);
  assert.equal((await app.query(preview.analysisId)).data.exchangeStatus, "FILLED");
  const next = await app.preview();
  assert.equal((await app.submit(next.options[0])).data.error.code, "ORDER_SUBMISSION_LOCKED");
  assert.equal(posts(app).length, 1);
  assert.doesNotMatch(app.logs.join(""), /test-binance|test-oss|must never log/);
});

test("explicit rejection is durable and does not block another analysis", async t => {
  const app = await start(t);
  app.state.post = "rejected";
  const preview = await app.preview();
  assert.equal((await app.submit(preview.options[0])).data.state, "rejected");
  assert.equal((await app.query(preview.analysisId)).data.exchangeCode, -2019);
  const next = await app.preview();
  app.state.post = "accepted";
  assert.equal((await app.submit(next.options[0])).data.exchangeStatus, "FILLED");
});
