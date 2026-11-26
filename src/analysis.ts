import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { analyzeWithModel, evaluateProposal, RESEARCH_PROMPT_VERSION } from "./model.js";
import type { Config } from "./config.js";
import type { MarketDataProvider, ModelDecision, ModelResult, Proposal, Snapshot, Style } from "./types.js";
import { SOURCE_COMMIT } from "./version.js";
import { assessResearch, researchContext } from "./research.js";
import { candleRow } from "./market.js";
import { evaluateM1Trigger, type M1Result } from "./m1-trigger.js";
import { DETERMINISTIC_VERSION, deterministicProposal, generateM2Order, type M2Order } from "./m2-order.js";

export type Model = typeof analyzeWithModel;
export type AnalysisStage = "market_snapshot" | "deterministic" | "model" | "proposal_validation" | "quote_verification";
type DecisionCode = NonNullable<ModelDecision["normalization"]> | "model_watch" | "model_none" | "quote_outside_entry" |
  "analysis_age" | "quote_stale" | "quote_drift" | "quote_crossed_exit" | "m1_not_triggered" | "m2_no_order";
interface DecisionReason { code: DecisionCode; message: string }

export async function analyze(config: Config, provider: MarketDataProvider, symbol: string, style: Style, signal: AbortSignal,
  model: Model = analyzeWithModel, now: () => number = Date.now, onStage: (stage: AnalysisStage) => void = () => {},
  onSnapshot?: (snapshot: Snapshot, signal: AbortSignal) => void | Promise<void>) {
  const start = now();
  onStage("market_snapshot");
  const snapshot = await provider.snapshot(symbol, signal);
  if (signal.aborted) throw new AppError("REQUEST_TIMEOUT", "请求已取消或超时。", 504);
  await onSnapshot?.(snapshot, signal);
  if (signal.aborted) throw new AppError("REQUEST_TIMEOUT", "请求已取消或超时。", 504);
  let m1Trigger: M1Result | undefined;
  let m2Order: M2Order | null = null;
  let result: ModelResult;
  const modelStart = now();
  if (config.useDeterministicModels) {
    onStage("deterministic");
    m1Trigger = evaluateM1Trigger(snapshot, style);
    if (m1Trigger.triggered) m2Order = generateM2Order(snapshot, m1Trigger, style);
    result = { proposal: deterministicProposal(snapshot, m1Trigger, m2Order), usage: { inputTokens: null, outputTokens: null } };
  } else {
    if (config.useM1Trigger) m1Trigger = evaluateM1Trigger(snapshot, style);
    onStage("model");
    result = await model(config, snapshot, style, signal);
  }
  const modelEnd = now();
  onStage("proposal_validation");
  const { proposal: p, decision: validatedDecision } = evaluateProposal(result.proposal, snapshot);
  const { normalization, ...modelDecision } = result.decision ?? validatedDecision;
  const decisionReasons: DecisionReason[] = [];
  if (normalization) decisionReasons.push({ code: normalization, message: p.summary });
  else if (config.useDeterministicModels) {
    if (!m1Trigger?.triggered) decisionReasons.push({ code: "m1_not_triggered", message: p.summary });
    else if (!m2Order) decisionReasons.push({ code: "m2_no_order", message: p.summary });
  } else if (p.status === "watch") decisionReasons.push({ code: "model_watch", message: "模型主动选择观望。" });
  else if (p.status === "none") decisionReasons.push({ code: "model_none", message: "模型未识别到符合条件的机会。" });
  onStage("quote_verification");
  const latest = await provider.quote(symbol, signal);
  if (signal.aborted) throw new AppError("REQUEST_TIMEOUT", "请求已取消或超时。", 504);
  const end = now();
  const expiryReasons: DecisionReason[] = [];
  const driftBps = Math.abs(latest.price - snapshot.quote.price) / snapshot.quote.price * 10000;
  if (end - start > config.maxAnalysisAgeMs || end - start > p.validForSeconds * 1000) expiryReasons.push({ code: "analysis_age", message: "分析耗时超过本次机会的有效期限。" });
  if (end - latest.time > config.maxPriceAgeMs || latest.time > end + 2000) expiryReasons.push({ code: "quote_stale", message: "最终价格未通过新鲜度检查。" });
  if (driftBps > config.maxPriceDriftBps) expiryReasons.push({ code: "quote_drift", message: "分析期间标记价格偏移超过配置阈值。" });
  if (p.direction && p.stopLoss && p.targets.length) {
    if (p.direction === "long" && (latest.price <= p.stopLoss || latest.price >= Math.min(...p.targets.map(t => t.price))) ||
      p.direction === "short" && (latest.price >= p.stopLoss || latest.price <= Math.max(...p.targets.map(t => t.price)))) {
      expiryReasons.push({ code: "quote_crossed_exit", message: "最新价格已越过止损或首个目标。" });
    }
  }
  let status: Proposal["status"] | "expired" = expiryReasons.length ? "expired" : p.status;
  if (status === "candidate" && p.entry && (latest.price < p.entry.min || latest.price > p.entry.max)) {
    status = "watch";
    decisionReasons.push({ code: "quote_outside_entry", message: `分析后的标记价 ${latest.price} 不在候选入场区间 ${p.entry.min}–${p.entry.max} 内。` });
  }
  const entryReference = p.entry ? (p.direction === "long" ? p.entry.max : p.entry.min) : null;
  const risk = entryReference && p.stopLoss ? Math.abs(entryReference - p.stopLoss) : null;
  return {
    schemaVersion: 4, analysisId: randomUUID(), symbol, style, status,
    ...(m1Trigger ? { m1Trigger } : {}),
    ...(config.useDeterministicModels ? { decisionSource: "deterministic" as const, m2Order } : {}),
    decision: { ...modelDecision, reasons: [...decisionReasons, ...expiryReasons] },
    opportunity: { ...p, status, rewardRisk: p.targets.map(t => ({ target: t.price, ratio: risk ? Math.abs(t.price - entryReference!) / risk : null })),
      triggerVerified: false, priceReference: "markPrice", expiredReasons: expiryReasons.map(reason => reason.message) },
    research: assessResearch(snapshot, p),
    market: { tickSize: snapshot.tickSize, ...researchContext(snapshot), asOf: snapshot.asOf, frames: snapshot.frames.map(({ recentCandles: _candles, zones: _zones, historicalRanges: _ranges, priceLevels: _priceLevels, ...f }) => f),
      chart: snapshot.frames.map(f => ({ interval: f.interval, candles: f.recentCandles.map(candleRow) })),
      initialQuote: snapshot.quote, latestQuote: latest, priceDriftBps: driftBps, openInterest: snapshot.openInterest, source: snapshot.source, warnings: snapshot.warnings },
    timing: { requestedAt: start, completedAt: end, finalQuoteTime: latest.time,
      validUntil: Math.min(start + p.validForSeconds * 1000, start + config.maxAnalysisAgeMs),
      marketMs: modelStart - start, modelMs: config.useDeterministicModels ? 0 : modelEnd - modelStart,
      ...(config.useDeterministicModels ? { deterministicMs: modelEnd - modelStart } : {}),
      verificationMs: end - modelEnd, totalMs: end - start },
    model: { name: config.useDeterministicModels ? "m1-m2" : config.model,
      promptVersion: config.useDeterministicModels ? DETERMINISTIC_VERSION : RESEARCH_PROMPT_VERSION, ...result.usage }, codeVersion: SOURCE_COMMIT,
    notes: [config.useDeterministicModels ? "手动交易须复核价格并确认委托。" : "百炼结果用于研究比较。",
      "盈亏比按入场区间不利端估算，未计手续费、滑点和资金费。"],
  };
}
