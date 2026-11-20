import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithModel, validateProposal } from "../build/model.js";
import { analyze } from "../build/analysis.js";
import { loadConfig } from "../build/config.js";
import { RestMarketDataProvider } from "../build/market.js";
import { makeOrderPermit } from "../build/order-auth.js";
import { env, NOW, snapshot, proposal, modelResult, provider, quote, marketFetch } from "./fixtures.mjs";

test("model JSON is validated beyond syntax, and invented metrics/confidence are rejected", () => {
  assert.equal(validateProposal(proposal(), snapshot()).direction, "long");
  for (const delta of [{ confidence: 0.99 }, { stopLoss: 11000 }, { entry: { min: 11000, max: 10000 } }, { targets: [{ price: 9800, reason: "wrong", zoneId: "up" }] }, { evidence: [{ metric: "news", reason: "invented" }] }, { evidence: [{ metric: "openInterest", reason: "absent" }] }, { counterarguments: [] }, { validForSeconds: 9999 }]) assert.throws(() => validateProposal(proposal(delta), snapshot()), { code: "INVALID_MODEL_OUTPUT" });
  const none = proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [] });
  assert.equal(validateProposal(none, snapshot()).status, "none");
  assert.throws(() => validateProposal({ ...none, direction: "long" }, snapshot()));
});

test("short targets use observed lows in order, and missing volume data permits no opportunity", () => {
  const short = proposal({ direction: "short", stopLoss: 10100, targets: [
    { price: 9700, reason: "前20根低点", zoneId: "down" }, { price: 9500, reason: "区间低点", zoneId: "lower" },
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
    assert.match(prompt, /做空可以在阻力区内或其下方设置更近的止损/);
    assert.match(prompt, /同一周期和同一成交量口径下，对比前一段趋势推进、反向调整和当前尝试恢复三段/);
    assert.match(prompt, /用 15m 判断反向调整处于进行中、趋于停顿还是已恢复/);
    assert.match(prompt, /已经发生的 1h 结构翻转须指出哪根 1h K 线收盘/);
    assert.match(prompt, /15m 早期翻转候选/);
    assert.match(prompt, /1\/\(1\+R\).*盈亏平衡门槛/);
    assert.match(prompt, /现有证据和盈亏比足以支持尝试时，给出 candidate/);
    assert.match(prompt, /勿编造概率/);
    assert.match(prompt, /只有方向参考、还没有可用入场区间时，输出无计划的 watch/);
    assert.match(prompt, /只要 direction 是 long 或 short，就必须提供完整计划/);
    assert.match(prompt, /invalidationConditions 区分【未入场失效】和【持仓提前退出】/);
    assert.doesNotMatch(prompt, /scanEvidence 是程序初筛/);
    assert.equal(JSON.parse(body.messages[1].content).scanEvidence, undefined);
    assert.equal(body.max_tokens, 4096);
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(proposal()) } }] }));
  });
});

test("model receives usable tick-aligned zone edges and a rounded-out entry still fails validation", async () => {
  const market = snapshot();
  market.quote.price = 62200;
  const [hourlyZone] = market.frames.find(f => f.interval === "1h").zones;
  const entryZone = { ...hourlyZone, id: "15m:resistance:1795128300000", interval: "15m", kind: "resistance",
    lower: 62173.64899614541, upper: 62427.85100385459 };
  const targetZone = { ...hourlyZone, id: "target", lower: 61600, upper: 61800 };
  const narrowZone = { ...entryZone, id: "narrow", lower: 62500.02, upper: 62500.06 };
  const exactEdge = { ...entryZone, id: "exact-edge", lower: 62500.3, upper: 62500.3 };
  const brokenZone = { ...entryZone, id: "broken", status: "broken" };
  market.frames.find(f => f.interval === "1h").zones = [targetZone];
  market.frames.find(f => f.interval === "15m").zones = [entryZone, narrowZone, exactEdge, brokenZone];
  const short = proposal({ direction: "short", entry: { min: 62173.7, max: 62253.2 }, stopLoss: 62428,
    targets: [{ price: 61700, reason: "前方支撑", zoneId: targetZone.id }] });
  short.research = { ...short.research, entryZoneId: entryZone.id, stopZoneId: entryZone.id };
  const selectable = { min: 62173.7, max: 62427.8 };
  for (const entry of [{ ...short.entry, min: 62173.6 }, { ...short.entry, max: 62427.9 }]) {
    assert.throws(() => validateProposal({ ...short, entry }, market), error => {
      assert.equal(error.validation.reason, "entry_out_of_bounds");
      assert.deepEqual(error.validation.selectablePriceRange, selectable);
      return true;
    });
  }
  assert.throws(() => validateProposal({ ...short, targets: [{ ...short.targets[0], price: 61800.1 }] }, market), error => {
    assert.equal(error.validation.reason, "target_out_of_bounds");
    assert.deepEqual(error.validation.selectablePriceRange, { min: 61600, max: 61800 });
    return true;
  });
  const result = await analyzeWithModel(loadConfig(env), market, "trend", AbortSignal.timeout(1000), async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /靠近边界时直接使用对应的 min 或 max/);
    const request = JSON.parse(body.messages[1].content);
    const [inputZone, narrow, exact, broken] = request.snapshot.frames.find(f => f.interval === "15m").zones;
    assert.deepEqual(inputZone, { ...entryZone, selectablePriceRange: selectable, effectiveKind: "resistance", importantObstacle: false });
    assert.equal(narrow.selectablePriceRange, null);
    assert.deepEqual(exact.selectablePriceRange, { min: 62500.3, max: 62500.3 });
    assert.equal(broken.selectablePriceRange, null);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(short) } }] });
  });
  assert.deepEqual(result.proposal.entry, short.entry);
  assert.equal(entryZone.selectablePriceRange, undefined);
});

test("the reported short stop below the resistance upper edge stays unchanged after validation", async () => {
  const market = snapshot();
  market.quote.price = 62400;
  const hourly = market.frames.find(f => f.interval === "1h");
  const stopZone = { ...hourly.zones[0], id: "1h:resistance:1795136400000", kind: "resistance",
    lower: 62219.43321369928, upper: 62715.96678630072 };
  const target = { ...hourly.zones[0], id: "target", lower: 61600, upper: 61800 };
  hourly.atr14 = 625.0476757453868;
  hourly.zones = [stopZone, target];
  const short = proposal({ direction: "short", entry: { min: 62350, max: 62450 }, stopLoss: 62648.6,
    targets: [{ price: 61700, reason: "前方支撑", zoneId: target.id }] });
  short.research.entryZoneId = short.research.stopZoneId = stopZone.id;
  const source = provider({ snapshot: async () => market, quote: async () => market.quote });
  const model = (config, input, style, signal) => analyzeWithModel(config, input, style, signal, async () =>
    Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(short) } }] }));
  const result = await analyze(loadConfig(env), source, "BTCUSDT", "trend", AbortSignal.timeout(1000), model, () => NOW);
  assert.equal(result.status, "candidate");
  assert.equal(result.opportunity.stopLoss, 62648.6);
  assert.equal(makeOrderPermit(result, "owner", NOW).stop, 62648.6);
  assert.equal(result.research.ruleAssessment.invalidation.riskDistance, 62648.6 - short.entry.min);
  assert.throws(() => validateProposal({ ...short, stopLoss: short.entry.max }, market),
    { upstream: { outputReason: "price_relationship", outputField: "stopLoss/targets" } });
  assert.throws(() => validateProposal({ ...short, stopLoss: 62648.61 }, market),
    { upstream: { outputReason: "price_precision", outputField: "entry/stopLoss/targets" } });
});

test("manual analysis exposes labelled timing conditions and the prompt version through the existing result contract", async () => {
  const triggerConditions = ["15m 成交 K 线收盘收复 10000，标记价格仍在入场区"];
  const invalidationConditions = ["【未入场失效】15m 成交 K 线收低于 9980",
    "【持仓提前退出】放量上行受阻后，15m 成交 K 线收低于 9990"];
  const result = await analyze(loadConfig(env), provider(), "BTCUSDT", "trend", AbortSignal.timeout(1000),
    async () => modelResult(proposal({ triggerConditions, invalidationConditions })), () => NOW);
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.model.promptVersion, "market-research-v4-volume-timing-v7");
  assert.deepEqual(result.opportunity.triggerConditions, triggerConditions);
  assert.deepEqual(result.opportunity.invalidationConditions, invalidationConditions);
  assert.equal(result.opportunity.triggerVerified, false);
});

test("directional replies with a null entry preserve research and cannot create order drafts", async () => {
  for (const status of ["candidate", "watch"]) {
    const raw = proposal({ status, direction: "short", entry: null });
    let calls = 0;
    const runModel = (config, market, style, signal) => analyzeWithModel(config, market, style, signal, async () => {
      calls++;
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(raw) } }] });
    });
    const result = await analyze(loadConfig(env), provider(), "BTCUSDT", "trend", AbortSignal.timeout(1000), runModel, () => NOW);
    assert.equal(calls, 1);
    assert.equal(result.status, "watch");
    assert.equal(result.opportunity.direction, null);
    assert.equal(result.opportunity.entry, null);
    assert.equal(result.opportunity.stopLoss, null);
    assert.deepEqual(result.opportunity.targets, []);
    assert.deepEqual(result.opportunity.triggerConditions, []);
    assert.deepEqual(result.opportunity.invalidationConditions, []);
    assert.match(result.opportunity.summary, /偏空.*未提供入场区间/);
    assert.deepEqual(result.decision, { modelStatus: status, modelDirection: "short", modelSummary: raw.summary,
      reasons: [{ code: "entry_missing", message: result.opportunity.summary }] });
    assert.deepEqual(result.opportunity.evidence, raw.evidence);
    assert.deepEqual(result.research.timeframeAnalysis, raw.research.timeframeAnalysis);
    assert.equal(result.research.scenario, "none");
    assert.equal(result.research.entryZoneId, null);
    assert.equal(result.research.stopZoneId, null);
    assert.equal(makeOrderPermit(result, "owner", NOW), undefined);
  }
  assert.throws(() => validateProposal(proposal({ entry: {} }), snapshot()),
    { upstream: { outputReason: "schema", outputField: "entry" } });
});

test("a short target that skips the reported 15m support returns research without an order plan", async () => {
  const market = snapshot();
  market.quote.price = 62200;
  const hourly = market.frames.find(f => f.interval === "1h");
  const entryZone = { ...hourly.zones[0], id: "entry-and-stop", kind: "resistance", lower: 61990, upper: 62220 };
  const far = { ...hourly.zones[0], id: "1h:support:1795122000000", lower: 61162.69123503722, upper: 61468.10876496277 };
  const near = { ...hourly.zones[0], id: "15m:support:1795120200000", interval: "15m", touches: 2,
    lower: 61617.775961926505, upper: 61797.724038073495 };
  hourly.zones = [entryZone, far];
  market.frames.find(f => f.interval === "15m").zones = [near];
  const skipped = proposal({ direction: "short", entry: { min: 62000, max: 62210 }, stopLoss: 62250,
    targets: [{ price: 61468.1, reason: "1h 支撑", zoneId: far.id }] });
  skipped.research = { ...skipped.research, entryZoneId: entryZone.id, stopZoneId: entryZone.id };
  assert.throws(() => validateProposal(skipped, market), error => {
    assert.equal(error.upstream.outputReason, "target_obstacle");
    assert.equal(error.upstream.outputField, "targets[0].price");
    assert.equal(error.validation.blockingZone.id, near.id);
    return true;
  });

  const complete = { ...skipped, targets: [{ price: 61797.7, reason: "较近的 15m 支撑", zoneId: near.id }, ...skipped.targets] };
  let response = skipped;
  let calls = 0;
  const runModel = (config, current, style, signal) => analyzeWithModel(config, current, style, signal, async (_url, options) => {
    calls++;
    const { messages } = JSON.parse(options.body);
    assert.match(messages[0].content, /即使近端是 15m、远端是 1h 或 4h，也按同一规则/);
    const { zones } = JSON.parse(messages[1].content).snapshot.frames.find(f => f.interval === "15m");
    assert.equal(zones[0].importantObstacle, true);
    assert.equal(zones[0].effectiveKind, "support");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(response) } }] });
  });
  const config = loadConfig(env);
  const source = provider({ snapshot: async () => market, quote: async () => market.quote });
  const observe = await analyze(config, source, "BTCUSDT", "trend", AbortSignal.timeout(1000), runModel, () => NOW);
  assert.equal(calls, 1);
  assert.equal(observe.status, "watch");
  assert.deepEqual(observe.opportunity.evidence, skipped.evidence);
  assert.match(observe.opportunity.summary, /15m 支撑区.*61617\.8–61797\.7/);
  assert.deepEqual(observe.decision, { modelStatus: "candidate", modelDirection: "short", modelSummary: skipped.summary,
    reasons: [{ code: "target_obstacle", message: observe.opportunity.summary }] });
  assert.deepEqual(observe.opportunity.targets, []);
  assert.equal(makeOrderPermit(observe, "owner", NOW), undefined);

  response = complete;
  const candidate = await analyze(config, source, "BTCUSDT", "trend", AbortSignal.timeout(1000), runModel, () => NOW);
  assert.equal(candidate.status, "candidate");
  assert.deepEqual(candidate.decision.reasons, []);
  assert.deepEqual(candidate.opportunity.targets, complete.targets);
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
    ["stop", JSON.stringify(proposal({ targets: [{ price: 20000, reason: "private-output", zoneId: "up" }] })), "price_scale", "entry/stopLoss/targets"],
    ["stop", JSON.stringify(proposal({ targets: [{ price: 10150, reason: "private-output", zoneId: "up" }] })), "unsupported_target", "targets[0].price"],
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
  const input = await new RestMarketDataProvider(config, marketFetch, () => NOW).snapshot("BTCUSDT", AbortSignal.timeout(2500));
  let modelFrames;
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url, "https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "kimi-k3.1-pro"); assert.equal(body.temperature, 1);
    assert.equal(body.top_p, undefined); assert.equal(body.presence_penalty, undefined);
    assert.equal(body.enable_thinking, false); assert.equal(body.response_format.type, "json_object");
    const sent = JSON.parse(body.messages[1].content).snapshot;
    modelFrames = sent.frames;
    assert.deepEqual(sent.candleColumns, ["openTimeMs", "open", "high", "low", "close", "volume", "takerBuyVolume"]);
    assert.deepEqual(sent.frames.map(f => [f.interval, f.recentCandles.length]), [["4h", 200], ["1h", 200], ["15m", 200]]);
    for (const [i, f] of sent.frames.entries()) {
      assert.equal(f.recentCandles[0][0], input.frames[i].recentCandles[0].openTime);
      assert.equal(f.latestClosedAt, input.frames[i].recentCandles.at(-1).closeTime + 1);
      assert.deepEqual(f.recentCandles.at(-1).slice(1), [10000, 10100, 9900, 10010, 10, 4]);
      assert.equal(f.volumePrice.length, 5);
      assert.equal(f.priceLevels.high200, 10100);
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(proposal({ status: "none", direction: null, entry: null, stopLoss: null, targets: [] })) } }] }));
  };
  const market = provider({ snapshot: async () => input });
  const result = await analyze(config, market, "BTCUSDT", "trend", AbortSignal.timeout(1000),
    (...args) => analyzeWithModel(...args, request), () => NOW);
  assert.equal(result.status, "none");
  assert.deepEqual(result.market.chart, modelFrames.map(f => ({ interval: f.interval, candles: f.recentCandles })));
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
  assert.equal(drifted.decision.modelStatus, "candidate");
  assert.ok(drifted.decision.reasons.some(reason => reason.code === "quote_drift"));
  assert.deepEqual(drifted.decision.reasons.map(reason => reason.message), drifted.opportunity.expiredReasons);
  const outOfRange = await analyze(config, provider({ quote: async () => quote({ price: 10020 }) }), "BTCUSDT", "trend", AbortSignal.timeout(1000), async () => modelResult(), () => NOW);
  assert.equal(outOfRange.status, "watch");
  assert.equal(outOfRange.decision.modelStatus, "candidate");
  assert.equal(outOfRange.decision.reasons[0].code, "quote_outside_entry");
  assert.match(outOfRange.decision.reasons[0].message, /10020/);
  assert.deepEqual(outOfRange.opportunity.entry, result.opportunity.entry);
  let time = NOW;
  const expired = await analyze(config, provider({ quote: async () => quote({ time }) }), "BTCUSDT", "trend", AbortSignal.timeout(1000), async () => { time += 61000; return modelResult(); }, () => time);
  assert.equal(expired.status, "expired");
  assert.equal(expired.decision.reasons[0].code, "analysis_age");
});

test("a model watch or no-opportunity remains distinguishable when the final quote expires", async () => {
  const config = loadConfig(env);
  for (const status of ["watch", "none"]) {
    const raw = proposal({ status, direction: null, entry: null, stopLoss: null, targets: [] });
    const runModel = async () => modelResult(raw);
    const result = await analyze(config, provider(), "BTCUSDT", "trend", AbortSignal.timeout(1000), runModel, () => NOW);
    assert.equal(result.status, status);
    assert.equal(result.decision.modelStatus, status);
    assert.equal(result.decision.modelDirection, null);
    assert.equal(result.decision.reasons[0].code, `model_${status}`);
    const stale = provider({ quote: async () => quote({ time: NOW - config.maxPriceAgeMs - 1 }) });
    const expired = await analyze(config, stale, "BTCUSDT", "trend", AbortSignal.timeout(1000), runModel, () => NOW);
    assert.equal(expired.status, "expired");
    assert.deepEqual(expired.decision.reasons.map(reason => reason.code), [`model_${status}`, "quote_stale"]);
  }
});
