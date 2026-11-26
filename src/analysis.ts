import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { analyzeWithModel, evaluateProposal, RESEARCH_PROMPT_VERSION } from "./model.js";
import type { Config } from "./config.js";
import type { MarketDataProvider, ModelDecision, ModelResult, Proposal, Style } from "./types.js";
import { SOURCE_COMMIT } from "./version.js";
import { assessResearch, researchContext } from "./research.js";
import { candleRow } from "./market.js";
import { evaluateM1Trigger } from "./m1-trigger.js";

export type Model = typeof analyzeWithModel;
export type AnalysisStage = "market_snapshot" | "model" | "proposal_validation" | "quote_verification";
type DecisionCode = NonNullable<ModelDecision["normalization"]> | "model_watch" | "model_none" | "quote_outside_entry" |
  "analysis_age" | "quote_stale" | "quote_drift" | "quote_crossed_exit";
interface DecisionReason { code: DecisionCode; message: string }

export async function analyze(config: Config, provider: MarketDataProvider, symbol: string, style: Style, signal: AbortSignal,
  model: Model = analyzeWithModel, now: () => number = Date.now, onStage: (stage: AnalysisStage) => void = () => {}) {
  const start = now();
  onStage("market_snapshot");
  const snapshot = await provider.snapshot(symbol, signal);
  if (signal.aborted) throw new AppError("REQUEST_TIMEOUT", "请求已取消或超时。", 504);
  const m1Trigger = config.useM1Trigger ? evaluateM1Trigger(snapshot, style) : undefined;
  const modelStart = now();
  onStage("model");
  const result: ModelResult = await model(config, snapshot, style, signal);
  const modelEnd = now();
  onStage("proposal_validation");
  const { proposal: p, decision: validatedDecision } = evaluateProposal(result.proposal, snapshot);
  const { normalization, ...modelDecision } = result.decision ?? validatedDecision;
  const decisionReasons: DecisionReason[] = [];
  if (normalization) decisionReasons.push({ code: normalization, message: p.summary });
  else if (p.status === "watch") decisionReasons.push({ code: "model_watch", message: "模型主动选择观望。" });
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
    decision: { ...modelDecision, reasons: [...decisionReasons, ...expiryReasons] },
    opportunity: { ...p, status, rewardRisk: p.targets.map(t => ({ target: t.price, ratio: risk ? Math.abs(t.price - entryReference!) / risk : null })),
      triggerVerified: false, priceReference: "markPrice", expiredReasons: expiryReasons.map(reason => reason.message) },
    research: assessResearch(snapshot, p),
    market: { tickSize: snapshot.tickSize, ...researchContext(snapshot), asOf: snapshot.asOf, frames: snapshot.frames.map(({ recentCandles: _candles, zones: _zones, historicalRanges: _ranges, priceLevels: _priceLevels, ...f }) => f),
      chart: snapshot.frames.map(f => ({ interval: f.interval, candles: f.recentCandles.map(candleRow) })),
      initialQuote: snapshot.quote, latestQuote: latest, priceDriftBps: driftBps, openInterest: snapshot.openInterest, source: snapshot.source, warnings: snapshot.warnings },
    timing: { requestedAt: start, completedAt: end, finalQuoteTime: latest.time,
      validUntil: Math.min(start + p.validForSeconds * 1000, start + config.maxAnalysisAgeMs),
      marketMs: modelStart - start, modelMs: modelEnd - modelStart, verificationMs: end - modelEnd, totalMs: end - start },
    model: { name: config.model, promptVersion: RESEARCH_PROMPT_VERSION, ...result.usage }, codeVersion: SOURCE_COMMIT,
    notes: ["候选研究结果，触发条件须人工确认；不自动下单。", "盈亏比按入场区间不利端估算，未计手续费、滑点和资金费。"],
  };
}
