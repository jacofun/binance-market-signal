import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithModel, validateProposal } from "../build/model.js";
import { analyze } from "../build/analysis.js";
import { loadConfig } from "../build/config.js";
import { env, NOW, snapshot, proposal, modelResult, provider, quote } from "./fixtures.mjs";

test("model JSON is validated beyond syntax, and invented metrics/confidence are rejected", () => {
  assert.equal(validateProposal(proposal(), snapshot()).direction, "long");
  for (const delta of [{ confidence: 0.99 }, { stopLoss: 11000 }, { entry: { min: 11000, max: 10000 } }, { targets: [{ price: 9800, reason: "wrong" }] }, { evidence: [{ metric: "news", reason: "invented" }] }, { evidence: [{ metric: "openInterest", reason: "absent" }] }, { counterarguments: [] }, { validForSeconds: 9999 }]) assert.throws(() => validateProposal(proposal(delta), snapshot()), { code: "INVALID_MODEL_OUTPUT" });
  const none = proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [] });
  assert.equal(validateProposal(none, snapshot()).status, "none");
  assert.throws(() => validateProposal({ ...none, direction: "long" }, snapshot()));
});
test("Bailian request disables thinking, asks for JSON, and never retries errors", async () => {
  let calls = 0;
  const config = loadConfig(env);
  const request = async (url, options) => {
    calls++;
    assert.equal(url, config.endpoint); assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.enable_thinking, false); assert.equal(body.stream, false); assert.equal(body.response_format.type, "json_object");
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(proposal()) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } }));
  };
  assert.equal((await analyzeWithModel(config, snapshot(), "trend", AbortSignal.timeout(1000), request)).usage.outputTokens, 200);
  assert.equal(calls, 1);
  for (const status of [401, 429, 500]) {
    let n = 0;
    await assert.rejects(analyzeWithModel(config, snapshot(), "trend", AbortSignal.timeout(1000), async () => { n++; return new Response("private model secret", { status }); }), error => !error.message.includes("secret"));
    assert.equal(n, 1);
  }
});
test("truncated or malformed model responses never become opportunities", async () => {
  for (const payload of [{ choices: [{ finish_reason: "length", message: { content: JSON.stringify(proposal()) } }] }, { choices: [{ finish_reason: "stop", message: { content: "```json invalid```" } }] }]) {
    await assert.rejects(analyzeWithModel(loadConfig(env), snapshot(), "trend", AbortSignal.timeout(1000), async () => new Response(JSON.stringify(payload))), { code: "INVALID_MODEL_OUTPUT" });
  }
});
test("fresh price is fetched after the model; drift, expiry and crossed prices invalidate the proposal", async () => {
  const config = loadConfig(env);
  const events = [];
  const market = provider({ snapshot: async () => { events.push("snapshot"); return snapshot(); }, quote: async () => { events.push("final-price"); return quote(); } });
  const result = await analyze(config, market, "BTCUSDT", "trend", AbortSignal.timeout(1000), async () => { events.push("model"); return modelResult(); }, () => NOW);
  assert.deepEqual(events, ["snapshot", "model", "final-price"]);
  assert.equal(result.status, "candidate"); assert.equal(result.opportunity.triggerVerified, false); assert.equal(result.opportunity.rewardRisk[0].ratio, 190 / 110);
  const drifted = await analyze(config, provider({ quote: async () => quote({ price: 10100 }) }), "BTCUSDT", "trend", AbortSignal.timeout(1000), async () => modelResult(), () => NOW);
  assert.equal(drifted.status, "expired");
  const outOfRange = await analyze(config, provider({ quote: async () => quote({ price: 10020 }) }), "BTCUSDT", "trend", AbortSignal.timeout(1000), async () => modelResult(), () => NOW);
  assert.equal(outOfRange.status, "watch");
  let time = NOW;
  const expired = await analyze(config, provider({ quote: async () => quote({ time }) }), "BTCUSDT", "trend", AbortSignal.timeout(1000), async () => { time += 61000; return modelResult(); }, () => time);
  assert.equal(expired.status, "expired");
});
