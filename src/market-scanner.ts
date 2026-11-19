import { AppError } from "./errors.js";
import type { Env } from "./config.js";
import { limited } from "./http.js";
import { frame, INTERVAL_MS, RestMarketDataProvider } from "./market.js";
import { makeOrderStore } from "./order-oss.js";
import { effectiveKind } from "./price-zones.js";
import { SOURCE_COMMIT } from "./version.js";
import type { Candle, Frame, PriceZone } from "./types.js";

export const SCANNER_TRIGGER = "binance-market-scanner";
const symbol = "BTCUSDT";
const interval = INTERVAL_MS["15m"];
const pageSize = 16;
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
function storageConfig(env: Env) {
  const value = (name: string, raw: string | undefined, pattern: RegExp) => {
    const field = raw?.trim() || "";
    if (!pattern.test(field)) throw scanError("SCAN_STORAGE_CONFIGURATION", `请检查扫描存储配置 ${name}。`, 503);
    return field;
  };
  const bucket = value("SIGNAL_SCANNER_OSS_BUCKET", env.SIGNAL_SCANNER_OSS_BUCKET ?? env.SIGNAL_ORDER_OSS_BUCKET, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  const region = value("SIGNAL_SCANNER_OSS_REGION", env.SIGNAL_SCANNER_OSS_REGION ?? env.SIGNAL_ORDER_OSS_REGION, /^[a-z]{2}(?:-[a-z0-9]+)+$/);
  const network = value("SIGNAL_SCANNER_OSS_NETWORK", env.SIGNAL_SCANNER_OSS_NETWORK ?? env.SIGNAL_ORDER_OSS_NETWORK ?? "public", /^(public|internal)$/);
  return { bucket, region, ossHost: `${bucket}.oss-${region}${network === "internal" ? "-internal" : ""}.aliyuncs.com`,
    prefix: "private/market-signal-scanner/v1",
    ossKey: value("ACCESS_KEY_ID", env.ACCESS_KEY_ID, /^[A-Za-z0-9_-]{8,128}$/),
    ossSecret: value("ACCESS_KEY_SECRET", env.ACCESS_KEY_SECRET, /^[A-Za-z0-9_+/=-]{16,200}$/) };
}
const slotFor = (time: number) => Math.floor(time / interval) * interval;
const keyFor = (slot: number) => `${symbol}/${slot}.json`;

export function scanSlot(input: Record<string, unknown>, now: number) {
  const time = typeof input.triggerTime === "string" ? Date.parse(input.triggerTime) : NaN;
  if (input.triggerName !== SCANNER_TRIGGER || !Number.isFinite(time) || time > now + 5000 || now - time >= interval) {
    throw scanError("INVALID_SCAN_TIMER", "扫描触发时间无效、过期或超过容许时钟偏差。");
  }
  return slotFor(time);
}

export function makeMarketScanner(env: Env, now: () => number, request: typeof fetch = fetch) {
  const store = makeOrderStore(storageConfig(env), now, request, "SCAN");
  return {
    async run(slot: number) {
      const existing = await store.read(keyFor(slot));
      if (existing !== null) return { slot, duplicate: true };
      // Only public, closed-candle endpoints enter this path.
      const provider = new RestMarketDataProvider({ symbols: [symbol], maxPriceAgeMs: 5000, binanceTimeoutMs: 8000 }, request, now);
      const signal = AbortSignal.timeout(26000);
      const basis = { slot, symbol, rulesVersion, codeVersion: SOURCE_COMMIT };
      let record: Record<string, unknown>;
      try {
        const serverTime = await provider.serverTime(signal);
        if (serverTime < slot) throw scanError("SCAN_CANDLE_NOT_CLOSED", "币安尚未确认该时段收盘。", 503);
        // Use a context available before either of the two pattern candles.
        const contextAt = slot - 2 * interval;
        const [short, hourly, background] = await limited([
          async () => frame(await provider.candles(symbol, "15m", slot, signal), "15m"),
          async () => frame(await provider.candles(symbol, "1h", contextAt, signal), "1h"),
          async () => frame(await provider.candles(symbol, "4h", contextAt, signal), "4h"),
        ]);
        const rules = scanRules(short!, hourly!, background!);
        record = { ...basis, status: rules.some(rule => rule.status === "passed") ? "passed" :
          rules.some(rule => rule.status === "watch") ? "watch" : rules.some(rule => rule.status === "filtered") ? "filtered" : "none",
        close: short!.close, rvol20: short!.volumeRatio20, trend4h: background!.trend, rules };
      } catch (error) {
        if (error instanceof AppError && error.code === "SCAN_CANDLE_NOT_CLOSED") throw error;
        record = { ...basis, status: "error", errorCode: error instanceof AppError ? error.code : "SCAN_FAILED" };
      }
      const created = await store.create(keyFor(slot), record);
      return created ? { slot, status: record.status, ...(record.errorCode ? { errorCode: record.errorCode } : {}) } : { slot, duplicate: true };
    },
    async list(input: Record<string, unknown>) {
      const latest = slotFor(now());
      const oldest = latest - historyDays * 24 * 4 * interval;
      const before = input.before === undefined ? latest + interval : input.before;
      if (Object.keys(input).some(key => key !== "before") || typeof before !== "number" || !Number.isSafeInteger(before) ||
        before % interval !== 0 || before <= oldest || before > latest + interval) {
        throw scanError("INVALID_SCAN_CURSOR", "扫描记录分页参数无效。");
      }
      const slots = Array.from({ length: pageSize }, (_, i) => before - (i + 1) * interval).filter(slot => slot >= oldest);
      const rows = await limited(slots.map(slot => () => store.read(keyFor(slot))), 4);
      const start = slots.at(-1)!;
      return { records: rows.filter(row => row !== null), from: start, to: before - interval, next: start > oldest ? start : null };
    },
  };
}
