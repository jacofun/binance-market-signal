import type { Candle } from "./types.js";

export const minuteMs = 60_000;
export const episodeMs = 20 * minuteMs;
const baselineMinutes = 180;
export const ordinaryAnalysisLimit = (limit: number) => limit - Math.min(limit - 1, Math.ceil(limit * 0.3));

export function scanMovement(candles: Candle[]) {
  const last = candles.at(-1)!;
  const end = candles.length - 1;
  const returnPct = (i: number, minutes: number) => (candles[i]!.close / candles[i - minutes]!.close - 1) * 100;
  function window(minutes: number, floor: number, multiple: number, extreme: number) {
    const changePct = returnPct(end, minutes);
    const samples = [];
    for (let i = Math.max(minutes, end - minutes - baselineMinutes + 1); i <= end - minutes; i++) {
      samples.push(Math.abs(returnPct(i, minutes)));
    }
    samples.sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const median = samples.length >= 60 ? (samples[middle]! + samples[Math.ceil(samples.length / 2) - 1]!) / 2 : null;
    const thresholdPct = median === null ? null : Math.max(floor, multiple * median);
    const magnitude = Math.abs(changePct);
    const severity = magnitude + 1e-10 >= extreme ? "severe" :
      thresholdPct !== null && magnitude + 1e-10 >= thresholdPct ? "normal" : "none";
    const volume = (to: number) => candles.slice(to - minutes + 1, to + 1).reduce((sum, bar) => sum + bar.volume, 0);
    const previousVolume = volume(end - minutes);
    return { minutes, changePct, baselinePct: median, thresholdPct, severeAtPct: extreme, severity,
      volumeRatio: previousVolume > 0 ? volume(end) / previousVolume : null } as const;
  }
  const windows = [window(5, 0.6, 2.5, 1.2), window(15, 1, 2, 2)];
  const selected = windows.find(w => w.severity === "severe") ?? windows.find(w => w.severity === "normal");
  return { closedAt: last.closeTime + 1, close: last.close, windows,
    severity: selected?.severity ?? "none",
    direction: selected ? selected.changePct > 0 ? "long" as const : "short" as const : null };
}
export type Movement = ReturnType<typeof scanMovement>;

export interface AnalysisClaim {
  eventAt: number;
  direction: "long" | "short" | null;
  severe: boolean;
}

export function claimBlock(previous: readonly AnalysisClaim[], claim: AnalysisClaim) {
  if (previous.some(item => item.eventAt === claim.eventAt)) return "duplicate";
  const sameDirection = previous.filter(item => item.direction !== null && item.direction === claim.direction &&
    Math.abs(item.eventAt - claim.eventAt) < episodeMs);
  if (sameDirection.length && (!claim.severe || sameDirection.some(item => item.severe))) return "episode";
}
