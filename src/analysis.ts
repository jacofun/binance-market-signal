import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { analyzeWithModel } from "./model.js";
import type { Config } from "./config.js";
import type { MarketDataProvider, ModelResult, Proposal, Style } from "./types.js";
import { SOURCE_COMMIT } from "./version.js";

export type Model = typeof analyzeWithModel;
export async function analyze(config: Config, provider: MarketDataProvider, symbol: string, style: Style, signal: AbortSignal,
  model: Model = analyzeWithModel, now: () => number = Date.now) {
  const start = now();
  const snapshot = await provider.snapshot(symbol, signal);
  if (signal.aborted) throw new AppError("REQUEST_TIMEOUT", "请求已取消或超时。", 504);
  const modelStart = now();
  const result: ModelResult = await model(config, snapshot, style, signal);
  const modelEnd = now();
  const latest = await provider.quote(symbol, signal);
  if (signal.aborted) throw new AppError("REQUEST_TIMEOUT", "请求已取消或超时。", 504);
  const end = now();
  const reasons: string[] = [];
  const driftBps = Math.abs(latest.price - snapshot.quote.price) / snapshot.quote.price * 10000;
  if (end - start > config.maxAnalysisAgeMs || end - start > result.proposal.validForSeconds * 1000) reasons.push("分析耗时超过本次机会的有效期限。");
  if (end - latest.time > config.maxPriceAgeMs || latest.time > end + 2000) reasons.push("最终价格未通过新鲜度检查。");
  if (driftBps > config.maxPriceDriftBps) reasons.push("分析期间标记价格偏移超过配置阈值。");
  const p = result.proposal;
  if (p.direction && p.stopLoss && p.targets.length) {
    if (p.direction === "long" && (latest.price <= p.stopLoss || latest.price >= Math.min(...p.targets.map(t => t.price))) ||
      p.direction === "short" && (latest.price >= p.stopLoss || latest.price <= Math.max(...p.targets.map(t => t.price)))) reasons.push("最新价格已越过止损或首个目标。");
  }
  let status: Proposal["status"] | "expired" = reasons.length ? "expired" : p.status;
  if (status === "candidate" && p.entry && (latest.price < p.entry.min || latest.price > p.entry.max)) status = "watch";
  const entryReference = p.entry ? (p.direction === "long" ? p.entry.max : p.entry.min) : null;
  const risk = entryReference && p.stopLoss ? Math.abs(entryReference - p.stopLoss) : null;
  return {
    schemaVersion: 1, analysisId: randomUUID(), symbol, style, status,
    opportunity: { ...p, status, rewardRisk: p.targets.map(t => ({ target: t.price, ratio: risk ? Math.abs(t.price - entryReference!) / risk : null })),
      triggerVerified: false, priceReference: "markPrice", expiredReasons: reasons },
    market: { asOf: snapshot.asOf, frames: snapshot.frames.map(({ recentCandles: _candles, ...f }) => f),
      initialQuote: snapshot.quote, latestQuote: latest, priceDriftBps: driftBps, openInterest: snapshot.openInterest, source: snapshot.source, warnings: snapshot.warnings },
    timing: { requestedAt: start, completedAt: end, finalQuoteTime: latest.time,
      validUntil: Math.min(start + p.validForSeconds * 1000, start + config.maxAnalysisAgeMs),
      marketMs: modelStart - start, modelMs: modelEnd - modelStart, verificationMs: end - modelEnd, totalMs: end - start },
    model: { name: config.model, promptVersion: "market-research-v2", ...result.usage }, codeVersion: SOURCE_COMMIT,
    notes: ["候选研究结果，触发条件须人工确认；不自动下单。", "盈亏比按入场区间不利端估算，未计手续费、滑点和资金费。"],
  };
}
