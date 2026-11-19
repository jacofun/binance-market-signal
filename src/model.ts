import { AppError, type ModelFailureDetails, type ModelOutputDetails } from "./errors.js";
import { boundedJson } from "./http.js";
import { effectiveKind } from "./price-zones.js";
import { hourlyAtr, inside, researchContext, significantObstacle, structureZones, targetObstacles, zoneUsable } from "./research.js";
import { candleRow } from "./market.js";
import type { Config } from "./config.js";
import type { ModelResult, Proposal, Snapshot, Style } from "./types.js";

const text = { type: "string", minLength: 1, maxLength: 600 };
const list = { type: "array", items: text, maxItems: 8 };
export const proposalSchema = {
  type: "object", additionalProperties: false,
  required: ["status", "direction", "title", "summary", "entry", "stopLoss", "targets", "triggerConditions", "invalidationConditions", "evidence", "counterarguments", "validForSeconds", "research"],
  properties: {
    status: { type: "string", enum: ["candidate", "watch", "none"] }, direction: { type: ["string", "null"], enum: ["long", "short", null] },
    title: text, summary: text,
    entry: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["min", "max"], properties: { min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 } } }] },
    stopLoss: { type: ["number", "null"] }, targets: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["price", "reason", "zoneId"], properties: { price: { type: "number", exclusiveMinimum: 0 }, reason: text, zoneId: text } } },
    triggerConditions: list, invalidationConditions: list,
    evidence: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["metric", "reason"], properties: { metric: text, reason: text } } },
    research: { type: "object", additionalProperties: false,
      required: ["marketRegime", "scenario", "timeframeAnalysis", "entryZoneId", "stopZoneId", "riskFactors", "researchHorizon"],
      properties: {
        marketRegime: { type: "string", enum: ["trend", "range", "transition"] },
        scenario: { type: "string", enum: ["continuation", "reversal", "none"] },
        timeframeAnalysis: { type: "object", additionalProperties: false, required: ["4h", "1h", "15m"], properties: { "4h": text, "1h": text, "15m": text } },
        entryZoneId: { type: ["string", "null"] }, stopZoneId: { type: ["string", "null"] },
        riskFactors: list, researchHorizon: { type: "integer", enum: [4, 12, 24] },
      },
    },
    counterarguments: list, validForSeconds: { type: "integer", minimum: 30, maximum: 300 },
  },
};
function invalid(outputReason: ModelOutputDetails["outputReason"] = "schema", outputField?: string): never {
  const hint = outputReason === "truncated" ? "模型输出被截断，请检查 DASHSCOPE_MAX_TOKENS 和思考模式配置。" : "模型返回的机会结构或价位关系无效，本次结果不作为交易机会。";
  throw new AppError("INVALID_MODEL_OUTPUT", hint, 502, undefined, { outputReason, ...(outputField ? { outputField } : {}) });
}

const volumePriceMetrics = (snapshot: Snapshot) => snapshot.frames
  .filter(f => f.volumePrice.some(bar => bar.volumeRatio20 !== null))
  .map(f => `${f.interval}.volumePrice`);

function allowedMetrics(snapshot: Snapshot): string[] {
  return ["quote.price", "quote.indexPrice", "quote.fundingRate", ...(snapshot.openInterest.length ? ["openInterest"] : []),
    ...(researchContext(snapshot).openInterestChanges.length ? ["openInterestChanges"] : []), "trendAlignment",
    ...structureZones(snapshot).map(z => z.id),
    ...snapshot.frames.flatMap(f => ["close", "ema20", "ema50", "atr14", "volumeRatio20", "high20", "low20", "recentCandles", "priceLevels", "atrPct", "trend", "volumeWindows", "historicalRanges"].map(k => `${f.interval}.${k}`)),
    ...volumePriceMetrics(snapshot)];
}
function schemaForSnapshot(snapshot: Snapshot) {
  return { ...proposalSchema, properties: { ...proposalSchema.properties, evidence: {
    ...proposalSchema.properties.evidence, items: { ...proposalSchema.properties.evidence.items,
      properties: { ...proposalSchema.properties.evidence.items.properties, metric: { type: "string", enum: allowedMetrics(snapshot) } } },
  } } };
}
// Never forward arbitrary provider messages, headers or response bodies. They
// can echo a credential or prompt. Keep only recognized codes and UUID/hex IDs.
const UPSTREAM_CODES = new Set([
  "InvalidParameter", "InvalidParameter.NotSupportEnableThinking", "InternalError.Algo.InvalidParameter",
  "invalid_parameter_error", "invalid_request_error", "ModelNotFound", "model_not_found", "NotFound",
  "InvalidApiKey", "invalid_api_key", "AccessDenied.Unpurchased", "Arrearage", "insufficient_quota",
  "Throttling.RateQuota", "Throttling.AllocationQuota", "InternalError", "ServiceUnavailable", "service_unavailable",
]);
const providerObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(value) ? value : undefined;
}
async function modelFailureDetails(response: Response): Promise<ModelFailureDetails> {
  const details: ModelFailureDetails = { upstreamStatus: response.status };
  details.upstreamRequestId = safeRequestId(response.headers.get("x-request-id"));
  try {
    const body = providerObject(await boundedJson(response, 8192, "MODEL_UNAVAILABLE"));
    const error = providerObject(body.error);
    const code = error.code ?? body.code ?? error.type;
    if (typeof code === "string" && UPSTREAM_CODES.has(code)) details.upstreamCode = code;
    details.upstreamRequestId ||= safeRequestId(body.request_id) || safeRequestId(error.request_id);
  } catch {
    // Preserve the original HTTP failure even for HTML, oversized, malformed or
    // interrupted error bodies. No automatic retry and no raw-body logging.
  }
  return details;
}
function object(value: unknown, names: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(n => !Object.hasOwn(value, n))) invalid("schema", field);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 600) invalid("schema", field);
  return value.trim();
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 8) invalid("schema", field);
  return value.map((v, i) => string(v, `${field}[${i}]`));
}
function price(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e12) invalid("schema", field);
  return value;
}
export function validateProposal(raw: unknown, snapshot: Snapshot): Proposal {
  const r = object(raw, proposalSchema.required, "proposal");
  if (typeof r.status !== "string" || !["candidate", "watch", "none"].includes(r.status)) invalid("schema", "status");
  if (!["long", "short", null].includes(r.direction as string | null)) invalid("schema", "direction");
  if (!Number.isInteger(r.validForSeconds) || Number(r.validForSeconds) < 30 || Number(r.validForSeconds) > 300) invalid("schema", "validForSeconds");
  if (!Array.isArray(r.targets) || r.targets.length > 3) invalid("schema", "targets");
  if (!Array.isArray(r.evidence) || r.evidence.length > 8) invalid("schema", "evidence");
  const metrics = new Set(allowedMetrics(snapshot));
  const research = object(r.research, proposalSchema.properties.research.required, "research");
  const timeframes = object(research.timeframeAnalysis, ["4h", "1h", "15m"], "research.timeframeAnalysis");
  if (!["trend", "range", "transition"].includes(research.marketRegime as string) ||
      !["continuation", "reversal", "none"].includes(research.scenario as string) ||
      ![4, 12, 24].includes(research.researchHorizon as number)) invalid("schema", "research");
  const p: Proposal = {
    status: r.status as Proposal["status"], direction: r.direction as Proposal["direction"], title: string(r.title, "title"), summary: string(r.summary, "summary"),
    entry: r.entry === null ? null : (() => { const e = object(r.entry, ["min", "max"], "entry"); return { min: price(e.min, "entry.min"), max: price(e.max, "entry.max") }; })(),
    stopLoss: r.stopLoss === null ? null : price(r.stopLoss, "stopLoss"),
    targets: r.targets.map((t, i) => { const f = `targets[${i}]`; const v = object(t, ["price", "reason", "zoneId"], f); return { price: price(v.price, `${f}.price`), reason: string(v.reason, `${f}.reason`), zoneId: string(v.zoneId, `${f}.zoneId`) }; }),
    triggerConditions: strings(r.triggerConditions, "triggerConditions"), invalidationConditions: strings(r.invalidationConditions, "invalidationConditions"), counterarguments: strings(r.counterarguments, "counterarguments"),
    evidence: r.evidence.map((e, i) => { const f = `evidence[${i}]`; const v = object(e, ["metric", "reason"], f); const metric = string(v.metric, `${f}.metric`); if (!metrics.has(metric)) invalid("unsupported_metric", `${f}.metric`); return { metric, reason: string(v.reason, `${f}.reason`) }; }),
    validForSeconds: Number(r.validForSeconds),
    research: {
      marketRegime: research.marketRegime as Proposal["research"]["marketRegime"],
      scenario: research.scenario as Proposal["research"]["scenario"],
      researchHorizon: research.researchHorizon as Proposal["research"]["researchHorizon"],
      timeframeAnalysis: { "4h": string(timeframes["4h"], "research.timeframeAnalysis.4h"),
        "1h": string(timeframes["1h"], "research.timeframeAnalysis.1h"), "15m": string(timeframes["15m"], "research.timeframeAnalysis.15m") },
      entryZoneId: research.entryZoneId === null ? null : string(research.entryZoneId, "research.entryZoneId"),
      stopZoneId: research.stopZoneId === null ? null : string(research.stopZoneId, "research.stopZoneId"),
      riskFactors: strings(research.riskFactors, "research.riskFactors"),
    },
  };
  const noPlan = p.direction === null || p.status === "none";
  if (noPlan) {
    if (p.status === "candidate" || p.direction !== null || p.entry !== null || p.stopLoss !== null || p.targets.length ||
        p.research.entryZoneId !== null || p.research.stopZoneId !== null || p.research.scenario !== "none") invalid("schema", "noPlan");
  } else {
    if (p.research.scenario === "none") invalid("schema", "research.scenario");
    for (const field of ["direction", "entry", "stopLoss", "targets", "triggerConditions", "invalidationConditions", "evidence", "counterarguments"] as const) {
      const value = p[field];
      if (value === null || Array.isArray(value) && !value.length) invalid("schema", field);
    }
    if (!p.direction || !p.entry || !p.stopLoss) invalid("schema", "proposal");
    if (p.entry.min > p.entry.max) invalid("price_relationship", "entry");
    if (p.direction === "long" && (p.stopLoss >= p.entry.min || p.targets.some(t => t.price <= p.entry!.max)) ||
      p.direction === "short" && (p.stopLoss <= p.entry.max || p.targets.some(t => t.price >= p.entry!.min))) invalid("price_relationship", "stopLoss/targets");
    // Reject hallucinated scales and remote, ungrounded price regimes.
    const q = snapshot.quote.price;
    if ([p.entry.min, p.entry.max, p.stopLoss, ...p.targets.map(t => t.price)].some(v => v < q * 0.5 || v > q * 1.5)) invalid("price_scale", "entry/stopLoss/targets");
    const prices = [p.entry.min, p.entry.max, p.stopLoss, ...p.targets.map(t => t.price)];
    if (prices.some(v => {
      const ticks = v / snapshot.tickSize;
      return !Number.isFinite(ticks) || ticks > Number.MAX_SAFE_INTEGER / 8 ||
        Math.abs(Math.round(ticks) - ticks) > Math.min(0.0001, 8 * Number.EPSILON * ticks);
    })) invalid("price_precision", "entry/stopLoss/targets");

    const zones = structureZones(snapshot);
    const entryZone = zones.find(z => z.id === p.research.entryZoneId);
    const stopZone = zones.find(z => z.id === p.research.stopZoneId);
    const long = p.direction === "long";
    const direction = long ? 1 : -1;
    if (!entryZone || !zoneUsable(entryZone) || !inside(p.entry.min, entryZone) || !inside(p.entry.max, entryZone)) invalid("unsupported_zone", "research.entryZoneId");
    if (!stopZone || !zoneUsable(stopZone) || effectiveKind(stopZone) !== (long ? "support" : "resistance")) invalid("unsupported_zone", "research.stopZoneId");
    const stopDistance = long ? stopZone.lower - p.stopLoss : p.stopLoss - stopZone.upper;
    if (stopDistance <= 0 || stopDistance > hourlyAtr(snapshot)) invalid("unsupported_zone", "stopLoss");
    for (const [i, target] of p.targets.entries()) {
      const previous = p.targets[i - 1];
      if (previous && (target.price - previous.price) * direction <= 0) invalid("price_relationship", `targets[${i}].price`);
      const zone = zones.find(z => z.id === target.zoneId);
      if (!zone || !zoneUsable(zone) || effectiveKind(zone) !== (long ? "resistance" : "support") || !inside(target.price, zone)) {
        invalid("unsupported_target", `targets[${i}].price`);
      }
      if (targetObstacles(zones, p, target.price, zone.id).some(obstacle => significantObstacle(obstacle) &&
        !p.targets.slice(0, i).some(earlier => inside(earlier.price, obstacle)))) invalid("target_obstacle", `targets[${i}].price`);
    }
    const volumeMetrics = volumePriceMetrics(snapshot);
    if (!p.evidence.some(e => volumeMetrics.includes(e.metric))) invalid("missing_volume_price_evidence", "evidence");
  }
  return p;
}

export async function analyzeWithModel(config: Config, snapshot: Snapshot, style: Style, signal: AbortSignal, request: typeof fetch = fetch): Promise<ModelResult> {
  const schema = schemaForSnapshot(snapshot);
  const context = researchContext(snapshot);
  const marketInput = {
    ...snapshot,
    trendAlignment: context.alignment,
    openInterestChanges: context.openInterestChanges,
    candleColumns: ["openTimeMs", "open", "high", "low", "close", "volume", "takerBuyVolume"],
    frames: snapshot.frames.map(({ recentCandles, ...summary }) => ({
      ...summary,
      recentCandles: recentCandles.map(candleRow),
    })),
  };
  const system = `你是币安 USDT 永续合约行情研究助手。仅使用提供的数据，以 4h 背景、1h 结构、15m 量价组织研究。recentCandles 为依 candleColumns 排列的全部收盘成交 K 线；quote.price 是标记价格。按 style 研究趋势延续、反转或无机会，不强行给出方向，不报告胜率或收益预测。
volumePrice 最近5根，量比以此前20根均量为分母，CLV 为-1到1收盘位置；volumeWindows 对比等长前一阶段。结合量比、影线、创新高低、趋势一致性、区域的 breakRvol20、closesBeyondBreak 和 lastRetestRvol20，判断放量突破是否守住、缩量回踩或反弹。OI 与主动买量仅描述观测数据。
research 说明 marketRegime、scenario、三个周期各自结论、风险和 researchHorizon（4、12或24小时）。历史分位数来自不重叠的成交K线窗口，属于历史描述。validForSeconds 在30至300之间，用于短期复核，与研究窗口独立。
candidate 是待确认触发的候选。watch 可以给出完整计划，也可以与 none 一样清空方向、入场、止损、目标和区域引用，scenario 用 none。证据冲突或缺少结构目标时使用 watch 或 none。
有计划时，从 frames.zones 引用区域 ID。entry 的两个端点须落在 entryZoneId 区域内。止损须在 stopZoneId 不利侧边界外，离边界不超过1h ATR。做多止损区为支撑，目标区为阻力；做空相反。retested 区域支阻互换，broken 区域不可用。目标价格在各自 zoneId 的区域内，按方向由近至远。若前方有不重叠的4h区域或至少两次触达的区域，必须先给该区域的目标。每项解释选择依据和反对证据。结合目标距离、历史波幅和中间结构，无固定2R要求。
所有价位为 tickSize 整数倍且在标记价格的0.5至1.5倍内。做多 stopLoss < entry.min <= entry.max < 每个目标价；做空相反。有计划时 targets、triggerConditions、invalidationConditions、evidence、counterarguments 至少1项，evidence 至少引用一个周期的 volumePrice。每条 evidence 只能引用1个枚举指标。用简短中文，勿输出额外字段或 Markdown。
按此 JSON Schema 输出：${JSON.stringify(schema)}`;
  if (!["json_object", "json_schema"].includes(config.responseFormat) || !["false", "omit"].includes(config.enableThinking)) {
    throw new AppError("INVALID_CONFIGURATION", "结构化输出仅支持 json_object/json_schema；思考模式配置仅支持 false/omit。", 503);
  }
  const body = { model: config.model, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ style, snapshot: marketInput }) }],
    // Bailian Kimi K3.1 Pro rejects non-default sampling values; Qwen keeps the
    // existing low-temperature setting. top_p/presence_penalty use defaults.
    stream: false, temperature: config.model === "kimi-k3.1-pro" ? 1 : 0.1, max_tokens: config.maxTokens,
    ...(config.enableThinking === "omit" ? {} : { enable_thinking: false }),
    response_format: config.responseFormat === "json_schema" ? { type: "json_schema", json_schema: { name: "market_opportunity", strict: true, schema } } : { type: "json_object" },
  };
  try {
    const response = await request(config.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(config.modelTimeoutMs)]),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
      const details = await modelFailureDetails(response);
      const code = [401, 403].includes(response.status) ? "MODEL_AUTH_FAILED" : response.status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_UNAVAILABLE";
      const hint = details.upstreamCode ? `，${details.upstreamCode}` : "";
      throw new AppError(code, `百炼调用失败（HTTP ${response.status}${hint}），请检查模型参数、开通状态及 API Key 所属地域。`, 502, undefined, details);
    }
    const details: Partial<ModelOutputDetails> = { upstreamStatus: response.status, upstreamRequestId: safeRequestId(response.headers.get("x-request-id")) };
    try {
      const result = providerObject(await boundedJson(response, 96 * 1024, "INVALID_MODEL_OUTPUT"));
      details.upstreamRequestId ||= safeRequestId(result.request_id);
      const choice = providerObject(Array.isArray(result.choices) ? result.choices[0] : undefined);
      const content = providerObject(choice.message).content;
      const usage = providerObject(result.usage);
      const tokens = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
      details.inputTokens = tokens(usage.prompt_tokens); details.outputTokens = tokens(usage.completion_tokens);
      details.finishReason = typeof choice.finish_reason === "string" && ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(choice.finish_reason)
        ? choice.finish_reason as ModelOutputDetails["finishReason"] : "unknown";
      if (typeof content === "string") details.outputChars = content.length;
      if (!Array.isArray(result.choices) || result.choices.length !== 1) invalid("response_envelope");
      if (choice.finish_reason === "length") invalid("truncated");
      if (choice.finish_reason !== "stop") invalid("finish_reason");
      if (typeof content !== "string" || !content.trim()) invalid("empty_content");
      if (content.length > 24000) invalid("content_too_large");
      // Only unwrap a single complete JSON code fence. Never extract partial
      // objects, use reasoning_content, repair JSON, or change trading values.
      const trimmed = content.trim();
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
      let raw: unknown;
      try { raw = JSON.parse(fenced ? fenced[1]! : trimmed); } catch { invalid("invalid_json"); }
      return { proposal: validateProposal(raw, snapshot), usage: { inputTokens: details.inputTokens!, outputTokens: details.outputTokens! } };
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_MODEL_OUTPUT") {
        error.upstream = { ...details, outputReason: "response_envelope", ...error.upstream };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("MODEL_TIMEOUT", "百炼分析超时或连接中断，请重新获取行情后分析。", 504);
  }
}
