import type { Candle, Interval, PriceZone, VolumeBar } from "./types.js";

export function confirmedPivots(candles: Candle[]) {
  const pivots: { index: number; price: number; kind: PriceZone["kind"] }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const bar = candles[i]!;
    const left = candles.slice(i - 2, i);
    const right = candles.slice(i + 1, i + 3);
    if (left.every(b => bar.high >= b.high) && right.every(b => bar.high > b.high)) pivots.push({ index: i, price: bar.high, kind: "resistance" });
    if (left.every(b => bar.low <= b.low) && right.every(b => bar.low < b.low)) pivots.push({ index: i, price: bar.low, kind: "support" });
  }
  return pivots;
}

export function priceZones(candles: Candle[], interval: Interval, atr: (number | null)[], bars: VolumeBar[]): PriceZone[] {
  const clusters: { lower: number; upper: number; first: number; last: number; kind: PriceZone["kind"]; count: number; unit: number }[] = [];
  for (const pivot of confirmedPivots(candles)) {
    const confirmed = pivot.index + 2;
    const unit = atr[confirmed] ?? 0;
    if (unit <= 0) continue;
    const match = clusters.find(c => c.kind === pivot.kind &&
      Math.max(c.upper, pivot.price) - Math.min(c.lower, pivot.price) <= Math.min(c.unit, unit) * 0.5);
    if (match) {
      match.lower = Math.min(match.lower, pivot.price);
      match.upper = Math.max(match.upper, pivot.price);
      match.last = confirmed;
      match.count++;
    } else {
      clusters.push({ lower: pivot.price, upper: pivot.price, first: pivot.index, last: confirmed, kind: pivot.kind, count: 1, unit });
    }
  }
  return clusters.map(cluster => {
    const { kind, first, last, count, unit } = cluster;
    const padding = Math.min(cluster.lower * 0.01, unit * 0.15);
    const lower = cluster.lower - padding;
    const upper = cluster.upper + padding;
    const direction = kind === "resistance" ? 1 : -1;
    const edge = kind === "resistance" ? upper : lower;
    let status: PriceZone["status"] = "active";
    let lastTouchTime = candles[last - 2]!.openTime;
    let touches = count;
    let breakTime: number | null = null;
    let breakRvol20: number | null = null;
    let lastRetestTime: number | null = null;
    let lastRetestRvol20: number | null = null;
    let closesBeyondBreak: number | null = null;
    // Historical pivot reactions use only information available at confirmation.
    const observations = (i: number, anchor: number, close: number) => ({
      time: candles[i]!.openTime, closeClv: bars[i]!.clv, rvol20: bars[i]!.volumeRatio20,
      moveAtr: atr[anchor] ? (close - candles[i]!.close) / atr[anchor]! : null,
    });
    const reactions = [observations(last - 2, last, candles[last]!.close)];
    let wasTouch = candles[last]!.high >= lower && candles[last]!.low <= upper;
    // Final cluster boundaries apply from last confirmation onward.
    for (let i = last + 1; i < candles.length; i++) {
      const candle = candles[i]!;
      const touch = candle.high >= lower && candle.low <= upper;
      if (touch) {
        lastTouchTime = candle.openTime;
        if (!wasTouch) {
          touches++;
          reactions.push(observations(i, i, candle.close));
          // Same bar reaction measured from the relevant band edge.
          reactions.at(-1)!.moveAtr = atr[i] ? (candle.close - edge) / atr[i]! : null;
        }
      }
      wasTouch = touch;
      const beyond = (candle.close - edge) * direction > 0;
      if (status === "active" && beyond) {
        status = "broken";
        breakTime = candle.openTime;
        breakRvol20 = bars[i]!.volumeRatio20;
        closesBeyondBreak = 1;
        lastRetestTime = null;
        lastRetestRvol20 = null;
      } else if (status !== "active") {
        if (beyond) {
          closesBeyondBreak = (closesBeyondBreak ?? 0) + 1;
          if (touch) {
            status = "retested";
            lastRetestTime = candle.openTime;
            lastRetestRvol20 = bars[i]!.volumeRatio20;
          }
        } else if ((kind === "resistance" && candle.close < lower) || (kind === "support" && candle.close > upper)) {
          status = "active";
          closesBeyondBreak = 0;
        } else {
          closesBeyondBreak = 0;
          status = "broken";
        }
      }
    }
    const firstPivotTime = candles[first]!.openTime;
    return { id: `${interval}:${kind}:${firstPivotTime}`, lower, upper, interval, kind, status, touches,
      lastTouchTime, firstPivotTime, confirmedAt: candles[last]!.closeTime + 1, pivotCount: count,
      breakTime, lastRetestTime, lastRetestRvol20, breakRvol20, closesBeyondBreak, atrAtConfirmation: unit, reactions: reactions.slice(-4) };
  });
}

export function effectiveKind(zone: PriceZone) {
  if (zone.status !== "retested") return zone.kind;
  return zone.kind === "resistance" ? "support" : "resistance";
}

export function selectZones(zones: PriceZone[], reference: number) {
  const distance = (zone: PriceZone) => Math.max(0, zone.lower - reference, reference - zone.upper);
  const nearest = (group: PriceZone[]) => group.toSorted((a, b) =>
    distance(a) - distance(b) || b.touches - a.touches || b.lastTouchTime - a.lastTouchTime || a.id.localeCompare(b.id)).slice(0, 6);
  return [...nearest(zones.filter(z => effectiveKind(z) === "support")), ...nearest(zones.filter(z => effectiveKind(z) === "resistance"))];
}
