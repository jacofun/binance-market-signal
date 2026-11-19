import { openInterestChanges } from "./features.js";
import { effectiveKind } from "./price-zones.js";
import type { PriceZone, Proposal, Snapshot } from "./types.js";

export function researchContext(snapshot: Snapshot) {
  const trends = snapshot.frames.map(({ interval, trend }) => ({ interval, trend }));
  const up = trends.filter(t => t.trend === "up").length;
  const down = trends.filter(t => t.trend === "down").length;
  const alignment = up && down ? "conflict" : up === trends.length ? "up" : down === trends.length ? "down" : "mixed";
  return { trends, alignment, openInterestChanges: openInterestChanges(snapshot) };
}

export const structureZones = (snapshot: Snapshot) => snapshot.frames.flatMap(f => f.zones);
export const hourlyAtr = (snapshot: Snapshot) => snapshot.frames.find(f => f.interval === "1h")?.atr14 ?? 0;
export const inside = (price: number, zone: PriceZone) => price >= zone.lower && price <= zone.upper;
export const zoneUsable = (zone: PriceZone) => zone.status !== "broken";

export function targetObstacles(zones: PriceZone[], p: Proposal, target: number, targetZoneId: string) {
  if (!p.direction || !p.entry) return [];
  const long = p.direction === "long";
  const targetZone = zones.find(z => z.id === targetZoneId);
  return zones.filter(z => z.id !== targetZoneId && z.id !== p.research.entryZoneId &&
    zoneUsable(z) && effectiveKind(z) === (long ? "resistance" : "support") &&
    // Overlapping neighboring bands describe the same barrier as this target.
    (!targetZone || z.upper < targetZone.lower || z.lower > targetZone.upper) &&
    (long ? z.lower > p.entry!.max && z.upper < target : z.upper < p.entry!.min && z.lower > target))
    .toSorted((a, b) => long ? a.lower - b.lower : b.upper - a.upper);
}

export const significantObstacle = (zone: PriceZone) => zone.touches >= 2 || zone.interval === "4h";

export function assessResearch(snapshot: Snapshot, p: Proposal) {
  const context = researchContext(snapshot);
  const zones = structureZones(snapshot);
  const atr14 = hourlyAtr(snapshot);
  const direction = p.direction;
  const entry = p.entry && direction ? direction === "long" ? p.entry.max : p.entry.min : null;
  const risk = entry !== null && p.stopLoss !== null ? Math.abs(entry - p.stopLoss) : null;
  const referenced = new Set([p.research.entryZoneId, p.research.stopZoneId, ...p.targets.map(t => t.zoneId)]);
  const targetAssessment = p.targets.map(target => {
    const distance = Math.abs(target.price - entry!);
    const distancePct = distance / entry! * 100;
    const distribution = snapshot.frames.find(f => f.interval === "1h")?.historicalRanges[p.research.researchHorizon][direction!];
    const percentiles = distribution?.favorableMovePct;
    const comparison = !percentiles ? null : distancePct <= percentiles.p50 ? "within_p50" : distancePct <= percentiles.p75 ? "p50_to_p75" :
      distancePct <= percentiles.p90 ? "p75_to_p90" : "above_p90";
    const obstacles = targetObstacles(zones, p, target.price, target.zoneId);
    for (const zone of obstacles) referenced.add(zone.id);
    return { price: target.price, zoneId: target.zoneId, distance, distancePct, atr14Multiple: atr14 > 0 ? distance / atr14 : null,
      rewardRisk: risk ? distance / risk : null, obstacles: obstacles.map(z => z.id), historical: distribution ? { ...distribution, interval: "1h" as const } : null, comparison };
  });

  const volume = snapshot.frames.filter(f => f.interval !== "4h").flatMap(f => f.volumePrice.slice(-3)).map(bar => bar.observations ?? []);
  const supporting = direction === "long" ? ["high_volume_up", "high_volume_lower_recovery"] : ["high_volume_down", "high_volume_upper_rejection"];
  const opposing = direction === "long" ? ["high_volume_down", "high_volume_upper_rejection"] : ["high_volume_up", "high_volume_lower_recovery"];
  const supports = volume.filter(bar => supporting.some(tag => bar.includes(tag))).length;
  const contradicts = volume.filter(bar => opposing.some(tag => bar.includes(tag))).length;
  const stopZone = zones.find(z => z.id === p.research.stopZoneId);
  const activeSupport = zones.filter(z => zoneUsable(z) && effectiveKind(z) === "support").length;
  const activeResistance = zones.filter(z => zoneUsable(z) && effectiveKind(z) === "resistance").length;
  const repeatedZones = zones.filter(z => z.touches >= 2 && zoneUsable(z)).length;
  const clarity = activeSupport && activeResistance && repeatedZones >= 2 ? "defined" : activeSupport || activeResistance ? "developing" : "limited";
  const ruleAssessment = {
    trendAlignment: context.alignment,
    structure: { confirmedZones: zones.length, repeatedZones, activeSupport, activeResistance, clarity },
    volumePrice: direction ? { supportingBars: supports, opposingBars: contradicts } : null,
    invalidation: stopZone && risk !== null ? { zoneId: stopZone.id, riskDistance: risk, riskAtr14: atr14 ? risk / atr14 : null } : null,
    targetSpace: targetAssessment.map(t => ({ zoneId: t.zoneId, obstacleCount: t.obstacles.length, historicalComparison: t.comparison })),
    riskReward: targetAssessment.map(t => ({ zoneId: t.zoneId, rewardRisk: t.rewardRisk })),
  };
  const priceZones = zones.filter(z => referenced.has(z.id));
  for (const zone of zones) if (!referenced.has(zone.id)) priceZones.push(zone);
  return { ...p.research, priceZones, targetAssessment, ruleAssessment };
}
