import { AppError } from "./errors.js";
import { boundedJson, limited } from "./http.js";
import type { Config } from "./config.js";
import type { Candle, Frame, Interval, MarketDataProvider, Quote, Snapshot } from "./types.js";

export const INTERVAL_MS: Record<Interval, number> = { "1h": 3600000, "4h": 14400000, "1d": 86400000 };
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
export function parseCandles(raw: unknown, interval: Interval, serverTime: number): Candle[] {
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
  if (rows.length < 60 || rows.some((c, i) => i > 0 && c.openTime !== rows[i - 1]!.openTime + period) ||
    rows.at(-1)!.closeTime !== Math.floor(serverTime / period) * period - 1) throw badData();
  return rows.slice(-200);
}
export function frame(candles: Candle[], interval: Interval): Frame {
  if (candles.length < 60) throw badData();
  const ema = (period: number) => {
    let value = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (const c of candles.slice(period)) value += (c.close - value) * 2 / (period + 1);
    return value;
  };
  const tr = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i]!.close), Math.abs(c.low - candles[i]!.close)));
  let atr = tr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  for (const value of tr.slice(14)) atr = (atr * 13 + value) / 14;
  const last = candles.at(-1)!;
  const previous20 = candles.slice(-21, -1);
  const volumeMean = previous20.reduce((s, c) => s + c.volume, 0) / 20;
  return { interval, lastCloseTime: last.closeTime, close: last.close, ema20: ema(20), ema50: ema(50), atr14: atr,
    volumeRatio20: volumeMean > 0 ? last.volume / volumeMean : null,
    high20: Math.max(...previous20.map(c => c.high)), low20: Math.min(...previous20.map(c => c.low)), recentCandles: candles.slice(-24) };
}

export class RestMarketDataProvider implements MarketDataProvider {
  private offset = 0;
  constructor(private config: Config, private request: typeof fetch = fetch, private now: () => number = Date.now) {}
  async get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, "https://fapi.binance.com");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await this.request(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.binanceTimeoutMs)]),
        headers: { Accept: "application/json" }, cache: "no-store" });
      if (response.status === 429 || response.status === 418) {
        const retry = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        throw new AppError("BINANCE_RATE_LIMITED", "币安限制请求，请等待后重试。", 503, Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 600) : 60);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("BINANCE_UNAVAILABLE", "币安行情请求失败，请检查首尔函数公网连接及接口可用性。", 502);
      }
      return await boundedJson(response, 512 * 1024, "INVALID_MARKET_DATA");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("BINANCE_TIMEOUT", "币安行情请求超时或连接中断。", 504);
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
  async candles(symbol: string, interval: Interval, at: number, signal: AbortSignal): Promise<Candle[]> {
    return parseCandles(await this.get("/fapi/v1/klines", { symbol, interval, limit: "201", endTime: String(at) }, signal), interval, at);
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
    return rows;
  }
  async snapshot(symbol: string, signal: AbortSignal): Promise<Snapshot> {
    const at = await this.serverTime(signal);
    const warnings: string[] = [];
    // At most two outbound market calls at a time on the 0.35-vCPU instance.
    const tasks: (() => Promise<unknown>)[] = (["1h", "4h", "1d"] as Interval[]).map(interval => async () => frame(await this.candles(symbol, interval, at, signal), interval));
    tasks.push(() => this.quote(symbol, signal));
    tasks.push(async () => {
      try { return await this.openInterest(symbol, at, signal); }
      catch (error) {
        if (signal.aborted || error instanceof AppError && error.code === "BINANCE_RATE_LIMITED") throw error;
        warnings.push("持仓量数据不可用，不得据此推断多空持仓或资金流入。");
        return [];
      }
    });
    const values = await limited(tasks);
    return { symbol, asOf: at, receivedAt: this.now(), quote: values[3] as Quote,
      frames: values.slice(0, 3) as Frame[], openInterest: values[4] as Snapshot["openInterest"], warnings, source: "rest" };
  }
  close() {}
}
