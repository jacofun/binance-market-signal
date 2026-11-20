import { atrSeries, emaSeries, frameTrend, historicalRanges, volumeBars, volumeWindows } from "./features.js";
import { confirmedPivots, priceZones, selectZones } from "./price-zones.js";
import { AppError } from "./errors.js";
import { boundedJson, limited } from "./http.js";
import type { Config } from "./config.js";
import type { Candle, Frame, Interval, MarketDataProvider, Quote, Snapshot } from "./types.js";

export const ANALYSIS_INTERVALS = ["4h", "1h", "15m"] as const satisfies readonly Interval[];
export const INTERVAL_MS: Record<Interval, number> = { "4h": 14400000, "1h": 3600000, "15m": 900000 };
export const CANDLE_LIMIT = 200;
export const candleRow = (c: Candle) => [c.openTime, c.open, c.high, c.low, c.close, c.volume, c.takerBuyVolume];
const badData = () => new AppError("INVALID_MARKET_DATA", "行情缺失、时间不连续或字段无效，本次不生成交易机会。", 502);
export function numeric(value: unknown, positive = false): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value))) throw badData();
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e18 || (positive && n <= 0)) throw badData();
  return n;
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw badData();
  return Number(value);
}
export function parseCandles(raw: unknown, interval: Interval, serverTime: number, allowOneMissingClose = false): Candle[] {
  if (!Array.isArray(raw) || raw.length > 300) throw badData();
  const period = INTERVAL_MS[interval];
  const rows = raw.map((row: unknown) => {
    if (!Array.isArray(row) || row.length < 11) throw badData();
    const c: Candle = { openTime: timestamp(row[0]), closeTime: timestamp(row[6]), open: numeric(row[1], true),
      high: numeric(row[2], true), low: numeric(row[3], true), close: numeric(row[4], true),
      volume: numeric(row[5]), takerBuyVolume: numeric(row[9]) };
    if (c.openTime % period || c.closeTime !== c.openTime + period - 1 || c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close) || c.low > c.high || c.volume < 0 || c.takerBuyVolume < 0 ||
      c.takerBuyVolume > c.volume + 1e-8) throw badData();
    return c;
  }).filter(c => c.closeTime < serverTime);
  const expectedClose = Math.floor(serverTime / period) * period - 1;
  if (rows.length < 60 || rows.some((c, i) => i > 0 && c.openTime !== rows[i - 1]!.openTime + period) ||
    rows.at(-1)!.closeTime < expectedClose - (allowOneMissingClose ? period : 0)) throw badData();
  return rows.slice(-CANDLE_LIMIT);
}

function priceLevels(candles: Candle[]): Frame["priceLevels"] {
  const pivots = confirmedPivots(candles);
  const swingHighs = pivots.filter(p => p.kind === "resistance").map(p => p.price);
  const swingLows = pivots.filter(p => p.kind === "support").map(p => p.price);
  return {
    high200: Math.max(...candles.map(c => c.high)), low200: Math.min(...candles.map(c => c.low)),
    swingHighs: swingHighs.slice(-8), swingLows: swingLows.slice(-8),
  };
}

export function frame(candles: Candle[], interval: Interval): Frame {
  if (candles.length < 60) throw badData();
  candles = candles.slice(-CANDLE_LIMIT);
  const atr = atrSeries(candles);
  const atr14 = atr.at(-1)!;
  const last = candles.at(-1)!;
  const previous20 = candles.slice(-21, -1);
  const shortEma = emaSeries(candles, 20);
  const longEma = emaSeries(candles, 50);
  const features = volumeBars(candles, shortEma, longEma);
  const volumePrice = features.slice(-5);
  const ema20 = shortEma.at(-1)!;
  const ema50 = longEma.at(-1)!;
  const atrPct = atr14 / last.close * 100;
  const baselineAtrPct = atr.slice(-21, -1)
    .reduce<number>((sum, v, i) => sum + (v ?? 0) / previous20[i]!.close * 100, 0) / 20;
  const volatilityRatio = baselineAtrPct > 0 ? atrPct / baselineAtrPct : null;
  const volatility = volatilityRatio === null ? null : volatilityRatio >= 1.25 ? "high" : volatilityRatio <= 0.8 ? "low" : "normal";
  const trend = frameTrend(last.close, ema20, ema50);
  const zones = selectZones(priceZones(candles, interval, atr, features), last.close);
  return { interval, lastCloseTime: last.closeTime, close: last.close, ema20, ema50, atr14, atrPct, volatility, trend,
    volumeRatio20: volumePrice.at(-1)!.volumeRatio20, volumeWindows: volumeWindows(candles),
    high20: Math.max(...previous20.map(c => c.high)), low20: Math.min(...previous20.map(c => c.low)),
    recentCandles: candles, volumePrice, priceLevels: priceLevels(candles), zones,
    historicalRanges: historicalRanges(candles, INTERVAL_MS[interval]) };
}

export class RestMarketDataProvider implements MarketDataProvider {
  private offset = 0;
  private instruments: { expires: number; ticks: Map<string, number> } | undefined;
  constructor(private config: Pick<Config, "binanceTimeoutMs" | "maxPriceAgeMs" | "symbols">, private request: typeof fetch = fetch,
    private now: () => number = Date.now, private base = "https://fapi.binance.com") {}
  async get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let marketHttpStatus: number | undefined;
    try {
      const response = await this.request(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.binanceTimeoutMs)]),
        headers: { Accept: "application/json" }, cache: "no-store" });
      marketHttpStatus = response.status;
      if (response.status === 429 || response.status === 418) {
        const retry = Number(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
        throw new AppError("BINANCE_RATE_LIMITED", "币安限制请求，请等待后重试。", 503, Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 600) : 60);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AppError("BINANCE_UNAVAILABLE", "币安行情请求失败，请检查新加坡函数公网连接及接口可用性。", 502);
      }
      return await boundedJson(response, (path === "/fapi/v1/exchangeInfo" ? 4 : 0.5) * 1024 * 1024, "INVALID_MARKET_DATA");
    } catch (error) {
      if (error instanceof AppError) {
        error.marketEndpoint = path;
        error.marketHttpStatus = marketHttpStatus;
        throw error;
      }
      throw new AppError("BINANCE_TIMEOUT", "币安行情请求超时或连接中断。", 504, undefined, undefined, {
        cause: error, marketEndpoint: path, marketHttpStatus,
      });
    }
  }
  async serverTime(signal: AbortSignal): Promise<number> {
    const value = await this.get("/fapi/v1/time", {}, signal) as { serverTime?: unknown };
    const time = timestamp(value?.serverTime);
    this.offset = time - this.now();
    if (Math.abs(this.offset) > 30000) throw new AppError("CLOCK_SKEW", "函数与币安服务器时间偏差过大。", 503);
    return time;
  }
  async quote(symbol: string, signal: AbortSignal): Promise<Quote> {
    const raw = await this.get("/fapi/v1/premiumIndex", { symbol }, signal) as Record<string, unknown>;
    if (raw?.symbol !== symbol) throw badData();
    const q: Quote = { symbol, price: numeric(raw.markPrice, true), indexPrice: numeric(raw.indexPrice, true), fundingRate: numeric(raw.lastFundingRate),
      nextFundingTime: timestamp(raw.nextFundingTime), time: timestamp(raw.time) };
    const age = this.now() + this.offset - q.time;
    if (age < -2000 || age > this.config.maxPriceAgeMs) throw new AppError("STALE_MARKET_DATA", "最新标记价格已过期，本次不生成有效机会。", 503);
    return q;
  }
  async candles(symbol: string, interval: Interval, at: number, signal: AbortSignal, allowOneMissingClose = false): Promise<Candle[]> {
    return parseCandles(await this.get("/fapi/v1/klines", { symbol, interval, limit: String(CANDLE_LIMIT + 1), endTime: String(at) }, signal), interval, at, allowOneMissingClose);
  }
  async openInterest(symbol: string, at: number, signal: AbortSignal): Promise<Snapshot["openInterest"]> {
    const raw = await this.get("/futures/data/openInterestHist", { symbol, period: "1h", limit: "12" }, signal);
    if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw badData();
    const rows = raw.map(r => {
      if (!r || r.symbol !== symbol) throw badData();
      const row = { time: numeric(r.timestamp, true), contracts: numeric(r.sumOpenInterest), notional: numeric(r.sumOpenInterestValue) };
      if (!Number.isSafeInteger(row.time) || row.time > at + 2000 || row.contracts < 0 || row.notional < 0) throw badData();
      return row;
    });
    if (rows.some((r, i) => i > 0 && r.time <= rows[i - 1]!.time) || at - rows.at(-1)!.time > 2 * INTERVAL_MS["1h"]) throw badData();
    return rows.filter(row => row.time <= at);
  }
  private async tickSize(symbol: string, signal: AbortSignal) {
    if (!this.instruments || this.instruments.expires <= this.now()) {
      const raw = await this.get("/fapi/v1/exchangeInfo", {}, signal) as { symbols?: { symbol: string; contractType: string; filters: { filterType: string; tickSize: string }[] }[] };
      if (!Array.isArray(raw?.symbols)) throw badData();
      const ticks = new Map<string, number>();
      for (const instrument of raw.symbols) {
        if (instrument?.contractType !== "PERPETUAL" || !this.config.symbols.includes(instrument.symbol)) continue;
        const filter = instrument.filters?.find(f => f.filterType === "PRICE_FILTER");
        ticks.set(instrument.symbol, numeric(filter?.tickSize, true));
      }
      this.instruments = { expires: this.now() + 3_600_000, ticks };
    }
    const tick = this.instruments.ticks.get(symbol);
    if (!tick) throw badData();
    return tick;
  }
  async snapshot(symbol: string, signal: AbortSignal): Promise<Snapshot> {
    const at = await this.serverTime(signal);
    const warnings: string[] = [];
    // At most two outbound market calls at a time on the 0.35-vCPU instance.
    const tasks: (() => Promise<unknown>)[] = ANALYSIS_INTERVALS.map(interval => async () => frame(await this.candles(symbol, interval, at, signal), interval));
    tasks.push(() => this.quote(symbol, signal));
    tasks.push(async () => {
      try { return await this.openInterest(symbol, at, signal); }
      catch (error) {
        if (signal.aborted || error instanceof AppError && error.code === "BINANCE_RATE_LIMITED") throw error;
        warnings.push("持仓量数据不可用，不得据此推断多空持仓或资金流入。");
        return [];
      }
    });
    tasks.push(() => this.tickSize(symbol, signal));
    const values = await limited(tasks);
    return { symbol, asOf: at, receivedAt: this.now(), quote: values[3] as Quote,
      frames: values.slice(0, 3) as Frame[], tickSize: values[5] as number, openInterest: values[4] as Snapshot["openInterest"], warnings, source: "rest" };
  }
  close() {}
}
