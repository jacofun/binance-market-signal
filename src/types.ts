export type Interval = "1h" | "4h" | "1d";
export type Style = "trend" | "reversal" | "neutral";
export interface Candle {
  openTime: number; closeTime: number; open: number; high: number; low: number;
  close: number; volume: number; takerBuyVolume: number;
}
export interface Quote {
  symbol: string; price: number; indexPrice: number; fundingRate: number; nextFundingTime: number; time: number;
}
export interface Frame {
  interval: Interval; lastCloseTime: number; close: number; ema20: number; ema50: number;
  atr14: number; volumeRatio20: number | null; high20: number; low20: number;
  recentCandles: Candle[];
}
export interface Snapshot {
  symbol: string; asOf: number; receivedAt: number; quote: Quote;
  frames: Frame[]; openInterest: { time: number; contracts: number; notional: number }[];
  warnings: string[]; source: "rest" | "websocket";
}
export interface MarketDataProvider {
  snapshot(symbol: string, signal: AbortSignal): Promise<Snapshot>;
  quote(symbol: string, signal: AbortSignal): Promise<Quote>;
  close(): void;
}
export interface Proposal {
  status: "candidate" | "watch" | "none";
  direction: "long" | "short" | null;
  title: string; summary: string;
  entry: { min: number; max: number } | null;
  stopLoss: number | null;
  targets: { price: number; reason: string }[];
  triggerConditions: string[]; invalidationConditions: string[];
  evidence: { metric: string; reason: string }[];
  counterarguments: string[]; validForSeconds: number;
}
export interface ModelResult { proposal: Proposal; usage: { inputTokens: number | null; outputTokens: number | null } }
