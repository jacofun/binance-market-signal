import test from "node:test";
import assert from "node:assert/strict";
import { makeAuthorizer } from "../build/auth.js";
import { loadConfig } from "../build/config.js";
import { env, jwk, jwt, NOW } from "./fixtures.mjs";

test("signal JWT checks issuer, distinct audience/scope, expiry and signatures", () => {
  const auth = makeAuthorizer(env);
  assert.equal(auth(jwt(), NOW / 1000), "owner");
  for (const delta of [{ aud: "binance-trade-sync" }, { scope: "trading:sync" }, { iss: "https://evil.test" }, { exp: NOW / 1000 }, { exp: NOW / 1000 + 121 }, { iat: NOW / 1000 + 6 }, { nbf: NOW / 1000 + 1 }, { sub: "" }, { jti: "" }]) {
    assert.throws(() => auth(jwt(delta), NOW / 1000), { code: "UNAUTHORIZED" });
  }
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { kid: "other" }, { jku: "https://evil.test" }, { crit: [] }]) {
    assert.throws(() => auth(jwt({}, header), NOW / 1000), { code: "UNAUTHORIZED" });
  }
  for (const value of [undefined, "Basic abc", jwt() + "=", jwt() + ", extra", jwt().slice(0, -6) + "broken"]) assert.throws(() => auth(value, NOW / 1000), { code: "UNAUTHORIZED" });
});
test("missing/private/duplicate public keys fail closed without logging secrets", () => {
  for (const keys of [[], [jwk, jwk], [{ ...jwk, d: "private-material" }]]) {
    assert.throws(() => makeAuthorizer({ SIGNAL_JWT_JWKS: JSON.stringify({ keys }) })(jwt(), NOW / 1000), { code: "JWT_NOT_CONFIGURED" });
  }
  assert.throws(() => makeAuthorizer({})(jwt(), NOW / 1000), { code: "JWT_NOT_CONFIGURED" });
});
test("model destination is confined to trusted Bailian endpoints and configuration is bounded", () => {
  assert.equal(loadConfig(env).model, "qwen-plus");
  for (const url of ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://workspace123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/"]) {
    assert.ok(loadConfig({ ...env, DASHSCOPE_BASE_URL: url }).endpoint.endsWith("/chat/completions"));
  }
  for (const delta of [{ DASHSCOPE_BASE_URL: "http://dashscope.aliyuncs.com/compatible-mode/v1" }, { DASHSCOPE_BASE_URL: "https://evil.test/compatible-mode/v1" }, { DASHSCOPE_BASE_URL: "https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1" }, { DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1?token=secret" }, { DASHSCOPE_API_KEY: "" }, { SIGNAL_ALLOWED_SYMBOLS: "BTCUSDT,BTCUSDT" }, { SIGNAL_REQUEST_TIMEOUT_MS: "999999" }, { MARKET_DATA_MODE: "websocket" }]) assert.throws(() => loadConfig({ ...env, ...delta }));
  assert.equal(loadConfig({ ...env, MARKET_DATA_MODE: "websocket", CONTINUOUS_WORKER: "true" }).mode, "websocket");
});
