import { AppError, type ModelFailureDetails, type ModelOutputDetails } from "./errors.js";
import { boundedJson } from "./http.js";
import type { Config } from "./config.js";
import type { ModelResult, Proposal, Snapshot, Style } from "./types.js";

const text = { type: "string", minLength: 1, maxLength: 600 };
const list = { type: "array", items: text, maxItems: 8 };
export const proposalSchema = {
  type: "object", additionalProperties: false,
  required: ["status", "direction", "title", "summary", "entry", "stopLoss", "targets", "triggerConditions", "invalidationConditions", "evidence", "counterarguments", "validForSeconds"],
  properties: {
    status: { type: "string", enum: ["candidate", "watch", "none"] }, direction: { type: ["string", "null"], enum: ["long", "short", null] },
    title: text, summary: text,
    entry: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["min", "max"], properties: { min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 } } }] },
    stopLoss: { type: ["number", "null"] }, targets: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["price", "reason"], properties: { price: { type: "number", exclusiveMinimum: 0 }, reason: text } } },
    triggerConditions: list, invalidationConditions: list,
    evidence: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["metric", "reason"], properties: { metric: text, reason: text } } },
    counterarguments: list, validForSeconds: { type: "integer", minimum: 30, maximum: 300 },
  },
};
function invalid(outputReason: ModelOutputDetails["outputReason"] = "schema", outputField?: string): never {
  const hint = outputReason === "truncated" ? "模型输出被截断，请检查 DASHSCOPE_MAX_TOKENS 和思考模式配置。" : "模型返回的机会结构或价位关系无效，本次结果不作为交易机会。";
  throw new AppError("INVALID_MODEL_OUTPUT", hint, 502, undefined, { outputReason, ...(outputField ? { outputField } : {}) });
}

function allowedMetrics(snapshot: Snapshot): string[] {
  return ["quote.price", "quote.indexPrice", "quote.fundingRate", ...(snapshot.openInterest.length ? ["openInterest"] : []),
    ...snapshot.frames.flatMap(f => ["close", "ema20", "ema50", "atr14", "volumeRatio20", "high20", "low20", "recentCandles"].map(k => `${f.interval}.${k}`))];
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
  const p: Proposal = {
    status: r.status as Proposal["status"], direction: r.direction as Proposal["direction"], title: string(r.title, "title"), summary: string(r.summary, "summary"),
    entry: r.entry === null ? null : (() => { const e = object(r.entry, ["min", "max"], "entry"); return { min: price(e.min, "entry.min"), max: price(e.max, "entry.max") }; })(),
    stopLoss: r.stopLoss === null ? null : price(r.stopLoss, "stopLoss"),
    targets: r.targets.map((t, i) => { const f = `targets[${i}]`; const v = object(t, ["price", "reason"], f); return { price: price(v.price, `${f}.price`), reason: string(v.reason, `${f}.reason`) }; }),
    triggerConditions: strings(r.triggerConditions, "triggerConditions"), invalidationConditions: strings(r.invalidationConditions, "invalidationConditions"), counterarguments: strings(r.counterarguments, "counterarguments"),
    evidence: r.evidence.map((e, i) => { const f = `evidence[${i}]`; const v = object(e, ["metric", "reason"], f); const metric = string(v.metric, `${f}.metric`); if (!metrics.has(metric)) invalid("unsupported_metric", `${f}.metric`); return { metric, reason: string(v.reason, `${f}.reason`) }; }),
    validForSeconds: Number(r.validForSeconds),
  };
  if (p.status === "none") {
    if (p.direction !== null || p.entry !== null || p.stopLoss !== null || p.targets.length) invalid("schema", "none");
  } else {
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
  }
  return p;
}

export async function analyzeWithModel(config: Config, snapshot: Snapshot, style: Style, signal: AbortSignal, request: typeof fetch = fetch): Promise<ModelResult> {
  const schema = schemaForSnapshot(snapshot);
  const system = `你是合约行情研究助手。只分析所提供的币安 USDT 永续行情，不使用外部新闻、账户信息或臆造指标。输出严格 JSON，不使用 Markdown。
这是候选研究机会，不执行交易。允许暂无机会。candidate 仅表示候选价位，不表示自然语言触发条件已经满足；需要未来确认时用 watch。
根据日线、4小时、1小时综合分析，风格由 style 指定；不得把所有行情强行解释成信号。不报告未经校准的胜率或确定性收益。
所有价格参考为标记价格。给出入场区间、止损、1至3个目标、触发条件、失效条件、反对理由。
none 时 direction/entry/stopLoss 为 null，targets 为空。其余状态须给出完整价位、证据和反对理由。
evidence.metric 必须引用输入中的 quote.price/quote.indexPrice/quote.fundingRate/openInterest 或 1h、4h、1d 的 close/ema20/ema50/atr14/volumeRatio20/high20/low20/recentCandles；数据不存在时禁止引用。
validForSeconds 必须为30至300之间的整数。所有价位必须为 JSON 数字，不能用字符串；entry.min <= entry.max。
做多必须 stopLoss < entry.min <= entry.max < 每个目标价；做空必须 每个目标价 < entry.min <= entry.max < stopLoss。所有价位须在当前 quote.price 的0.5至1.5倍内，否则返回 none。
candidate/watch 的 targets、triggerConditions、invalidationConditions、evidence、counterarguments 均至少1项。每条 evidence 只能引用1个枚举指标，不得用逗号、斜杠合并多个指标，也不加 snapshot/frames 前缀。
输出精简：title不超过30字，summary不超过120字，其余说明每项不超过80字，各列表建议1至3项，不添加 Schema 之外的字段。
缺少或矛盾的数据须明确说明，不得用零代替缺失。按此 JSON Schema 输出：${JSON.stringify(schema)}
无机会时的完整结构示例：{"status":"none","direction":null,"title":"暂无机会","summary":"当前条件不足，等待确认","entry":null,"stopLoss":null,"targets":[],"triggerConditions":[],"invalidationConditions":[],"evidence":[],"counterarguments":["缺少明确触发条件"],"validForSeconds":120}`;
  if (!["json_object", "json_schema"].includes(config.responseFormat) || !["false", "omit"].includes(config.enableThinking)) {
    throw new AppError("INVALID_CONFIGURATION", "结构化输出仅支持 json_object/json_schema；思考模式配置仅支持 false/omit。", 503);
  }
  const body = { model: config.model, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ style, snapshot }) }],
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
