import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { orderOption } from "../build/order-rules.js";
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
function symbolRules(notional = "5", tickSize = "0.1") {
  return { symbols: [{
    symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
    orderTypes: ["MARKET", "LIMIT", "STOP"], timeInForce: ["GTC", "GTX"],
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize },
      { filterType: "LOT_SIZE", ...grid }, { filterType: "MARKET_LOT_SIZE", ...grid },
      { filterType: "MIN_NOTIONAL", notional }, { filterType: "PERCENT_PRICE", multiplierUp: "1.1", multiplierDown: "0.9" },
    ],
  }] };
}
const ossHeader = { "x-oss-request-id": "test-object-request-id" };
const makeMock = () => {
  const objects = new Map();
  const calls = [];
  const state = { clock: NOW, markPrice: "10000", notional: "5", quoteAge: 0, tickSize: "0.1", orders: new Map() };
  async function mockFetch(url, options) {
    const u = new URL(url);
    const { headers, method } = options;
    calls.push({ host: u.hostname, path: u.pathname, method, params: u.searchParams });
    assert.equal(method, "GET");
    assert.equal(options.redirect, "error");
    if (u.hostname.endsWith(".aliyuncs.com")) {
      assert.equal(u.hostname, "orders-bucket.oss-cn-hangzhou.aliyuncs.com");
      assert.match(headers.authorization, /^OSS4-HMAC-SHA256 Credential=test-oss-key\/20261118\/cn-hangzhou\/oss\/aliyun_v4_request,Signature=[a-f0-9]{64}$/);
      return objects.has(u.pathname) ? Response.json(objects.get(u.pathname), { headers: ossHeader }) :
        new Response(null, { status: 404, headers: ossHeader });
    }
    assert.ok(["demo-fapi.binance.com", "fapi.binance.com"].includes(u.hostname));
    const params = calls.at(-1).params;
    if (headers["X-MBX-APIKEY"]) {
      assert.equal(headers["X-MBX-APIKEY"], settings.BINANCE_API_KEY);
      assert.equal(params.get("recvWindow"), "3000");
      const signed = new URLSearchParams(params);
      const signature = signed.get("signature");
      signed.delete("signature");
      assert.equal(createHmac("sha256", settings.BINANCE_API_SECRET).update(signed.toString()).digest("hex"), signature);
    }
    if (u.pathname.endsWith("/exchangeInfo")) return Response.json(symbolRules(state.notional, state.tickSize));
    if (u.pathname.endsWith("/premiumIndex")) return Response.json({ symbol: "BTCUSDT", markPrice: state.markPrice, time: state.clock - state.quoteAge });
    if (u.pathname.endsWith("/bookTicker")) return Response.json({ symbol: "BTCUSDT", bidPrice: "9999.9", askPrice: "10000.1",
      askQty: "0.50", bidQty: "0.50", time: state.clock - state.quoteAge });
    const algo = u.pathname.endsWith("/algoOrder");
    assert.ok(algo || u.pathname.endsWith("/order"));
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
  const submit = (draft, token = submitToken(draft, mock.state.clock), route = "/orders") => request({ action: "submit", draft }, token, route);
  const query = (analysisId, subject) => request({ action: "status", analysisId }, readToken(subject));
  return { ...mock, analyze, request, preview, submit, query, logs };
}


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

test("candidate previews fix both protective levels and issue no executable draft", async t => {
  const app = await start(t);
  const preview = await app.preview();
  assert.equal(preview.quantity, "0.001");
  assert.equal(preview.mode, "demo");
  assert.deepEqual(preview.options.map(o => [o.kind, o.price, o.triggerPrice]), [
    ["market", "10000.1", undefined], ["limit", "9990", undefined], ["conditional", "10010", "10010"],
  ]);
  for (const option of preview.options) {
    assert.equal(option.stopLossPrice, "9900");
    assert.equal(option.takeProfitPrice, "10200");
    assert.equal(option.draft, undefined);
  }
  assert.equal(preview.submission.state, "blocked");
  assert.equal(preview.submission.code, "ORDER_PROTECTION_UNAVAILABLE");
  assert.ok(app.calls.every(call => call.method === "GET" && !call.params.has("signature")));
  const permit = (await app.analyze()).data.orderPermit;
  assert.equal((await app.request({ action: "preview", permit }, readToken("another-owner"))).http, 400);
});

test("valid legacy submission tickets are blocked in both modes and route aliases before touching OSS or Binance", async t => {
  const oldDraft = `legacy.${"a".repeat(43)}`;
  for (const override of [{}, { SIGNAL_ORDER_MODE: "live", BINANCE_BASE_URL: "https://fapi.binance.com" }]) {
    const app = await start(t, override);
    assert.equal((await app.submit(oldDraft, readToken())).http, 401);
    assert.equal((await app.submit(oldDraft, submitToken(oldDraft + "x"))).http, 401);
    const results = await Promise.all(["/orders", "/trade/api/signal/orders"].map(route =>
      app.submit(oldDraft, submitToken(oldDraft), route)));
    for (const result of results) {
      assert.equal(result.http, 409);
      assert.equal(result.data.error.code, "ORDER_PROTECTION_UNAVAILABLE");
    }
    assert.equal((await app.analyze()).http, 200);
    assert.deepEqual(app.calls, []);
    assert.equal(app.objects.size, 0);
  }
});

test("invalid protective ticks, filters and stale quotes still fail preview without mutating exchange state", async t => {
  const app = await start(t);
  const permit = (await app.analyze()).data.orderPermit;
  const preview = () => app.request({ action: "preview", permit }, readToken());
  app.state.tickSize = "7";
  const offTick = await preview();
  assert.deepEqual(offTick.data.options, []);
  assert.match(offTick.data.unavailable.market, /止盈或止损价格/);
  app.state.tickSize = "0.1";
  app.state.notional = "50";
  const lowNotional = await preview();
  assert.deepEqual(lowNotional.data.options, []);
  assert.match(lowNotional.data.unavailable.market, /名义金额/);
  app.state.quoteAge = 5001;
  assert.equal((await preview()).data.error.code, "ORDER_QUOTE_CHANGED");
  assert.ok(app.calls.every(call => call.method === "GET"));
});

test("protective levels must straddle the actual preview entry for both directions", () => {
  const quote = { mark: "10000", bid: "9999.9", ask: "10000.1", bidQty: "1", askQty: "1" };
  const lot = { min: "0.001", max: "20", step: "0.001" };
  const rules = { kinds: ["MARKET", "LIMIT", "STOP"], times: ["GTX", "GTC"], lot, marketLot: lot,
    price: { min: "1", max: "1000000", step: "0.1" }, notional: "5", multiplierUp: "1.1", multiplierDown: "0.9" };
  const config = { quantity: "0.001", maxRisk: 1 };
  const plan = { status: "candidate", min: 9990, max: 10010 };
  assert.equal(orderOption("market", { ...plan, direction: "short", stop: 10100, target: 9800 }, quote, rules, config).takeProfitPrice, "9800");
  assert.match(orderOption("market", { ...plan, direction: "long", stop: 9900, target: 10000.1 }, quote, rules, config), /两侧/);
  assert.match(orderOption("market", { ...plan, direction: "short", stop: 9999.8, target: 9800 }, quote, rules, config), /两侧/);
  assert.match(orderOption("conditional", { ...plan, direction: "long", stop: 9900, target: 10009 }, quote, rules, config), /两侧/);
});

test("legacy accepted, uncertain and rejected records remain readable only by their owner", async t => {
  const app = await start(t);
  const preview = await app.preview();
  const key = `/private/market-signal-orders/v1/demo/attempts/${digest("owner")}/${preview.analysisId}`;
  const clientId = "legacy-entry-id";
  app.objects.set(`${key}/intent.json`, { kind: "market", clientId });
  app.objects.set(`${key}/result.json`, { state: "unknown", checkedAt: NOW, exchangeCode: -1007 });
  const pending = await app.query(preview.analysisId);
  assert.equal(pending.data.state, "unknown");
  assert.equal(pending.data.lookupUnavailable, true);
  app.state.orders.set(clientId, { symbol: "BTCUSDT", orderId: 45, clientOrderId: clientId,
    status: "FILLED", executedQty: "0.001", avgPrice: "10000.1" });
  assert.equal((await app.query(preview.analysisId)).data.exchangeStatus, "FILLED");
  assert.equal((await app.query(preview.analysisId, "other-owner")).data.state, "not_recorded");
  app.objects.set(`${key}/result.json`, { state: "rejected", checkedAt: NOW, exchangeCode: -2019 });
  assert.equal((await app.query(preview.analysisId)).data.exchangeCode, -2019);
  assert.ok(app.calls.every(call => call.method === "GET"));
  assert.doesNotMatch(app.logs.join(""), /test-binance|test-oss/);
});
