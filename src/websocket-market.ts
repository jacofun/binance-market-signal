import { ANALYSIS_INTERVALS, CANDLE_LIMIT, RestMarketDataProvider, INTERVAL_MS, numeric, parseCandles } from "./market.js";
import type { Config } from "./config.js";
import type { Candle, Interval, Quote, Snapshot } from "./types.js";

type SocketFactory = (url: string) => WebSocket;
// A bounded adapter for a continuously running host, not an FC background task.
// Reconnects never claim zero loss: missing closed bars are repaired with REST.
export class WebSocketMarketDataProvider extends RestMarketDataProvider {
  private socket?: WebSocket;
  private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private rotate?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private lastMessage = 0;
  private bars = new Map<string, Candle[]>();
  private quotes = new Map<string, Quote>();
  constructor(private settings: Config, request: typeof fetch = fetch, private clock: () => number = Date.now,
    private socketFactory: SocketFactory = url => new WebSocket(url)) {
    super(settings, request, clock);
    this.connect();
  }
  private connect() {
    if (this.closed) return;
    const streams = this.settings.symbols.flatMap(symbol => [
      ...ANALYSIS_INTERVALS.map(i => `${symbol.toLowerCase()}@kline_${i}`), `${symbol.toLowerCase()}@markPrice@1s`,
    ]);
    const socket = this.socketFactory(`wss://fstream.binance.com/market/stream?streams=${streams.join("/")}`);
    this.socket = socket;
    this.lastMessage = this.clock();
    socket.addEventListener("message", event => {
      if (this.socket !== socket || this.closed) return;
      try {
        if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 128 * 1024) throw new Error();
        const raw = JSON.parse(event.data);
        this.ingest(raw.data || raw);
        this.lastMessage = this.clock();
        this.attempts = 0;
      } catch { socket.close(1000, "invalid market data"); }
    });
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.clearConnectionTimers();
      this.quotes.clear();
      if (!this.closed) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.floor(Math.random() * 500);
        this.retry = setTimeout(() => this.connect(), delay);
        this.retry.unref();
      }
    });
    this.watchdog = setInterval(() => {
      if (this.clock() - this.lastMessage > 20000) socket.close(1000, "stale stream");
    }, 5000);
    this.watchdog.unref();
    this.rotate = setTimeout(() => socket.close(1000, "scheduled reconnect"), 23 * 3600000);
    this.rotate.unref();
  }
  private clearConnectionTimers() {
    clearInterval(this.watchdog); clearTimeout(this.rotate);
  }
  ingest(raw: Record<string, unknown>) {
    const symbol = String(raw.s);
    if (!this.settings.symbols.includes(symbol)) return;
    if (raw.e === "markPriceUpdate") {
      const q: Quote = { symbol, time: numeric(raw.E, true), price: numeric(raw.p, true), indexPrice: numeric(raw.i, true),
        fundingRate: numeric(raw.r), nextFundingTime: numeric(raw.T, true) };
      if (!Number.isSafeInteger(q.time) || !Number.isSafeInteger(q.nextFundingTime) || q.time > this.clock() + 2000) throw new Error();
      if (!this.quotes.has(symbol) || q.time > this.quotes.get(symbol)!.time) this.quotes.set(symbol, q);
    }
    if (raw.e === "kline") {
      const k = raw.k as Record<string, unknown> | undefined;
      if (!k || k.x !== true || !ANALYSIS_INTERVALS.includes(k.i as Interval)) return;
      const interval = k.i as Interval;
      const c: Candle = { openTime: numeric(k.t, true), closeTime: numeric(k.T, true), open: numeric(k.o, true), high: numeric(k.h, true),
        low: numeric(k.l, true), close: numeric(k.c, true), volume: numeric(k.v), takerBuyVolume: numeric(k.V) };
      if (!Number.isSafeInteger(c.openTime) || c.openTime % INTERVAL_MS[interval] || c.closeTime !== c.openTime + INTERVAL_MS[interval] - 1 ||
        c.closeTime > this.clock() + 2000 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low > c.high ||
        c.volume < 0 || c.takerBuyVolume < 0 || c.takerBuyVolume > c.volume + 1e-8) throw new Error();
      const key = `${symbol}:${interval}`;
      const rows = this.bars.get(key) || [];
      // Ignore duplicate or late events. A hole is repaired before analysis.
      if (!rows.length || c.openTime > rows.at(-1)!.openTime) this.bars.set(key, [...rows, c].slice(-CANDLE_LIMIT));
    }
  }
  override async candles(symbol: string, interval: Interval, at: number, signal: AbortSignal): Promise<Candle[]> {
    const key = `${symbol}:${interval}`;
    const rows = this.bars.get(key) || [];
    try {
      const closed = parseCandles(rows.map(c => [c.openTime, c.open, c.high, c.low, c.close, c.volume, c.closeTime, 0, 0, c.takerBuyVolume, 0]), interval, at);
      if (closed.length === CANDLE_LIMIT) return closed;
    } catch {
      // Fall back to REST when cached bars are stale or have gaps.
    }
    const repaired = await super.candles(symbol, interval, at, signal);
    const merged = new Map([...repaired, ...(this.bars.get(key) || [])].map(c => [c.openTime, c]));
    this.bars.set(key, [...merged.values()].sort((a, b) => a.openTime - b.openTime).slice(-CANDLE_LIMIT));
    return repaired;
  }
  override async quote(symbol: string, signal: AbortSignal): Promise<Quote> {
    const q = this.quotes.get(symbol);
    const age = q ? this.clock() - q.time : Infinity;
    return q && age >= -2000 && age <= this.settings.maxPriceAgeMs ? { ...q } : super.quote(symbol, signal);
  }
  override async snapshot(symbol: string, signal: AbortSignal): Promise<Snapshot> {
    const result = await super.snapshot(symbol, signal);
    return { ...result, source: "websocket", warnings: [...result.warnings, "持续订阅模式；缓存未就绪或存在缺口时通过 REST 补齐。"] };
  }
  override close() {
    this.closed = true;
    clearTimeout(this.retry); this.clearConnectionTimers(); this.socket?.close();
    this.bars.clear(); this.quotes.clear();
  }
}
