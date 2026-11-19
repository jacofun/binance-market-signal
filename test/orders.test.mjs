import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, verify } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { loadOrderConfig } from "../build/order-auth.js";
import { loadOssConfig } from "../build/oss-config.js";
import { orderOption } from "../build/order-rules.js";
import { makeServer } from "../build/server.js";
import { env, jwt, NOW, provider, modelResult, publicKey } from "./fixtures.mjs";

const settings = {
  ...env, SIGNAL_ORDER_MODE: "demo", BINANCE_BASE_URL: "https://demo-fapi.binance.com",
  BINANCE_API_KEY: "test-binance-apikey", BINANCE_API_SECRET: "test-binance-secret",
  ACCESS_KEY_ID: "test-oss-key", ACCESS_KEY_SECRET: "test-oss-secret-123",
  OSS_BUCKET: "orders-bucket", OSS_REGION: "cn-hangzhou",
};
const digest = text => createHash("sha256").update(text).digest("hex");
const readToken = (sub = "owner", at = NOW) => jwt({ scope: "trading:orders:read", sub,
  iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 120 });
const submitToken = (draft, at = NOW) => jwt({ scope: "trading:orders:submit-protected",
  iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 30, intent: digest(draft) });
function verifiedByMockFc(token) {
  const [header, claims, signature] = (token || "").replace(/^Bearer /, "").split(".");
  return Boolean(signature && verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
}
const grid = { minQty: "0.001", maxQty: "20", stepSize: "0.001" };
function symbolRules(notional = "5", tickSize = "0.1") {
  return { symbols: [{
    symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
    orderTypes: ["MARKET", "LIMIT", "STOP", "STOP_MARKET", "TAKE_PROFIT_MARKET"], timeInForce: ["GTC", "GTX"],
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
  const state = { clock: NOW, markPrice: "10000", notional: "5", quoteAge: 0, tickSize: "0.1", orders: new Map(),
    positions: [], entryQty: "0.001", entryStatus: "FILLED", entryFault: "", stopFault: "", targetFault: "", versioning: "", failIntent: false, failTemporary: false };
  async function mockFetch(url, options) {
    const u = new URL(url);
    const { headers, method } = options;
    calls.push({ host: u.hostname, path: u.pathname, method, params: method === "POST" ? new URLSearchParams(options.body) : u.searchParams });
    assert.equal(options.redirect, "error");
    if (u.hostname.endsWith(".aliyuncs.com")) {
      assert.equal(u.hostname, "orders-bucket.oss-cn-hangzhou.aliyuncs.com");
      assert.match(headers.authorization, /^OSS4-HMAC-SHA256 Credential=test-oss-key\/20261118\/cn-hangzhou\/oss\/aliyun_v4_request,Signature=[a-f0-9]{64}$/);
      if (u.search === "?versioning") return new Response(`<VersioningConfiguration>${state.versioning}</VersioningConfiguration>`);
      if (method === "PUT") {
        if (state.failIntent && u.pathname.endsWith("/intent.json")) return new Response(null, { status: 503, headers: ossHeader });
        if (state.failTemporary && u.pathname.includes("/temporary/")) return new Response(null, { status: 503, headers: ossHeader });
        if (headers["x-oss-forbid-overwrite"] === "true" && objects.has(u.pathname)) return new Response(null, { status: 409, headers: ossHeader });
        objects.set(u.pathname, JSON.parse(options.body));
        return new Response(null);
      }
      if (method === "DELETE") {
        assert.match(u.pathname, /locks\/btcusdt\.json$/);
        objects.delete(u.pathname);
        return new Response(null, { status: 204 });
      }
      assert.equal(method, "GET");
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
    if (u.pathname.endsWith("/dual")) return Response.json({ dualSidePosition: true });
    if (u.pathname.endsWith("/positionRisk")) return Response.json(state.positions);
    if (u.pathname.endsWith("/openOrders") || u.pathname.endsWith("/openAlgoOrders")) return Response.json([]);
    const algo = u.pathname.endsWith("/algoOrder");
    assert.ok(algo || u.pathname.endsWith("/order"));
    if (method === "POST") {
      if (algo) {
        const clientAlgoId = params.get("clientAlgoId");
        const fault = params.get("type") === "STOP_MARKET" ? state.stopFault : state.targetFault;
        if (fault === "rejected") return Response.json({ code: -2021 }, { status: 400 });
        const order = { symbol: "BTCUSDT", algoId: 52, clientAlgoId, algoStatus: "NEW", orderType: params.get("type"),
          positionSide: params.get("positionSide"), side: params.get("side"), workingType: params.get("workingType"),
          closePosition: params.get("closePosition") === "true", triggerPrice: params.get("triggerPrice") };
        state.orders.set(clientAlgoId, order);
        if (fault === "unknown") return Response.json({ code: -1007 }, { status: 503 });
        return Response.json(order);
      }
      if (state.entryFault === "rejected") return Response.json({ code: -2019 }, { status: 400 });
      const clientOrderId = params.get("newClientOrderId");
      const entry = { symbol: "BTCUSDT", orderId: 45, clientOrderId, status: state.entryStatus,
        positionSide: params.get("positionSide"), side: params.get("side"), executedQty: state.entryQty, avgPrice: "10000.1" };
      state.orders.set(clientOrderId, entry);
      if (Number(state.entryQty)) state.positions = [{ symbol: "BTCUSDT", positionSide: entry.positionSide,
        positionAmt: entry.positionSide === "SHORT" ? "-" + state.entryQty : state.entryQty }];
      if (state.entryFault === "unknown") return Response.json({ code: -1007 }, { status: 503 });
      return Response.json(entry);
    }
    if (method === "DELETE") {
      const pending = state.orders.get(params.get("clientAlgoId"));
      assert.equal(pending.algoStatus, "NEW");
      pending.algoStatus = "CANCELED";
      return Response.json({ code: "200" });
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
  const request = async (data, token, path = "/trade/api/signal/orders", extraHeaders = {}) => {
    if (path !== "/invoke" && !verifiedByMockFc(token)) return { http: 401, data: { error: { code: "FC_JWT_REJECTED" } } };
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "X-JWT-Token": token } : {}), ...extraHeaders }, body: JSON.stringify(data) });
    return { http: response.status, data: await response.json() };
  };
  const directOrder = async (data, token) => {
    // Fetch can override Host. Use the HTTP client to model the gateway's raw request.
    const req = httpRequest(`http://127.0.0.1:${server.address().port}/orders`, { method: "POST",
      headers: { Host: "default.ap-southeast-1.fcapp.run", "X-JWT-Token": token, "content-type": "application/json" } });
    req.end(JSON.stringify(data));
    const [response] = await once(req, "response");
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return { http: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) };
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
  const query = (analysisId, subject) => request({ action: "status", analysisId }, readToken(subject, mock.state.clock));
  const recover = (triggerTime = new Date(mock.state.clock).toISOString(), controlPath = "/invoke") =>
    request({ triggerName: "market-order-protection", triggerTime }, undefined, "/invoke",
      { "x-fc-request-id": "fc-test", "x-fc-control-path": controlPath });
  return { ...mock, analyze, request, preview, submit, query, logs, recover, directOrder };
}


test("analysis succeeds with orders disabled, incomplete configuration or a non-order research scope", async t => {
  for (const [settings, token] of [
    [{ SIGNAL_ORDER_MODE: "off" }, jwt()],
    [{ OSS_BUCKET: "" }, jwt()],
    [{}, jwt({ scope: "forged" })],
  ]) {
    const app = await start(t, settings);
    const result = await app.analyze(token);
    assert.equal(result.http, 200);
    assert.equal(result.data.orderPermit, undefined);
    assert.equal(result.data.status, "candidate");
    assert.deepEqual(app.calls, []);
  }
});

test("FC verifies signatures and order routes still require exact claims and scope", async t => {
  const app = await start(t);
  const action = { action: "status", analysisId: "db5b5377-aa3f-4ea2-8558-3797632181cd" };
  const forged = readToken().replace(/\.[^.]+$/, ".forged");
  assert.equal((await app.request(action, forged)).data.error.code, "FC_JWT_REJECTED");
  for (const delta of [{ scope: "trading:sync" }, { scope: "trading:orders:read", iat: NOW / 1000 - 1 },
    { scope: "trading:orders:read", iss: "https://another.example" }, { scope: "trading:orders:read", aud: "other" },
    { scope: "trading:orders:read", exp: NOW / 1000 }]) {
    assert.equal((await app.request(action, jwt(delta))).data.error.code, "ORDER_UNAUTHORIZED");
  }
  assert.equal((await app.request(action, readToken(), "/invoke", { "x-fc-request-id": "ram-test" })).http, 404);
  assert.equal((await app.request(action, undefined, "/invoke", { "x-fc-request-id": "ram-test" })).http, 401);
  assert.equal((await app.directOrder(action, readToken())).data.error.code, "CUSTOM_DOMAIN_REQUIRED");
  assert.deepEqual(app.calls, []);
});

test("orders use opaque, owner-bound OSS references and research survives an OSS write error", async t => {
  const app = await start(t);
  const { data: analysis } = await app.analyze();
  const permit = analysis.orderPermit;
  assert.match(permit, /^v3\.[A-Za-z0-9_-]{43}$/);
  const key = [...app.objects.keys()].find(p => p.endsWith(`/research/${digest(permit)}.json`));
  assert.equal(app.objects.get(key).id, analysis.analysisId);
  assert.equal(app.objects.get(key).owner, digest("owner"));
  assert.equal((await app.request({ action: "preview", permit }, readToken("another"))).http, 400);

  app.state.clock = analysis.timing.validUntil + 1;
  const expired = await app.request({ action: "preview", permit }, readToken("owner", app.state.clock));
  assert.equal(expired.data.error.code, "ORDER_DRAFT_EXPIRED");
  app.state.clock = NOW;
  app.state.failTemporary = true;
  const { http, data } = await app.analyze();
  assert.equal(http, 200);
  assert.equal(data.orderPermit, undefined);
  assert.ok(app.logs.some(line => line.includes("order_permit_unavailable") && line.includes("ORDER_STORAGE_UNAVAILABLE")));
  assert.deepEqual(mutations(app), []);
});

test("scanner and orders share one bucket and preserve existing order storage across an upgrade", () => {
  const shared = { ...settings, OSS_BUCKET: "", OSS_REGION: "", SIGNAL_ORDER_OSS_BUCKET: "orders-bucket",
    SIGNAL_ORDER_OSS_REGION: "cn-hangzhou", SIGNAL_SCANNER_OSS_BUCKET: "old-scans", SIGNAL_SCANNER_OSS_REGION: "cn-beijing" };
  for (const values of [shared, { ...shared, OSS_BUCKET: "orders-bucket", OSS_REGION: "cn-hangzhou", OSS_NETWORK: "internal" }]) {
    const order = loadOrderConfig(values);
    const scanner = loadOssConfig(values, "SCAN");
    assert.equal(order.bucket, "orders-bucket");
    assert.equal(order.prefix, "private/market-signal-orders/v1/demo");
    assert.equal(order.ossHost, scanner.ossHost);
  }
  const legacyScanner = { ...shared, SIGNAL_ORDER_OSS_BUCKET: "", SIGNAL_ORDER_OSS_REGION: "" };
  assert.equal(loadOrderConfig(legacyScanner).bucket, "old-scans");
  assert.throws(() => loadOssConfig({ ...shared, OSS_BUCKET: "private-value" }, "SCAN"),
    { code: "SCAN_STORAGE_CONFIGURATION", configurationField: "OSS_REGION" });
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
  assert.ok(app.calls.filter(call => call.path.startsWith("/fapi/")).every(call => call.method === "GET" && !call.params.has("signature")));
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
      assert.equal(result.http, 400);
      assert.equal(result.data.error.code, "INVALID_ORDER_DRAFT");
    }
    assert.deepEqual(app.calls, []);
    assert.equal(app.objects.size, 0);
    assert.equal((await app.analyze()).http, 200);
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
  assert.ok(app.calls.filter(call => call.path.startsWith("/fapi/")).every(call => call.method === "GET"));
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
  assert.ok(app.calls.filter(call => call.path.startsWith("/fapi/")).every(call => call.method === "GET"));
  assert.doesNotMatch(app.logs.join(""), /test-binance|test-oss/);
});

const mutations = app => app.calls.filter(call => call.path.startsWith("/fapi/") && call.method !== "GET");
const entryDraft = preview => preview.options.find(option => option.kind === "market").draft;

async function executionFixture(t) {
  const app = await start(t, { SIGNAL_ORDER_EXECUTE: "true" });
  assert.equal((await app.recover(undefined, "/http-invoke")).http, 401);
  assert.equal((await app.recover("not-a-time")).data.error.code, "INVALID_ORDER_RECOVERY_TIMER");
  assert.equal(app.calls.length, 0);
  assert.equal((await app.preview()).submission.state, "blocked");
  assert.equal((await app.recover()).http, 200);
  const preview = await app.preview();
  assert.equal(preview.submission.state, "enabled");
  assert.ok(entryDraft(preview));
  assert.ok(preview.options.filter(option => option.kind !== "market").every(option => option.draft === undefined));
  return { app, preview, draft: entryDraft(preview) };
}

test("owner-confirmed entry runs once and attaches stop then take profit to the confirmed partial fill", async t => {
  const { app, preview, draft } = await executionFixture(t);
  assert.equal((await app.submit(draft, jwt({ scope: "trading:orders:submit", exp: NOW / 1000 + 30, intent: digest(draft) }))).http, 401);
  assert.equal((await app.submit(draft, readToken())).http, 401);
  const badReference = draft.replace(/^v3\.[A-Za-z0-9_-]/, draft.startsWith("v3.A") ? "v3.B" : "v3.A");
  assert.equal((await app.submit(badReference)).data.error.code, "INVALID_ORDER_DRAFT");
  app.state.entryQty = "0.0005";
  app.state.entryStatus = "EXPIRED";
  const responses = await Promise.all([app.submit(draft), app.submit(draft)]);
  const settled = responses.find(r => r.http === 200);
  assert.equal(settled.data.executedQty, "0.0005");
  assert.equal(settled.data.protection.state, "active");
  assert.equal(responses.filter(r => r.http === 409).length, 1);
  const calls = mutations(app);
  assert.deepEqual(calls.map(call => call.params.get("type")), ["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"]);
  assert.equal(calls[0].params.get("quantity"), "0.001");
  assert.equal(calls[0].params.get("side"), "BUY");
  assert.deepEqual(calls.slice(1).map(call => call.params.get("triggerPrice")), ["9900", "10200"]);
  for (const call of calls.slice(1)) {
    assert.equal(call.path, "/fapi/v1/algoOrder");
    assert.equal(call.params.get("workingType"), "MARK_PRICE");
    assert.equal(call.params.get("positionSide"), "LONG");
    assert.equal(call.params.get("side"), "SELL");
    assert.equal(call.params.get("closePosition"), "true");
    assert.equal(call.params.has("quantity"), false);
    assert.equal(call.params.has("reduceOnly"), false);
  }
  assert.equal((await app.query(preview.analysisId)).data.protection.state, "active");
});

test("uncertain entry survives a later timer tick without resending the entry", async t => {
  const { app, draft } = await executionFixture(t);
  app.state.entryFault = "unknown";
  assert.equal((await app.submit(draft)).data.protection.state, "pending");
  assert.equal(mutations(app).length, 1);
  app.state.clock = NOW + 60000;
  const recoveries = await Promise.all([app.recover(), app.recover()]);
  assert.ok(recoveries.every(recovered => recovered.http === 200), JSON.stringify(recoveries));
  assert.equal(recoveries.filter(recovered => recovered.data.protection?.state === "active").length, 1);
  assert.equal(recoveries.filter(recovered => recovered.data.reason === "recovery_slot_busy").length, 1);
  assert.deepEqual(mutations(app).map(call => call.params.get("type")), ["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"]);
});

test("a timed-out stop is queried before attaching the missing target", async t => {
  const { app, draft } = await executionFixture(t);
  app.state.stopFault = "unknown";
  const sent = await app.submit(draft);
  assert.equal(sent.data.protection.state, "attention");
  assert.equal(mutations(app).length, 2);
  app.state.clock = NOW + 60000;
  const repaired = await app.recover();
  assert.equal(repaired.data.protection.state, "active");
  assert.equal(mutations(app).filter(call => call.params.get("type") === "STOP_MARKET").length, 1);
});

test("when take profit is rejected, a retry retains the existing stop and later cleans the sibling after exit", async t => {
  const { app, draft } = await executionFixture(t);
  app.state.targetFault = "rejected";
  const sent = await app.submit(draft);
  assert.equal(sent.data.protection.state, "attention");
  assert.equal(sent.data.protection.stop.exchangeStatus, "NEW");
  assert.equal(sent.data.protection.target.exchangeStatus, null);
  app.state.targetFault = "";
  app.state.clock = NOW + 60000;
  const repaired = await app.recover();
  assert.equal(repaired.data.protection.state, "active");
  const stopId = repaired.data.protection.stop.clientId;
  const targetId = repaired.data.protection.target.clientId;
  app.state.orders.get(stopId).algoStatus = "FINISHED";
  app.state.positions = [];
  app.state.clock = NOW + 120000;
  const closed = await app.recover();
  assert.equal(closed.data.protection.state, "closed");
  assert.equal(app.state.orders.get(targetId).algoStatus, "CANCELED");
  assert.equal(app.objects.has("/private/market-signal-orders/v1/demo/locks/btcusdt.json"), false);
  assert.equal(mutations(app).filter(call => call.params.get("type") === "STOP_MARKET").length, 1);
});

test("a rejected entry, known zero fill, stale heartbeat and failed persistence never dispatch exit orders", async t => {
  const rejected = await executionFixture(t);
  rejected.app.state.entryFault = "rejected";
  assert.equal((await rejected.app.submit(rejected.draft)).data.protection.state, "not_required");
  assert.equal(mutations(rejected.app).length, 1);
  const unfilled = await executionFixture(t);
  Object.assign(unfilled.app.state, { entryQty: "0", entryStatus: "EXPIRED" });
  assert.equal((await unfilled.app.submit(unfilled.draft)).data.protection.state, "not_required");
  assert.equal(mutations(unfilled.app).length, 1);
  const stale = await executionFixture(t);
  stale.app.state.clock = NOW + 91000;
  assert.equal((await stale.app.submit(stale.draft)).data.error.code, "ORDER_RECOVERY_NOT_READY");
  assert.deepEqual(mutations(stale.app), []);
  const storage = await executionFixture(t);
  storage.app.state.failIntent = true;
  assert.equal((await storage.app.submit(storage.draft)).data.error.code, "ORDER_STORAGE_UNAVAILABLE");
  assert.deepEqual(mutations(storage.app), []);
  storage.app.state.clock = NOW + 60000;
  storage.app.state.failIntent = false;
  assert.equal((await storage.app.recover()).data.reason, "entry_never_reserved");
  assert.deepEqual(mutations(storage.app), []);
});
