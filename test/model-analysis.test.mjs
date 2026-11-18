import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithModel, validateProposal } from "../build/model.js";
import { analyze } from "../build/analysis.js";
import { loadConfig } from "../build/config.js";
import { RestMarketDataProvider } from "../build/market.js";
import { env, NOW, snapshot, proposal, modelResult, provider, quote, marketFetch } from "./fixtures.mjs";

test("model JSON is validated beyond syntax, and invented metrics/confidence are rejected", () => {
  assert.equal(validateProposal(proposal(), snapshot()).direction, "long");
  for (const delta of [{ confidence: 0.99 }, { stopLoss: 11000 }, { entry: { min: 11000, max: 10000 } }, { targets: [{ price: 9800, reason: "wrong" }] }, { evidence: [{ metric: "news", reason: "invented" }] }, { evidence: [{ metric: "openInterest", reason: "absent" }] }, { counterarguments: [] }, { validForSeconds: 9999 }]) assert.throws(() => validateProposal(proposal(delta), snapshot()), { code: "INVALID_MODEL_OUTPUT" });
  const none = proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [] });
  assert.equal(validateProposal(none, snapshot()).status, "none");
  assert.throws(() => validateProposal({ ...none, direction: "long" }, snapshot()));
});

test("short targets use observed lows in order, and missing volume data permits no opportunity", () => {
  const short = proposal({ direction: "short", stopLoss: 10100, targets: [
    { price: 9700, reason: "前20根低点" }, { price: 9500, reason: "区间低点" },
  ] });
  const market = snapshot();
  assert.deepEqual(validateProposal(short, market).targets, short.targets);
  assert.throws(() => validateProposal({ ...short, targets: short.targets.toReversed() }, market),
    { upstream: { outputReason: "price_relationship", outputField: "targets[1].price" } });
  market.frames.forEach(f => { f.volumePrice[0].volumeRatio20 = null; });
  assert.throws(() => validateProposal(short, market), { upstream: { outputReason: "unsupported_metric", outputField: "evidence[0].metric" } });
  assert.equal(validateProposal(proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [], evidence: [] }), market).status, "none");
});

test("Kimi receives the snapshot metric enum, price rules and a larger default output budget", async () => {
  const config = loadConfig({ ...env, DASHSCOPE_MODEL: "kimi-k3.1-pro" });
  assert.equal(config.maxTokens, 4096);
  assert.equal(loadConfig({ ...env, DASHSCOPE_MODEL: "kimi-k3.1-pro", DASHSCOPE_MAX_TOKENS: "512" }).maxTokens, 512);
  assert.equal(loadConfig(env).maxTokens, 2000);
  await analyzeWithModel(config, snapshot(), "trend", AbortSignal.timeout(1000), async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    const schema = JSON.parse(prompt.split("按此 JSON Schema 输出：")[1].split("\n")[0]);
    const metrics = schema.properties.evidence.items.properties.metric.enum;
    assert.ok(metrics.includes("1h.ema20"));
    assert.ok(metrics.includes("quote.price"));
    assert.ok(!metrics.includes("openInterest"));
    assert.match(prompt, /stopLoss < entry.min <= entry.max/);
    assert.match(prompt, /只能引用1个枚举指标/);
    assert.equal(body.max_tokens, 4096);
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(proposal()) } }] }));
  });
});
test("complete fenced JSON is accepted, while surrounding prose, corrupt JSON and reasoning are rejected", async () => {
  const json = JSON.stringify(proposal());
  for (const content of [json, "\uFEFF " + json, "```json\n" + json + "\n```", "```\n" + json + "\n```"]) {
    const result = await analyzeWithModel(loadConfig(env), snapshot(), "trend", AbortSignal.timeout(1000), async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content, reasoning_content: "private-reasoning" } }],
    })));
    assert.equal(result.proposal.direction, "long");
  }
  for (const content of ["Here is the result: " + json, json.slice(0, -1), "```json\n" + json, null, ""]) {
    await assert.rejects(analyzeWithModel(loadConfig(env), snapshot(), "trend", AbortSignal.timeout(1000), async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content, reasoning_content: json } }],
    }))), { code: "INVALID_MODEL_OUTPUT" });
  }
});
test("invalid output diagnostics distinguish truncation, JSON, schema, metrics and prices without leaking output", async () => {
  const id = "f33b92e5-7ade-471a-b3c4-d638b5e1b542";
  const cases = [
    ["length", null, "truncated", undefined],
    ["length", JSON.stringify(proposal()), "truncated", undefined],
    ["content_filter", null, "finish_reason", undefined],
    ["private-unknown-finish", null, "finish_reason", undefined],
    ["stop", null, "empty_content", undefined],
    ["stop", "private-invalid-json", "invalid_json", undefined],
    ["stop", "x".repeat(24001), "content_too_large", undefined],
    ["stop", JSON.stringify(proposal({ evidence: [{ metric: "private-unknown-metric", reason: "private-output" }] })), "unsupported_metric", "evidence[0].metric"],
    ["stop", JSON.stringify(proposal({ stopLoss: 11000 })), "price_relationship", "stopLoss/targets"],
    ["stop", JSON.stringify(proposal({ entry: { min: "9990", max: 10010 } })), "schema", "entry.min"],
    ["stop", JSON.stringify(proposal({ counterarguments: [] })), "schema", "counterarguments"],
    ["stop", JSON.stringify(proposal({ targets: [{ price: 20000, reason: "private-output" }] })), "price_scale", "entry/stopLoss/targets"],
    ["stop", JSON.stringify(proposal({ targets: [{ price: 10150, reason: "private-output" }] })), "unsupported_target", "targets[0].price"],
    ["stop", JSON.stringify(proposal({ evidence: [{ metric: "1h.ema20", reason: "private-output" }] })), "missing_volume_price_evidence", "evidence"],
    ["stop", JSON.stringify(proposal({ privateField: "private-output" })), "schema", "proposal"],
  ];
  for (const [finish_reason, content, outputReason, outputField] of cases) {
    let calls = 0;
    await assert.rejects(analyzeWithModel(loadConfig(env), snapshot(), "trend", AbortSignal.timeout(1000), async () => {
      calls++;
      return new Response(JSON.stringify({
        choices: [{ finish_reason, message: { content, reasoning_content: "private-reasoning" } }],
        usage: { prompt_tokens: 123, completion_tokens: 2000 }, request_id: id,
      }));
    }), error => {
      assert.equal(error.code, "INVALID_MODEL_OUTPUT");
      assert.equal(error.upstream.outputReason, outputReason);
      assert.equal(error.upstream.outputField, outputField);
      assert.equal(error.upstream.outputTokens, 2000);
      assert.equal(error.upstream.inputTokens, 123);
      assert.equal(error.upstream.upstreamRequestId, id);
      assert.equal(error.upstream.upstreamStatus, 200);
      assert.equal(error.upstream.finishReason, finish_reason === "private-unknown-finish" ? "unknown" : finish_reason);
      assert.equal(JSON.stringify(error).includes("private-"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
test("malformed envelopes and oversized HTTP responses have output diagnostics", async () => {
  for (const raw of ["not-json", "x".repeat(100000), "null", "{}", JSON.stringify({ choices: [null] }), JSON.stringify({ choices: [1] })]) {
    await assert.rejects(analyzeWithModel(loadConfig(env), snapshot(), "trend", AbortSignal.timeout(1000), async () => new Response(raw)), error => {
      assert.equal(error.code, "INVALID_MODEL_OUTPUT");
      assert.ok(["response_envelope", "finish_reason"].includes(error.upstream.outputReason));
      return true;
    });
  }
});
test("Bailian request disables thinking, asks for JSON, and never retries errors", async () => {
  let calls = 0;
  const config = loadConfig(env);
  const request = async (url, options) => {
    calls++;
    assert.equal(url, config.endpoint); assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.enable_thinking, false); assert.equal(body.stream, false); assert.equal(body.response_format.type, "json_object");
    assert.equal(body.temperature, 0.1);
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
test("Bailian Kimi K3.1 Pro receives 200 closed candles per timeframe and keeps its fixed sampling", async () => {
  const config = loadConfig({ ...env, DASHSCOPE_MODEL: "kimi-k3.1-pro", DASHSCOPE_BASE_URL: "https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" });
  const input = await new RestMarketDataProvider(config, marketFetch, () => NOW).snapshot("BTCUSDT", AbortSignal.timeout(1000));
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url, "https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "kimi-k3.1-pro"); assert.equal(body.temperature, 1);
    assert.equal(body.top_p, undefined); assert.equal(body.presence_penalty, undefined);
    assert.equal(body.enable_thinking, false); assert.equal(body.response_format.type, "json_object");
    const sent = JSON.parse(body.messages[1].content).snapshot;
    assert.deepEqual(sent.candleColumns, ["openTimeMs", "open", "high", "low", "close", "volume", "takerBuyVolume"]);
    assert.deepEqual(sent.frames.map(f => [f.interval, f.recentCandles.length]), [["4h", 200], ["1h", 200], ["15m", 200]]);
    for (const [i, f] of sent.frames.entries()) {
      assert.equal(f.recentCandles[0][0], input.frames[i].recentCandles[0].openTime);
      assert.deepEqual(f.recentCandles.at(-1).slice(1), [10000, 10100, 9900, 10010, 10, 4]);
      assert.equal(f.volumePrice.length, 5);
      assert.equal(f.priceLevels.high200, 10100);
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(proposal({ targets: [{ price: 10100, reason: "1小时区间前高" }] })) } }] }));
  };
  assert.equal((await analyzeWithModel(config, input, "trend", AbortSignal.timeout(1000), request)).proposal.status, "candidate");
  assert.equal(calls, 1);
});
test("model failures expose only HTTP status, recognized provider codes and bounded request IDs", async () => {
  const config = loadConfig(env);
  const id = "0f32839b-0ba9-4d0d-95db-0ee9bd0d312f";
  await assert.rejects(analyzeWithModel(config, snapshot(), "trend", AbortSignal.timeout(1000), async () => new Response(JSON.stringify({
    error: { code: "invalid_parameter_error", message: `credential ${config.apiKey} and private prompt` },
    request_id: id, privateField: "never-log-this",
  }), { status: 400 })), error => {
    assert.equal(error.code, "MODEL_UNAVAILABLE"); assert.equal(error.upstream.upstreamStatus, 400);
    assert.equal(error.upstream.upstreamCode, "invalid_parameter_error"); assert.equal(error.upstream.upstreamRequestId, id);
    assert.match(error.message, /HTTP 400/);
    assert.equal(JSON.stringify(error).includes(config.apiKey), false);
    assert.equal(JSON.stringify(error).includes("private prompt"), false);
    assert.equal(JSON.stringify(error).includes("never-log-this"), false);
    return true;
  });
  for (const raw of ["<html>private content</html>", "x".repeat(9000), JSON.stringify({ error: { code: config.apiKey }, request_id: config.apiKey })]) {
    let calls = 0;
    await assert.rejects(analyzeWithModel(config, snapshot(), "trend", AbortSignal.timeout(1000), async () => { calls++; return new Response(raw, { status: 500 }); }), error => {
      assert.equal(error.code, "MODEL_UNAVAILABLE"); assert.equal(error.upstream.upstreamStatus, 500);
      assert.equal(error.upstream.upstreamCode, undefined); assert.equal(error.upstream.upstreamRequestId, undefined);
      assert.equal(JSON.stringify(error).includes(config.apiKey), false); return true;
    });
    assert.equal(calls, 1);
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
