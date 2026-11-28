import type { M1Result } from "./m1-trigger.js";
import { tickPriceRange } from "./price-grid.js";
import { effectiveKind } from "./price-zones.js";
import { blockingTargetObstacle, structureZones, zoneUsable } from "./research.js";
import type { Proposal, Snapshot, Style, TriggerInterval } from "./types.js";

export const DETERMINISTIC_VERSION = "deterministic-m1-m2-v3";
export const DETERMINISTIC_5M_VERSION = "deterministic-m1-m2-v3-5m";
export const minimumM2RewardToRisk = 1.5;
const thresholds = {
  referenceHalfWidthAtr: 0.15,
  stopBufferAtr: 0.15,
  minStopDistanceAtr: 0.5,
  maxRiskAtr: 2,
  minFirstTargetR: minimumM2RewardToRisk,
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

export function generateM2Order(snapshot: Snapshot, m1Result: M1Result, style?: string,
  onRejection?: (reason: string) => void): M2Order | null {
  const reject = (reason: string) => { onRejection?.(reason); return null; };
  const priceText = (value: number) => String(Number(value.toFixed(8)));
  const signal = m1Result.keyFeatures;
  const { direction } = signal;
  const short = snapshot.frames.find(frame => frame.interval === "15m");
  const triggerFrame = snapshot.triggerFrame ?? short;
  const triggerInterval = snapshot.triggerFrame?.interval ?? "15m";
  if (m1Result.triggered !== true || !direction || !signal.setup || !signal.zone || !short ||
    !triggerFrame || signal.asOf !== snapshot.asOf || (signal.triggerInterval ?? "15m") !== triggerInterval ||
    signal.lastCloseTime !== triggerFrame.lastCloseTime ||
    (style !== undefined && style !== signal.style)) return reject("M1 信号与本次行情快照不匹配，或缺少构建方案所需的方向、形态或关键区。");
  const { atr14: atr } = short;
  const rvol20 = triggerFrame.volumePrice.at(-1)?.volumeRatio20;
  const { tickSize } = snapshot;
  const markPrice = snapshot.quote.price;
  if (!Number.isFinite(atr) || atr <= 0 || rvol20 == null || !Number.isFinite(rvol20) ||
    !Number.isFinite(markPrice) || markPrice <= 0 || !Number.isFinite(triggerFrame.close) || triggerFrame.close <= 0 ||
    !Number.isFinite(tickSize) || tickSize <= 0) {
    return reject("缺少有效的 15 分钟 ATR、触发周期量比、标记价或价格步长。");
  }

  const long = direction === "long";
  const side = long ? 1 : -1;
  const zones = structureZones(snapshot);
  const zone = zones.find(item => item.id === signal.zone?.id);
  if (!zone || !zoneUsable(zone) || effectiveKind(zone) !== (long ? "support" : "resistance")) return reject("M1 选中的关键区已失效或与开仓方向不符。");
  if (long ? markPrice < zone.lower : markPrice > zone.upper) {
    return reject(`标记价 ${priceText(markPrice)} 已${long ? `跌破支撑区下沿 ${priceText(zone.lower)}` : `涨破阻力区上沿 ${priceText(zone.upper)}`}。`);
  }
  const minPrice = Math.max(tickSize, markPrice * 0.5);
  const maxPrice = Math.min(1e12, markPrice * 1.5);
  const buffer = Math.max(tickSize, thresholds.stopBufferAtr * atr);
  const minRisk = thresholds.minStopDistanceAtr * atr;
  // Preserve the minimum stop distance around the triggering close. Later
  // mark prices can qualify the entry, but do not set the structural stop.
  const center = Math.min(zone.upper, Math.max(zone.lower, triggerFrame.close));
  const halfWidth = thresholds.referenceHalfWidthAtr * atr;
  const reference = long ? Math.max(zone.lower, center - halfWidth) : Math.min(zone.upper, center + halfWidth);
  const stopLoss = long ?
    tickPriceRange(minPrice, Math.min(zone.lower - buffer, reference - minRisk), tickSize)?.max :
    tickPriceRange(Math.max(zone.upper + buffer, reference + minRisk), maxPrice, tickSize)?.min;
  if (stopLoss === undefined) return reject("无法在关键区外设置符合价格步长和方向要求的结构止损。");
  const maxRisk = thresholds.maxRiskAtr * atr;
  const riskRange = tickPriceRange(Math.max(zone.lower, minPrice, long ? stopLoss + minRisk : stopLoss - maxRisk),
    Math.min(zone.upper, maxPrice, long ? stopLoss + maxRisk : stopLoss - minRisk), tickSize);
  if (!riskRange) return reject(`关键区内没有符合价格步长 ${tickSize} 且距结构止损 ${thresholds.minStopDistanceAtr}–${thresholds.maxRiskAtr} ATR 的入场价。止损 ${stopLoss}。`);

  // Use the favorable edge to keep any closer opposing zone in consideration
  // before clipping the entry interval to the first target's reward-to-risk.
  const bestEntry = long ? riskRange.min : riskRange.max;
  const targetZones = zones.filter(item => zoneUsable(item) && effectiveKind(item) === (long ? "resistance" : "support") &&
    (long ? item.lower > bestEntry : item.upper < bestEntry))
    .sort((a, b) => (long ? a.lower - b.lower : b.upper - a.upper) || a.id.localeCompare(b.id));
  const takeProfits: M2Order["takeProfits"] = [];
  let entryRange: M2Order["entryRange"] | undefined;
  for (const targetZone of targetZones) {
    const range = tickPriceRange(Math.max(targetZone.lower, minPrice), Math.min(targetZone.upper, maxPrice), tickSize);
    if (!range) continue;
    const price = long ? range.min : range.max;
    const previous = takeProfits.at(-1);
    if (previous && ((price - previous.price) * side <= 0 ||
      (long ? previous.price >= targetZone.lower : previous.price <= targetZone.upper))) continue;
    if (!entryRange) {
      if ((price - markPrice) * side <= 0) return reject(`标记价 ${priceText(markPrice)} 已达到或越过首个止盈参考价 ${price}。`);
      const boundary = stopLoss + (price - stopLoss) / (1 + thresholds.minFirstTargetR);
      const rewardRange = tickPriceRange(long ? riskRange.min : Math.max(riskRange.min, boundary),
        long ? Math.min(riskRange.max, boundary) : riskRange.max, tickSize);
      if (!rewardRange) return reject(`按结构止损 ${stopLoss} 和首个目标 ${price} 反推，关键区内没有达到 ${thresholds.minFirstTargetR.toFixed(2)}R 的入场价。`);
      const maxTargetDistance = thresholds.maxTargetDistanceAtr * atr;
      entryRange = tickPriceRange(long ? Math.max(rewardRange.min, price - maxTargetDistance) : rewardRange.min,
        long ? rewardRange.max : Math.min(rewardRange.max, price + maxTargetDistance), tickSize) ?? undefined;
      if (!entryRange) return reject(`首个止盈目标 ${price} 距可用入场价超过 ${thresholds.maxTargetDistanceAtr} ATR 上限。`);
    }
    const worstEntryPrice = long ? entryRange.max : entryRange.min;
    const riskDistance = (worstEntryPrice - stopLoss) * side;
    const distance = (price - worstEntryPrice) * side;
    const target = { price, zoneId: targetZone.id, rMultiple: distance / riskDistance };
    const plan = { direction, entry: entryRange, research: { entryZoneId: zone.id } };
    const obstacle = blockingTargetObstacle(zones, plan, target, takeProfits);
    if (obstacle) {
      if (!previous) return reject(`通往首个止盈目标 ${price} 的路径上有 ${obstacle.interval} ${long ? "阻力区" : "支撑区"} ${priceText(obstacle.lower)}–${priceText(obstacle.upper)}。`);
      break;
    }
    if (previous && (distance > thresholds.maxTargetDistanceAtr * atr || target.rMultiple < thresholds.minFirstTargetR)) break;
    takeProfits.push(target);
    if (takeProfits.length === thresholds.maxTargets) break;
  }
  const first = takeProfits[0];
  if (!first || !entryRange) return reject(targetZones.length ? "对向关键区内没有符合价格步长的止盈价位。" : "没有位于盈利方向的有效对向关键区，无法设置止盈。");
  const worstEntryPrice = long ? entryRange.max : entryRange.min;
  const riskDistance = (worstEntryPrice - stopLoss) * side;
  return {
    direction, entryRange, stopLoss, takeProfits, riskReward: first.rMultiple,
    reasons: ["m1_triggered", "entry_in_confirmed_zone", "stop_beyond_zone", "targets_at_confirmed_zones"],
    keyFeatures: { style: signal.style, asOf: snapshot.asOf, markPrice, tickSize, atr15m: atr, rvol20, triggerInterval,
      entryZoneId: zone.id, stopZoneId: zone.id, worstEntryPrice, riskDistance },
  };
}

export function deterministicProposal(snapshot: Snapshot, trigger: M1Result, order: M2Order | null, rejection?: string): Proposal {
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
    const summary = trigger.triggered ? (rejection ? `M2 未生成方案。${rejection}` : "M1 已触发，当前价格结构未形成符合 M2 条件的方案。") : "M1 未达到触发条件。";
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
