import test from "node:test";
import assert from "node:assert/strict";
import { makeAuthorizer } from "../build/auth.js";
import { loadConfig } from "../build/config.js";
import { env, jwt, NOW } from "./fixtures.mjs";

test("FC-only authorizer accepts the existing shared sync ticket without JWT environment settings", () => {
  const auth = makeAuthorizer();
  assert.equal(auth(jwt(), NOW / 1000), "owner");
  // FC owns issuer/audience/scope policy. No per-function override is applied.
  assert.equal(auth(jwt({ aud: "shared-domain", scope: "trading:sync" }), NOW / 1000), "owner");
  for (const value of [undefined, "Basic abc", "Bearer malformed", jwt() + ", extra", jwt({ sub: "" }), jwt({ exp: NOW / 1000 })]) {
    assert.throws(() => auth(value, NOW / 1000), { code: "UNAUTHORIZED" });
  }
});

test("model destination is confined to trusted Bailian endpoints and configuration is bounded", () => {
  assert.equal(loadConfig(env).model, "qwen-plus");
  for (const url of ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://workspace123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/"]) {
    assert.ok(loadConfig({ ...env, DASHSCOPE_BASE_URL: url }).endpoint.endsWith("/chat/completions"));
  }
  for (const delta of [{ DASHSCOPE_BASE_URL: "http://dashscope.aliyuncs.com/compatible-mode/v1" }, { DASHSCOPE_BASE_URL: "https://evil.test/compatible-mode/v1" }, { DASHSCOPE_BASE_URL: "https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1" }, { DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1?token=secret" }, { DASHSCOPE_API_KEY: "" }, { SIGNAL_ALLOWED_SYMBOLS: "BTCUSDT,BTCUSDT" }, { SIGNAL_REQUEST_TIMEOUT_MS: "999999" }, { MARKET_DATA_MODE: "websocket" }]) assert.throws(() => loadConfig({ ...env, ...delta }));
  assert.equal(loadConfig({ ...env, MARKET_DATA_MODE: "websocket", CONTINUOUS_WORKER: "true" }).mode, "websocket");
});
