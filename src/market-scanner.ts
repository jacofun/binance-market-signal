import { AppError } from "./errors.js";
import type { Env } from "./config.js";
import { limited } from "./http.js";
import { frame, INTERVAL_MS, RestMarketDataProvider } from "./market.js";
import { makeOrderStore } from "./order-oss.js";
import { loadOssConfig } from "./oss-config.js";
import { effectiveKind } from "./price-zones.js";
import { SOURCE_COMMIT } from "./version.js";
import type { Candle, Frame, PriceZone } from "./types.js";

export const SCANNER_TRIGGER = "binance-market-scanner";
const symbol = "BTCUSDT";
const interval = INTERVAL_MS["15m"];
const pageSize = 16;
const hour = INTERVAL_MS["1h"];
const pageWindow = 4 * hour;
const historyDays = 30;
const rulesVersion = "v1";
const minimumRvol = 1.5;
const maximumDistanceAtr = 1;
const minimumRoomAtr = 1;

type Direction = "long" | "short";
type Decision = "passed" | "watch" | "filtered" | "none";
type Check = { code: string; passed: boolean | null; value: number | string | null; expected: number | string | null };
type Rule = { kind: "breakout" | "reclaim"; status: Decision; direction: Direction | null; zone: Pick<PriceZone, "id" | "lower" | "upper"> | null; checks: Check[] };

export function scanRules(short: Frame, hourly: Frame, background: Frame): Rule[] {
  const [before, previous, last] = short.recentCandles.slice(-3);
  if (!before || !previous || !last) throw new AppError("SCAN_INSUFFICIENT_DATA", "扫描缺少连续的已收盘 K 线。", 502);
  const zones = hourly.zones.filter(zone => zone.confirmedAt <= previous.openTime && zone.status !== "broken");
  const ordered = (items: PriceZone[], price: number) => items.toSorted((a, b) => {
    const distance = (z: PriceZone) => Math.max(0, z.lower - price, price - z.upper);
    return distance(a) - distance(b) || a.id.localeCompare(b.id);
  });
  const directionOf = (zone: PriceZone): Direction => effectiveKind(zone) === "resistance" ? "long" : "short";
  const edge = (zone: PriceZone) => directionOf(zone) === "long" ? zone.upper : zone.lower;
  const side = (zone: PriceZone) => directionOf(zone) === "long" ? 1 : -1;
  const check = (code: string, passed: Check["passed"], value: Check["value"] = null, expected: Check["expected"] = null): Check =>
    ({ code, passed, value, expected });
  const bar = short.volumePrice.at(-1);
  const rvol = bar?.volumeRatio20 ?? null;

  function room(direction: Direction, zone: PriceZone) {
    const ahead = zones.filter(z => z.id !== zone.id && (
      direction === "long" ? effectiveKind(z) === "resistance" && z.upper >= last!.close :
        effectiveKind(z) === "support" && z.lower <= last!.close));
    const next = ordered(ahead, last!.close)[0];
    const space = next && short.atr14 > 0 ? Math.max(0, direction === "long" ?
      next.lower - last!.close : last!.close - next.upper) / short.atr14 : null;
    return check("room_atr", space === null ? null : space >= minimumRoomAtr, space, minimumRoomAtr);
  }
  function distance(zone: PriceZone) {
    const delta = short.atr14 > 0 ? Math.abs(last!.close - edge(zone)) / short.atr14 : null;
    return check("distance_atr", delta === null ? null : delta <= maximumDistanceAtr, delta, maximumDistanceAtr);
  }
  function result(kind: Rule["kind"], zone: PriceZone | undefined, direction: Direction | null, checks: Check[], watch = false): Rule {
    return { kind, status: !zone ? "none" : watch ? "watch" : checks.every(item => item.passed === true) ? "passed" : "filtered",
      direction, zone: zone ? { id: zone.id, lower: zone.lower, upper: zone.upper } : null, checks };
  }
  const breakout = ordered(zones.filter(zone =>
    (previous.close - edge(zone)) * side(zone) <= 0 && (last.close - edge(zone)) * side(zone) > 0), last.close)[0];
  let breakoutRule: Rule;
  if (breakout) {
    const direction = directionOf(breakout);
    const expectedTrend = direction === "long" ? "up" : "down";
    breakoutRule = result("breakout", breakout, direction, [
      check("close_cross", true), check("rvol20", rvol === null ? null : rvol >= minimumRvol, rvol, minimumRvol),
      check("trend_4h", background.trend === expectedTrend, background.trend, expectedTrend), distance(breakout), room(direction, breakout),
    ]);
  } else {
    breakoutRule = result("breakout", undefined, null, [check("close_cross", false)]);
  }

  function swept(zone: PriceZone, bar: Candle, preceding: Candle) {
    const boundary = edge(zone);
    const wick = side(zone) === 1 ? bar.high : bar.low;
    return (preceding.close - boundary) * side(zone) <= 0 && (wick - boundary) * side(zone) > 0 &&
      bar.close >= zone.lower && bar.close <= zone.upper;
  }
  const priorSweep = ordered(zones.filter(zone => swept(zone, previous, before)), previous.close)[0];
  const newSweep = ordered(zones.filter(zone => swept(zone, last, previous)), last.close)[0];
  const reclaim = priorSweep ?? newSweep;
  if (!reclaim) return [breakoutRule, result("reclaim", undefined, null, [check("wick_reclaim", false)])];
  const direction = directionOf(reclaim) === "long" ? "short" : "long";
  // The confirming close must remain on the recovered side of the swept edge.
  const confirmed = priorSweep ? (last.close - edge(reclaim)) * side(reclaim) < 0 &&
    (last.close - previous.close) * side(reclaim) < 0 : null;
  return [breakoutRule, result("reclaim", reclaim, direction, [
    check("wick_reclaim", true), check("next_close", confirmed),
    ...(priorSweep ? [distance(reclaim), room(direction, reclaim)] : []),
  ], !priorSweep)];
}

const scanError = (code: string, message: string, status = 400) => new AppError(code, message, status);
const hourFor = (time: number) => Math.floor(time / hour) * hour;
const slotFor = (time: number) => Math.floor(time / interval) * interval;
const legacyKey = (slot: number) => `${symbol}/${slot}.json`;
const logKey = (time: number) => `${symbol}/runs/${hourFor(time)}.ndjson`;
const cursorFormat = /^(\d{13}):([a-z0-9-]{0,60})$/;

export function validateScanTimer(input: Record<string, unknown>, now: number) {
  const time = typeof input.triggerTime === "string" ? Date.parse(input.triggerTime) : NaN;
  if (input.triggerName !== SCANNER_TRIGGER || !Number.isFinite(time) || time > now + 5000) {
    throw scanError("INVALID_SCAN_TIMER", "扫描触发时间无效或超出容许时钟偏差。");
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function makeMarketScanner(env: Env, now: () => number, request: typeof fetch = fetch) {
  const store = makeOrderStore({ ...loadOssConfig(env, "SCAN"), prefix: "private/market-signal-scanner/v1" }, now, request, "SCAN");
  async function listLegacy(input: Record<string, unknown>) {
    const latest = slotFor(now());
    const oldest = latest - historyDays * 24 * hour;
    const before = input.before === undefined ? latest + interval : input.before;
    if (Object.keys(input).some(key => key !== "before") || typeof before !== "number" || !Number.isSafeInteger(before) ||
      before % interval !== 0 || before <= oldest || before > latest + interval) {
      throw scanError("INVALID_SCAN_CURSOR", "扫描记录分页参数无效。");
    }
    const slots = Array.from({ length: pageSize }, (_, i) => before - (i + 1) * interval).filter(slot => slot >= oldest);
    const rows = await limited(slots.map(slot => () => store.read(legacyKey(slot))), 4);
    const start = slots.at(-1)!;
    return { records: rows.filter(row => row !== null), from: start, to: before - interval, next: start > oldest ? start : null };
  }

  return {
    async run(id: string) {
      const scannedAt = now();
      const provider = new RestMarketDataProvider({ symbols: [symbol], maxPriceAgeMs: 5000, binanceTimeoutMs: 8000 }, request, now);
      const signal = AbortSignal.timeout(26000);
      const basis = { id, time: scannedAt, scannedAt, symbol, rulesVersion, codeVersion: SOURCE_COMMIT };
      let candleClosedAt: number | null = null;
      let record: Record<string, unknown>;
      try {
        const serverTime = await provider.serverTime(signal);
        // During publication lag, use the newest available closed bar, provided
        // the series is still continuous and at most one close behind Binance time.
        const short = frame(await provider.candles(symbol, "15m", serverTime, signal, true), "15m");
        candleClosedAt = short.lastCloseTime + 1;
        // Keep the higher-timeframe zones fixed at the start of the pattern.
        const contextAt = candleClosedAt - 2 * interval;
        const [hourly, background] = await Promise.all([
          provider.candles(symbol, "1h", contextAt, signal).then(candles => frame(candles, "1h")),
          provider.candles(symbol, "4h", contextAt, signal).then(candles => frame(candles, "4h")),
        ]);
        const rules = scanRules(short, hourly, background);
        record = { ...basis, candleClosedAt, status: rules.some(rule => rule.status === "passed") ? "passed" :
          rules.some(rule => rule.status === "watch") ? "watch" : rules.some(rule => rule.status === "filtered") ? "filtered" : "none",
        close: short.close, rvol20: short.volumeRatio20, trend4h: background.trend, rules };
      } catch (error) {
        record = { ...basis, candleClosedAt, status: "error", errorCode: error instanceof AppError ? error.code : "SCAN_FAILED" };
      }
      await store.appendJsonLine(logKey(scannedAt), record);
      return { scannedAt, candleClosedAt, status: record.status, ...(record.errorCode ? { errorCode: record.errorCode } : {}) };
    },
    async list(input: Record<string, unknown>) {
      if (input.version !== 2) return listLegacy(input);
      const latest = now();
      const oldest = hourFor(latest) - historyDays * 24 * hour;
      const before = typeof input.before === "string" ? cursorFormat.exec(input.before) : null;
      const to = before ? Number(before[1]) : latest;
      if (Object.keys(input).some(key => key !== "version" && key !== "before") || input.before !== undefined && !before ||
        to < oldest || to > latest) throw scanError("INVALID_SCAN_CURSOR", "扫描记录分页参数无效。");
      const from = Math.max(oldest, to - pageWindow + 1);
      const hours = Array.from({ length: (hourFor(to) - hourFor(from)) / hour + 1 }, (_, i) => hourFor(to) - i * hour);
      const slots = Array.from({ length: pageSize + 1 }, (_, i) => slotFor(to) - i * interval).filter(slot => slot >= from);
      const reads: (() => Promise<unknown[]>)[] = hours.map(h => () => store.readJsonLines(logKey(h), 8 * 1024 * 1024));
      for (const slot of slots) reads.push(async () => {
        const row = asObject(await store.read(legacyKey(slot)));
        return row ? [{ ...row, time: slot, id: `legacy-${slot}`, scannedAt: null,
          candleClosedAt: row.status === "error" ? null : slot }] : [];
      });
      const rows = (await limited(reads, 4)).flat().flatMap(value => {
        const item = asObject(value);
        if (!item || typeof item.id !== "string" || !/^[a-z0-9-]{1,60}$/.test(item.id) ||
          typeof item.time !== "number" || !Number.isSafeInteger(item.time) || item.time < from || item.time > to ||
          (before && item.time === to && item.id >= before[2]!)) return [];
        return [{ record: item, time: item.time, id: item.id }];
      }).sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const visible = rows.slice(0, pageSize);
      const last = visible.at(-1);
      const hasMore = rows.length > pageSize && last;
      return { records: visible.map(item => item.record), from: hasMore ? last.time : from, to,
        next: hasMore ? `${last.time}:${last.id}` : from > oldest ? `${from}:` : null };
    },
  };
}
