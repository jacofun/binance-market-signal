import type { M1Result } from "./m1-trigger.js";
import { tickPriceRange } from "./price-grid.js";
import { distanceToZone, effectiveKind } from "./price-zones.js";
import { blockingTargetObstacle, structureZones, zoneUsable } from "./research.js";
import type { Proposal, Snapshot, Style, TriggerInterval } from "./types.js";

export const DETERMINISTIC_VERSION = "deterministic-m1-m2-v1";
export const DETERMINISTIC_5M_VERSION = "deterministic-m1-m2-v2-5m";
const thresholds = {
  entryHalfWidthAtr: 0.15,
  maxEntryDistanceAtr: 0.5,
  stopBufferAtr: 0.15,
  minStopDistanceAtr: 0.5,
  maxRiskAtr: 2,
  minFirstTargetR: 1.5,
  maxTargetDistanceAtr: 6,
  maxTargets: 2,
  validForSeconds: 120,
};

export interface M2Order {
  direction: NonNullable<Proposal["direction"]>;
  entryRange: NonNullable<Proposal["entry"]>;
  stopLoss: number;
  takeProfits: { price: number; zoneId: string; rMultiple: number }[];
  riskReward: number;
  reasons: string[];
  keyFeatures: {
    style: Style; asOf: number; markPrice: number; tickSize: number; atr15m: number; rvol20: number; triggerInterval: TriggerInterval;
    entryZoneId: string; stopZoneId: string; worstEntryPrice: number; riskDistance: number;
  };
}

export function generateM2Order(snapshot: Snapshot, m1Result: M1Result, style?: string): M2Order | null {
  const signal = m1Result.keyFeatures;
  const { direction } = signal;
  const short = snapshot.frames.find(frame => frame.interval === "15m");
  const triggerFrame = snapshot.triggerFrame ?? short;
  const triggerInterval = snapshot.triggerFrame?.interval ?? "15m";
  if (m1Result.triggered !== true || !direction || !signal.setup || !signal.zone || !short ||
    !triggerFrame || signal.asOf !== snapshot.asOf || (signal.triggerInterval ?? "15m") !== triggerInterval ||
    signal.lastCloseTime !== triggerFrame.lastCloseTime ||
    (style !== undefined && style !== signal.style)) return null;
  const { atr14: atr } = short;
  const rvol20 = triggerFrame.volumePrice.at(-1)?.volumeRatio20;
  const { tickSize } = snapshot;
  const markPrice = snapshot.quote.price;
  if (!Number.isFinite(atr) || atr <= 0 || rvol20 == null || !Number.isFinite(rvol20) ||
    !Number.isFinite(markPrice) || markPrice <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) return null;

  const long = direction === "long";
  const side = long ? 1 : -1;
  const zones = structureZones(snapshot);
  const zone = zones.find(item => item.id === signal.zone?.id);
  if (!zone || !zoneUsable(zone) || effectiveKind(zone) !== (long ? "support" : "resistance") ||
    (long ? markPrice < zone.lower : markPrice > zone.upper) ||
    distanceToZone(zone, markPrice) > thresholds.maxEntryDistanceAtr * atr) return null;

  const minPrice = Math.max(tickSize, markPrice * 0.5);
  const maxPrice = Math.min(1e12, markPrice * 1.5);
  const center = Math.min(zone.upper, Math.max(zone.lower, markPrice));
  const halfWidth = thresholds.entryHalfWidthAtr * atr;
  const reach = thresholds.maxEntryDistanceAtr * atr;
  const entryRange = tickPriceRange(Math.max(zone.lower, center - halfWidth, markPrice - reach, minPrice),
    Math.min(zone.upper, center + halfWidth, markPrice + reach, maxPrice), tickSize);
  if (!entryRange) return null;

  const buffer = Math.max(tickSize, thresholds.stopBufferAtr * atr);
  const minStop = thresholds.minStopDistanceAtr * atr;
  const stopLoss = long ?
    tickPriceRange(minPrice, Math.min(zone.lower - buffer, entryRange.min - minStop), tickSize)?.max :
    tickPriceRange(Math.max(zone.upper + buffer, entryRange.max + minStop), maxPrice, tickSize)?.min;
  if (stopLoss === undefined || (long ? stopLoss >= entryRange.min : stopLoss <= entryRange.max)) return null;
  const worstEntryPrice = long ? entryRange.max : entryRange.min;
  const riskDistance = (worstEntryPrice - stopLoss) * side;
  if (riskDistance <= 0 || riskDistance > thresholds.maxRiskAtr * atr) return null;

  const targetZones = zones.filter(item => zoneUsable(item) && effectiveKind(item) === (long ? "resistance" : "support") &&
    (long ? item.lower > worstEntryPrice : item.upper < worstEntryPrice))
    .sort((a, b) => (long ? a.lower - b.lower : b.upper - a.upper) || a.id.localeCompare(b.id));
  const takeProfits: M2Order["takeProfits"] = [];
  const plan = { direction, entry: entryRange, research: { entryZoneId: zone.id } };
  for (const targetZone of targetZones) {
    const range = tickPriceRange(Math.max(targetZone.lower, minPrice), Math.min(targetZone.upper, maxPrice), tickSize);
    if (!range) continue;
    const price = long ? range.min : range.max;
    const distance = (price - worstEntryPrice) * side;
    const previous = takeProfits.at(-1);
    if (previous && ((price - previous.price) * side <= 0 ||
      (long ? previous.price >= targetZone.lower : previous.price <= targetZone.upper))) continue;
    const target = { price, zoneId: targetZone.id, rMultiple: distance / riskDistance };
    if ((price - markPrice) * side <= 0 || distance > thresholds.maxTargetDistanceAtr * atr ||
      target.rMultiple < thresholds.minFirstTargetR || blockingTargetObstacle(zones, plan, target, takeProfits)) break;
    takeProfits.push(target);
    if (takeProfits.length === thresholds.maxTargets) break;
  }
  const first = takeProfits[0];
  if (!first) return null;
  return {
    direction, entryRange, stopLoss, takeProfits, riskReward: first.rMultiple,
    reasons: ["m1_triggered", "entry_in_confirmed_zone", "stop_beyond_zone", "targets_at_confirmed_zones"],
    keyFeatures: { style: signal.style, asOf: snapshot.asOf, markPrice, tickSize, atr15m: atr, rvol20, triggerInterval,
      entryZoneId: zone.id, stopZoneId: zone.id, worstEntryPrice, riskDistance },
  };
}

export function deterministicProposal(snapshot: Snapshot, trigger: M1Result, order: M2Order | null): Proposal {
  const risk = "M1/M2 使用启发式阈值，盈亏比未计交易成本。";
  const research: Proposal["research"] = {
    marketRegime: trigger.keyFeatures.marketState ?? "transition",
    scenario: order ? trigger.keyFeatures.setup ?? "none" : "none",
    timeframeAnalysis: {
      "4h": trendSummary(snapshot, "4h"),
      "1h": trendSummary(snapshot, "1h"),
      "15m": trendSummary(snapshot, "15m"),
    },
    entryZoneId: order?.keyFeatures.entryZoneId ?? null,
    stopZoneId: order?.keyFeatures.stopZoneId ?? null,
    riskFactors: [risk],
    researchHorizon: 4,
  };
  if (!order) {
    const summary = trigger.triggered ? "M1 已触发，当前价格结构未形成符合 M2 条件的方案。" : "M1 未达到触发条件。";
    return { status: trigger.triggered ? "watch" : "none", direction: null, title: "规则分析暂无交易方案", summary,
      entry: null, stopLoss: null, targets: [], triggerConditions: [], invalidationConditions: [], evidence: [],
      counterarguments: [], validForSeconds: thresholds.validForSeconds, research };
  }
  const { entryRange, stopLoss, direction, takeProfits, keyFeatures } = order;
  const title = direction === "long" ? "规则做多候选" : "规则做空候选";
  return {
    status: "candidate", direction, title,
    summary: `${title}。M1 得分 ${trigger.score}，首个结构目标对应 ${order.riskReward.toFixed(2)}R。`,
    entry: entryRange, stopLoss,
    targets: takeProfits.map(({ price, zoneId }) => ({ price, zoneId, reason: "对向确认区域的近端可用价位。" })),
    triggerConditions: [`M1 已使用 ${keyFeatures.triggerInterval} 收盘证据触发，入场前复核标记价格位于 ${entryRange.min}–${entryRange.max}。`],
    invalidationConditions: [`【未入场失效】标记价格触及止损价 ${stopLoss} 或越过首个目标。`, "【持仓提前退出】按原定结构止损及目标复核。"],
    evidence: [{ metric: `${keyFeatures.triggerInterval}.volumePrice`, reason: `最新收盘量比为 ${keyFeatures.rvol20.toFixed(2)}。` },
      { metric: keyFeatures.entryZoneId, reason: "同向确认区域提供入场与结构失效参考。" }],
    counterarguments: [risk], validForSeconds: thresholds.validForSeconds, research,
  };
}

function trendSummary(snapshot: Snapshot, interval: "4h" | "1h" | "15m") {
  const frame = snapshot.frames.find(item => item.interval === interval);
  if (!frame) return `${interval} 收盘特征不可用。`;
  const trend = frame.trend === "up" ? "向上" : frame.trend === "down" ? "向下" : "中性";
  return `${interval} 收盘趋势${trend}，ATR14 为 ${frame.atr14}。`;
}
