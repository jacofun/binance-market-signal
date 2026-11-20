import { AppError, type ModelFailureDetails, type ModelOutputDetails, type ValidationDetails } from "./errors.js";
import { boundedJson } from "./http.js";
import { effectiveKind } from "./price-zones.js";
import { inside, researchContext, significantObstacle, structureZones, targetObstacles, zoneUsable } from "./research.js";
import { candleRow } from "./market.js";
import type { Config } from "./config.js";
import type { ModelDecision, ModelResult, PriceZone, Proposal, Snapshot, Style } from "./types.js";

export const RESEARCH_PROMPT_VERSION = "market-research-v4-volume-timing-v6";
export const AUTO_SCAN_PROMPT_VERSION = `${RESEARCH_PROMPT_VERSION}-auto-scan`;
export const AUTO_ORDER_PROMPT_VERSION = `${AUTO_SCAN_PROMPT_VERSION}-immediate-v1`;

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
function invalid(outputReason: ModelOutputDetails["outputReason"] = "schema", outputField?: string, validation?: ValidationDetails, cause?: unknown): never {
  const hint = outputReason === "truncated" ? "模型输出被截断，请检查 DASHSCOPE_MAX_TOKENS 和思考模式配置。" : "模型返回的机会结构或价位关系无效，本次结果不作为交易机会。";
  throw new AppError("INVALID_MODEL_OUTPUT", hint, 502, undefined, { outputReason, ...(outputField ? { outputField } : {}) }, { validation, cause });
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
const zoneSummary = (zone: PriceZone) => ({
  id: zone.id, status: zone.status, lower: zone.lower, upper: zone.upper, effectiveKind: effectiveKind(zone),
});

function onPriceGrid(price: number, tickSize: number): boolean {
  const ticks = price / tickSize;
  return Number.isFinite(ticks) && ticks <= Number.MAX_SAFE_INTEGER / 8 &&
    Math.abs(Math.round(ticks) - ticks) <= Math.min(0.0001, 8 * Number.EPSILON * ticks);
}

function selectablePriceRange(zone: PriceZone, tickSize: number) {
  if (!zoneUsable(zone) || !Number.isFinite(tickSize) || tickSize <= 0) return null;
  const [mantissa, exponent = "0"] = tickSize.toString().split("e");
  const decimals = Math.max(0, (mantissa?.split(".")[1]?.length ?? 0) - Number(exponent));
  if (decimals > 100) return null;
  const priceAt = (ticks: number) => Number((ticks * tickSize).toFixed(decimals));
  // Compare normalized prices to the original edges. The division itself
  // can place an already valid edge just above or below its integer tick.
  const below = Math.floor(zone.lower / tickSize);
  const above = Math.ceil(zone.upper / tickSize);
  const min = priceAt(priceAt(below) >= zone.lower ? below : below + 1);
  const max = priceAt(priceAt(above) <= zone.upper ? above : above - 1);
  return min > 0 && min <= max && inside(min, zone) && inside(max, zone) &&
    onPriceGrid(min, tickSize) && onPriceGrid(max, tickSize) ? { min, max } : null;
}

function zoneReference(id: string | null, zone?: PriceZone): Pick<ValidationDetails, "requestedZoneId" | "zoneReference" | "zone"> {
  if (zone) return { requestedZoneId: zone.id, zone: zoneSummary(zone) };
  if (id === null) return { zoneReference: "missing" };
  // Never log arbitrary strings generated by the model as zone identifiers.
  if (!/^(4h|1h|15m):(support|resistance):[0-9]{1,16}$/.test(id)) return { zoneReference: "malformed" };
  return { zoneReference: "formatted", requestedZoneId: id };
}

function researchOnly(p: Proposal, title: string, summary: string): Proposal {
  return {
    ...p, title, summary, status: "watch", direction: null, entry: null,
    stopLoss: null, targets: [], triggerConditions: [], invalidationConditions: [],
    research: { ...p.research, scenario: "none", entryZoneId: null, stopZoneId: null },
  };
}

export function validateProposal(raw: unknown, snapshot: Snapshot): Proposal {
  return evaluateProposal(raw, snapshot).proposal;
}

export function evaluateProposal(raw: unknown, snapshot: Snapshot, preserveResearchOnBlockedTarget = false): {
  proposal: Proposal; decision: ModelDecision;
} {
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
  const decision: ModelDecision = { modelStatus: p.status, modelDirection: p.direction, modelSummary: p.summary };
  // A directional outlook without an entry cannot become an order plan.
  // Preserve the validated research and discard all execution details.
  if (p.entry === null && p.direction !== null && p.status !== "none" && p.research.scenario !== "none") {
    return {
      proposal: researchOnly(p, "等待确认入场区间",
        `模型给出了${p.direction === "long" ? "偏多" : "偏空"}的研究判断，但未提供入场区间。本次仅供观察。`),
      decision: { ...decision, normalization: "entry_missing" },
    };
  }

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
    const reject = (reason: ModelOutputDetails["outputReason"], field: string, details: ValidationDetails): never => invalid(reason, field, {
      direction: p.direction!, snapshotAsOf: snapshot.asOf, tickSize: snapshot.tickSize, ...details,
    });

    const q = snapshot.quote.price;
    const prices = [{ field: "entry.min", price: p.entry.min }, { field: "entry.max", price: p.entry.max },
      { field: "stopLoss", price: p.stopLoss }, ...p.targets.map((t, i) => ({ field: `targets[${i}].price`, price: t.price }))];
    const badScale = prices.find(({ price }) => price < q * 0.5 || price > q * 1.5);
    if (badScale) reject("price_scale", "entry/stopLoss/targets", { reason: "price_out_of_scale", markPrice: q, ...badScale });
    const badTick = prices.find(({ price }) => !onPriceGrid(price, snapshot.tickSize));
    if (badTick) reject("price_precision", "entry/stopLoss/targets", { reason: "price_off_tick_grid", ...badTick });

    const zones = structureZones(snapshot);
    const long = p.direction === "long";
    const direction = long ? 1 : -1;
    function requireZone(id: string | null, field: string, error: "unsupported_zone" | "unsupported_target",
      details: { entry?: NonNullable<Proposal["entry"]>; price?: number; expectedKind?: "support" | "resistance" }): PriceZone {
      const zone = zones.find(z => z.id === id);
      const context = { ...details, ...zoneReference(id, zone), zoneCount: zones.length };
      if (!zone) return reject(error, field, { reason: "zone_not_found", ...context });
      if (!zoneUsable(zone)) reject(error, field, { reason: "zone_broken", ...context });
      if (details.expectedKind && effectiveKind(zone) !== details.expectedKind) reject(error, field, { reason: "zone_wrong_kind", ...context });
      return zone;
    }

    const entryZone = requireZone(p.research.entryZoneId, "research.entryZoneId", "unsupported_zone", { entry: p.entry });
    if (!inside(p.entry.min, entryZone) || !inside(p.entry.max, entryZone)) reject("unsupported_zone", "research.entryZoneId",
      { reason: "entry_out_of_bounds", ...zoneReference(p.research.entryZoneId, entryZone), entry: p.entry,
        selectablePriceRange: selectablePriceRange(entryZone, snapshot.tickSize) });

    requireZone(p.research.stopZoneId, "research.stopZoneId", "unsupported_zone",
      { price: p.stopLoss, expectedKind: long ? "support" : "resistance" });

    let blockedBy: PriceZone | undefined;
    for (const [i, target] of p.targets.entries()) {
      const field = `targets[${i}].price`;
      const previous = p.targets[i - 1];
      if (previous && (target.price - previous.price) * direction <= 0) invalid("price_relationship", field);
      const zone = requireZone(target.zoneId, field, "unsupported_target", { price: target.price, expectedKind: long ? "resistance" : "support" });
      if (!inside(target.price, zone)) reject("unsupported_target", field,
        { reason: "target_out_of_bounds", zone: zoneSummary(zone), price: target.price,
          selectablePriceRange: selectablePriceRange(zone, snapshot.tickSize) });
      const blocker = targetObstacles(zones, p, target.price, zone.id).find(obstacle => significantObstacle(obstacle) &&
        !p.targets.slice(0, i).some(earlier => inside(earlier.price, obstacle)));
      if (blocker && !preserveResearchOnBlockedTarget) reject("target_obstacle", field, {
        reason: "target_skips_obstacle", zone: zoneSummary(zone), price: target.price, blockingZone: zoneSummary(blocker),
      });
      blockedBy ??= blocker;
    }
    const volumeMetrics = volumePriceMetrics(snapshot);
    if (!p.evidence.some(e => volumeMetrics.includes(e.metric))) invalid("missing_volume_price_evidence", "evidence");
    if (blockedBy) {
      const range = selectablePriceRange(blockedBy, snapshot.tickSize);
      const area = `${blockedBy.interval} ${long ? "阻力区" : "支撑区"}${range ? `（${range.min}–${range.max}）` : ""}`;
      return {
        proposal: researchOnly(p, "目标前方存在重要结构",
          `模型提出的目标跳过了更近的 ${area}。本次仅供观察。`),
        decision: { ...decision, normalization: "target_obstacle" },
      };
    }
  }
  return { proposal: p, decision };
}

export async function analyzeWithModel(config: Config, snapshot: Snapshot, style: Style, signal: AbortSignal,
  request: typeof fetch = fetch, scanEvidence?: import("./market-scanner.js").ScanEvidence, immediate = false): Promise<ModelResult> {
  const schema = schemaForSnapshot(snapshot);
  const context = researchContext(snapshot);
  const marketInput = {
    ...snapshot,
    trendAlignment: context.alignment,
    openInterestChanges: context.openInterestChanges,
    candleColumns: ["openTimeMs", "open", "high", "low", "close", "volume", "takerBuyVolume"],
    frames: snapshot.frames.map(({ recentCandles, zones, ...summary }) => ({
      ...summary,
      recentCandles: recentCandles.map(candleRow),
      zones: zones.map(zone => ({
        ...zone, selectablePriceRange: selectablePriceRange(zone, snapshot.tickSize),
        effectiveKind: effectiveKind(zone), importantObstacle: zoneUsable(zone) && significantObstacle(zone),
      })),
    })),
  };
  const system = `你是币安 USDT 永续合约行情研究助手。仅使用提供的数据，以 4h 背景、1h 结构、15m 量价组织研究。recentCandles 为依 candleColumns 排列的全部收盘成交 K 线。quote.price 是标记价格。style 指示优先研究趋势延续或翻转，最终判断取决于证据。使用短句，不强行给出方向，不报告胜率或收益预测。

量价按波段比较。在同一周期和同一成交量口径下，对比前一段趋势推进、反向调整和当前尝试恢复三段，指出价格推进幅度、每根均量或量比、收盘是否守住关键区。长短不同的波段比较每根均量或相对量，避免直接比较总量。放量时检查价格是否取得有效进展，缩量时检查价格是否仍能推进。对重要判断注明周期和观测值。缺少相应波段或可比数据时说明缺口，等待确认，不编造数据。
volumePrice 为最近5根的明细，量比以此前20根均量为分母，CLV 为-1到1收盘位置。volumeWindows 对比等长前一阶段。可结合影线、创新高低、区域的 breakRvol20、closesBeyondBreak 和 lastRetestRvol20 判断突破后是否站稳。OI 与主动买量仅描述观测数据，不用来推断持仓者身份或开平方向。

顺大周期、逆小周期。趋势延续以 4h 为方向依据，在 1h 找到回调仍属于原趋势的结构及失效边界，用 15m 判断反向调整处于进行中、趋于停顿还是已确认顺势恢复。趋势未破坏且 15m 已收盘确认恢复，例如收复回调内部阻力或跌破反弹内部支撑，才考虑候选。若参与整理后的顺势突破，说明 15m 收盘是否有效越过边缘、后续是否站稳，以及当前位置到首个目标的空间。确认后价格已远离合法入场区或紧贴重要反向区时，转为等待回测或放弃。
翻转明确发生在哪个周期。比较原方向两次推进时价格与量能的变化，量价背离用作动能减弱证据。判断 1h 结构翻转时，指出原方向在哪个关键区推进失败，以及哪根 1h K 线收盘收复或跌破了哪个结构位。仅有 15m 背离、单根长影线或小周期回收时，等待相应级别确认。4h 方向不清时，按区间或转换分析，避免强行判为趋势延续。

summary 首句明确写出做多候选、做空候选、等待确认或放弃。research 交代 marketRegime、scenario、三个周期的证据、风险和 researchHorizon（4、12或24小时）。历史分位数来自不重叠的成交 K 线窗口，属于历史描述。validForSeconds 在30至300之间，用于本次报价复核，与研究窗口独立。
candidate 表示快照中已有时机证据，${immediate ? "本次候选会进入即时下单复核。只有已收盘数据确认入场时机、当前报价在入场区内，且无需等待下一根 K 线、回测或其他条件时才给 candidate。" : "实际入场仍须人工复核 triggerConditions。"}只要 direction 是 long 或 short，就必须提供完整计划，entry 必须是含数值 min 和 max 的对象，并给出 stopLoss、至少一个 target 及对应区间。只有方向参考、还没有可用入场区间时，输出无计划的 watch，在 summary 和周期解读中说明方向倾向以及仍需确认的条件。方向或结构机会失效时输出 none，并说明放弃原因。无计划时 direction、entry、stopLoss、research.entryZoneId、research.stopZoneId 全部为 null，targets 为空数组，research.scenario 为 none。
有计划时，在 triggerConditions 写明${immediate ? "已出现的收盘证据和下单前须复核的入场区间。任何仍待确认的条件都应返回 watch 或 none。" : "入场前仍需核对的价格区和可观察的收盘条件，注明周期和价位。"}止盈、止损沿用 targets、stopLoss。invalidationConditions 区分【未入场失效】和【持仓提前退出】。前者写明何时取消候选，后者结合放量但推进受阻或背离等预警，指出后续收盘破坏哪个局部结构时应提前退出。若缺少独立的提前退出依据，说明按原定目标和结构止损复核。价格和量能条件须基于本次行情。价格收盘条件使用成交 K 线。

有计划时，从 frames.zones 引用区域 ID。入场两端和每个目标价须落在各自引用区域的 selectablePriceRange.min 至 max 之间（含端点）。这是程序按 tickSize 向区间内取整的可用范围。靠近边界时直接使用对应的 min 或 max，勿自行四舍五入原始 lower 或 upper。selectablePriceRange 为空的区域不可用于入场或目标。找不到符合条件的计划时使用 watch 或 none。
stopZoneId 引用有效结构作为止损参考，做多引用支撑、做空引用阻力。综合量价、局部失效位和 1h ATR 自主决定 stopLoss，区域边缘和 ATR 是研究参考。做空可以在阻力区内或其下方设置更近的止损，前提是止损严格高于 entry.max；做多止损严格低于 entry.min。解释为什么这个价位代表失效，以及较近止损被正常波动触发的风险。目标区做多选阻力，做空选支撑。按 effectiveKind 识别有效支阻，broken 区域不可用。
目标按价格路径由近至远，合并查看全部周期。做空从 entry.min 向下，按有效支撑区的上沿由高到低考虑。做多从 entry.max 向上，按有效阻力区的下沿由低到高考虑。每个远端目标之前，若有整个区域位于入场边界和该目标之间、与引用目标区不重叠且 importantObstacle 为 true 的区域，目标列表必须先有一个价位落在该近端区域。即使近端是 15m、远端是 1h 或 4h，也按同一规则。无法先给出有依据的近端目标时，返回无计划的 watch 或 none。结合目标距离、历史波幅和反对证据说明依据，无固定2R要求。
所有价位为 tickSize 整数倍且在标记价格的0.5至1.5倍内。做多 stopLoss < entry.min <= entry.max < 每个目标价；做空相反。有计划时 targets、triggerConditions、invalidationConditions、evidence、counterarguments 至少1项，evidence 至少引用一个周期的 volumePrice。每条 evidence 只能引用1个枚举指标。用简短中文，勿输出额外字段或 Markdown。
${scanEvidence ? `以专业交易员视角独立决策。优先选择有结构依据、在可接受下行风险下有最大合理盈利空间的方案，同时评估反向证据、流动性障碍和目标可达性。scanEvidence 是程序初筛的历史观测，包含每条规则的命中状态、方向、区域和逐项检查。逐项核对关键证据，明确写出接受、否定或需要确认的理由。扫描方向和 style 是研究线索，由你根据完整行情决定是否采纳。初筛区域来自形态开始时的快照，价格引用仅能使用本次 snapshot 的合法区域。
` : ""}按此 JSON Schema 输出：${JSON.stringify(schema)}`;
  if (!["json_object", "json_schema"].includes(config.responseFormat) || !["false", "omit"].includes(config.enableThinking)) {
    throw new AppError("INVALID_CONFIGURATION", "结构化输出仅支持 json_object/json_schema；思考模式配置仅支持 false/omit。", 503);
  }
  const body = { model: config.model, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ style, snapshot: marketInput, ...(scanEvidence ? { scanEvidence } : {}) }) }],
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
      try { raw = JSON.parse(fenced ? fenced[1]! : trimmed); } catch (error) { invalid("invalid_json", undefined, undefined, error); }
      return { ...evaluateProposal(raw, snapshot, true), usage: { inputTokens: details.inputTokens!, outputTokens: details.outputTokens! } };
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_MODEL_OUTPUT") {
        error.upstream = { ...details, outputReason: "response_envelope", ...error.upstream };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("MODEL_TIMEOUT", "百炼分析超时或连接中断，请重新获取行情后分析。", 504, undefined, undefined, { cause: error });
  }
}
