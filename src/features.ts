import type { Candle, HistoricalRange, ResearchHours, Snapshot, Trend, VolumeBar } from "./types.js";

export const HORIZONS = [4, 12, 24] as const;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
export const changePct = (value: number, baseline: number) => baseline > 0 ? (value / baseline - 1) * 100 : null;

export function atrSeries(candles: Candle[]): (number | null)[] {
  let atr = 0;
  return candles.map((bar, i) => {
    if (!i) return null;
    const close = candles[i - 1]!.close;
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - close), Math.abs(bar.low - close));
    atr = i < 14 ? atr + range : i === 14 ? (atr + range) / 14 : (atr * 13 + range) / 14;
    return i >= 14 ? atr : null;
  });
}

export function emaSeries(candles: Candle[], period: number): (number | null)[] {
  let value = 0;
  return candles.map((bar, index) => {
    if (index < period - 1) {
      value += bar.close;
      return null;
    }
    if (index === period - 1) value = (value + bar.close) / period;
    else value += (bar.close - value) * 2 / (period + 1);
    return value;
  });
}

export function frameTrend(close: number, ema20: number, ema50: number): Trend {
  return close > ema20 && ema20 > ema50 ? "up" : close < ema20 && ema20 < ema50 ? "down" : "flat";
}

export function volumeBars(candles: Candle[], ema20 = emaSeries(candles, 20), ema50 = emaSeries(candles, 50)): VolumeBar[] {
  return candles.map((bar, i) => {
    const previous = candles[i - 1];
    const baseline = candles.slice(Math.max(0, i - 20), i);
    const average = baseline.length === 20 ? mean(baseline.map(c => c.volume)) : 0;
    const volumeRatio20 = average > 0 ? bar.volume / average : null;
    const range = bar.high - bar.low;
    const upperWickShare = range ? (bar.high - Math.max(bar.open, bar.close)) / range : null;
    const lowerWickShare = range ? (Math.min(bar.open, bar.close) - bar.low) / range : null;
    const clv = range ? (2 * bar.close - bar.low - bar.high) / range : null;
    const bodyShare = range ? Math.abs(bar.close - bar.open) / range : null;
    const closeChangePct = previous ? changePct(bar.close, previous.close) : null;
    const newHigh20 = baseline.length === 20 ? bar.high > Math.max(...baseline.map(c => c.high)) : null;
    const newLow20 = baseline.length === 20 ? bar.low < Math.min(...baseline.map(c => c.low)) : null;
    const observations: string[] = [];
    if (volumeRatio20 !== null && closeChangePct) {
      if (volumeRatio20 >= 1.5) observations.push(closeChangePct > 0 ? "high_volume_up" : "high_volume_down");
      if (volumeRatio20 <= 0.75) {
        observations.push(closeChangePct > 0 ? "low_volume_up" : "low_volume_down");
        const short = ema20[i - 1];
        const long = ema50[i - 1];
        if (previous && short != null && long != null) {
          const trend = frameTrend(previous.close, short, long);
          if (trend === "up" && closeChangePct < 0) observations.push("low_volume_pullback_in_uptrend");
          if (trend === "down" && closeChangePct > 0) observations.push("low_volume_rebound_in_downtrend");
        }
      }
    }
    if (volumeRatio20 !== null && volumeRatio20 >= 1.5) {
      if (upperWickShare !== null && upperWickShare >= 0.45 && clv! <= 0) observations.push("high_volume_upper_rejection");
      if (lowerWickShare !== null && lowerWickShare >= 0.45 && clv! >= 0) observations.push("high_volume_lower_recovery");
    }
    return { openTime: bar.openTime, closeChangePct, rangePct: range / bar.open * 100, upperWickShare, lowerWickShare, bodyShare, clv,
      volumeRatio20, takerBuyShare: bar.volume > 0 ? bar.takerBuyVolume / bar.volume : null, newHigh20, newLow20, observations };
  });
}

function volumeSummary(bars: Candle[]) {
  const volume = bars.reduce((sum, c) => sum + c.volume, 0);
  const taker = bars.reduce((sum, c) => sum + c.takerBuyVolume, 0);
  return { meanVolume: volume / bars.length, takerBuyShare: volume > 0 ? taker / volume : null };
}

export function volumeWindows(candles: Candle[]) {
  return [5, 20, 50].map(bars => {
    const current = volumeSummary(candles.slice(-bars));
    const previous = candles.length >= 2 * bars ? volumeSummary(candles.slice(-2 * bars, -bars)) : null;
    return { bars, ...current, volumeChangePct: previous ? changePct(current.meanVolume, previous.meanVolume) : null,
      takerBuyChangePp: previous?.takerBuyShare != null && current.takerBuyShare !== null
        ? (current.takerBuyShare - previous.takerBuyShare) * 100 : null };
  });
}

function quantiles(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}

export function historicalRanges(candles: Candle[], period: number): Record<ResearchHours, Record<"long" | "short", HistoricalRange>> {
  const distribution = (hours: ResearchHours) => {
    const bars = hours * 3_600_000 / period;
    const up: number[] = [];
    const down: number[] = [];
    // End-anchored, non-overlapping windows with a preceding reference close.
    for (let end = candles.length; end - bars > 0; end -= bars) {
      const start = end - bars;
      const path = candles.slice(start, end);
      const baseline = candles[start - 1]!.close;
      up.push(Math.max(0, changePct(Math.max(...path.map(c => c.high)), baseline)!));
      down.push(Math.max(0, -changePct(Math.min(...path.map(c => c.low)), baseline)!));
    }
    return { long: { bars, samples: up.length, favorableMovePct: quantiles(up) },
      short: { bars, samples: down.length, favorableMovePct: quantiles(down) } };
  };
  return { 4: distribution(4), 12: distribution(12), 24: distribution(24) };
}

export function openInterestChanges(snapshot: Snapshot) {
  const hourly = snapshot.frames.find(f => f.interval === "1h")?.recentCandles ?? [];
  const closes = new Map(hourly.map(bar => [bar.closeTime + 1, bar.close]));
  return snapshot.openInterest.slice(1).flatMap((row, i) => {
    const previous = snapshot.openInterest[i]!;
    if (row.time > snapshot.asOf || row.time - previous.time !== 3_600_000) return [];
    const close = closes.get(row.time);
    const priorClose = closes.get(previous.time);
    const priceChangePct = close !== undefined && priorClose !== undefined ? changePct(close, priorClose) : null;
    const contractsChangePct = changePct(row.contracts, previous.contracts);
    const sign = (value: number) => value > 0 ? "up" : value < 0 ? "down" : "flat";
    return [{ time: row.time, contractsChangePct, notionalChangePct: changePct(row.notional, previous.notional), priceChangePct,
      combination: contractsChangePct !== null && priceChangePct !== null ? { oi: sign(contractsChangePct), price: sign(priceChangePct) } : null }];
  });
}
