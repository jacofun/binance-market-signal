import { distanceToZone, effectiveKind } from "./price-zones.js";
import { structureZones, zoneUsable } from "./research.js";
import type { Frame, Snapshot, Style } from "./types.js";

const thresholds = {
  minRvol20: 1.2,
  maxZoneDistanceAtr: 1,
  minAtrPct: 0.05,
  maxAtrPct: 2,
  triggerScore: 80,
  highConfidenceScore: 95,
};

type Direction = "long" | "short";
type Setup = "continuation" | "reversal";

export interface M1Result {
  triggered: boolean;
  score: number;
  reasons: string[];
  keyFeatures: Record<string, unknown> & {
    asOf: number;
    style: Style;
    lastCloseTime?: number;
    marketState?: "trend" | "range" | "transition";
    setup?: Setup | null;
    direction?: Direction | null;
    zone?: ReturnType<typeof nearestZone>;
  };
  confidence: "high" | "medium" | "low";
}

function nearestZone(snapshot: Snapshot, frame: Frame, direction: Direction | null) {
  if (!direction || !Number.isFinite(frame.atr14) || frame.atr14 <= 0) return null;
  const price = frame.close;
  const kind = direction === "long" ? "support" : "resistance";
  const closest = structureZones(snapshot)
    .filter(zone => zoneUsable(zone) && effectiveKind(zone) === kind &&
      (direction === "long" ? price >= zone.lower : price <= zone.upper))
    .map(zone => ({ zone, distanceAtr: distanceToZone(zone, price) / frame.atr14 }))
    .sort((a, b) => a.distanceAtr - b.distanceAtr || a.zone.id.localeCompare(b.zone.id))[0];
  if (!closest) return null;
  const { id, interval, lower, upper } = closest.zone;
  return { id, interval, kind, lower, upper, distanceAtr: closest.distanceAtr };
}

export function evaluateM1Trigger(snapshot: Snapshot, style: string = "neutral"): M1Result {
  const focus: Style = style === "trend" || style === "reversal" ? style : "neutral";
  const [background, hourly, short] = (["4h", "1h", "15m"] as const)
    .map(interval => snapshot.frames.find(frame => frame.interval === interval));
  if (!background || !hourly || !short) {
    return { triggered: false, score: 0, reasons: ["missing_analysis_frames"],
      keyFeatures: { asOf: snapshot.asOf, style: focus }, confidence: "low" };
  }

  const latest = short.volumePrice.at(-1);
  const closeChangePct = latest?.closeChangePct ?? null;
  const observations = latest?.observations ?? [];
  const lowerRecovery = observations.includes("high_volume_lower_recovery");
  const upperRejection = observations.includes("high_volume_upper_rejection");
  const closeDirection: Direction | null = !closeChangePct ? null : closeChangePct > 0 ? "long" : "short";
  const reversalDirection: Direction | null = lowerRecovery === upperRejection ? null : lowerRecovery ? "long" : "short";
  const marketState = background.trend !== hourly.trend ? "transition" : hourly.trend === "flat" ? "range" : "trend";
  const trendSetup = marketState === "trend" && closeDirection === (hourly.trend === "up" ? "long" : "short");

  let setup: Setup | null = null;
  if (focus !== "reversal" && trendSetup) setup = "continuation";
  else if (focus !== "trend" && reversalDirection) setup = "reversal";
  const direction = setup === "reversal" || focus === "reversal" ? reversalDirection : closeDirection;
  const trend = direction === "long" ? "up" : direction === "short" ? "down" : null;
  const trends = { "4h": background.trend, "1h": hourly.trend, "15m": short.trend };
  const alignedFrames = Object.values(trends).filter(value => value === trend).length;

  const zone = nearestZone(snapshot, short, direction);
  const nearZone = zone !== null && zone.distanceAtr <= thresholds.maxZoneDistanceAtr;
  const rvol20 = short.volumeRatio20 ?? null;
  const atrPct = Number.isFinite(short.atrPct) ? short.atrPct : null;
  const atrInRange = atrPct !== null && atrPct >= thresholds.minAtrPct && atrPct <= thresholds.maxAtrPct;
  let score = 0;
  const reasons: string[] = [];
  if (setup) score += 30;
  reasons.push(setup ?? "style_setup_missing");
  if (nearZone) score += 25;
  reasons.push(nearZone ? "near_zone" : "no_near_zone");
  if (rvol20 !== null && rvol20 >= thresholds.minRvol20) {
    score += 25;
    reasons.push("rvol_sufficient");
  } else reasons.push(rvol20 === null ? "rvol_unavailable" : "rvol_below_minimum");
  if (alignedFrames === 3) {
    score += 10;
    reasons.push("trends_aligned");
  } else if (alignedFrames === 2) {
    score += 5;
    reasons.push("trends_partially_aligned");
  }
  if (atrInRange) score += 10;
  reasons.push(atrInRange ? "atr_in_range" : atrPct === null ? "atr_unavailable" : "atr_out_of_range");

  const triggered = setup !== null && nearZone && atrInRange && score >= thresholds.triggerScore;
  return {
    triggered, score, reasons,
    keyFeatures: { asOf: snapshot.asOf, lastCloseTime: short.lastCloseTime, style: focus, marketState, setup,
      direction, trends, alignedFrames, close: short.close, zone, rvol20, atrPct, closeChangePct, observations },
    confidence: !triggered ? "low" : score >= thresholds.highConfidenceScore ? "high" : "medium",
  };
}
