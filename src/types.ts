export type Interval = "4h" | "1h" | "15m";
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
  volumePrice: VolumeBar[];
  atrPct: number;
  volatility: "low" | "normal" | "high" | null;
  trend: Trend;
  volumeWindows: { bars: number; meanVolume: number; volumeChangePct: number | null; takerBuyShare: number | null; takerBuyChangePp: number | null }[];
  zones: PriceZone[];
  historicalRanges: Record<ResearchHours, Record<"long" | "short", HistoricalRange>>;
  priceLevels: { high200: number; low200: number; swingHighs: number[]; swingLows: number[] };
}
export interface Snapshot {
  symbol: string; asOf: number; receivedAt: number; quote: Quote;
  frames: Frame[]; openInterest: { time: number; contracts: number; notional: number }[];
  tickSize: number; warnings: string[]; source: "rest" | "websocket";
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
  targets: { price: number; reason: string; zoneId: string }[];
  triggerConditions: string[]; invalidationConditions: string[];
  evidence: { metric: string; reason: string }[];
  counterarguments: string[]; validForSeconds: number;
  research: ResearchProposal;
}
export interface ModelResult { proposal: Proposal; usage: { inputTokens: number | null; outputTokens: number | null } }

export type ResearchHours = 4 | 12 | 24;
export type Trend = "up" | "down" | "flat";
export interface VolumeBar {
  openTime: number;
  closeChangePct: number | null;
  rangePct: number;
  upperWickShare: number | null;
  lowerWickShare: number | null;
  bodyShare: number | null;
  clv: number | null;
  volumeRatio20: number | null;
  takerBuyShare: number | null;
  newHigh20: boolean | null;
  newLow20: boolean | null;
  observations: string[];
}
export interface PriceZone {
  id: string;
  lower: number;
  upper: number;
  interval: Interval;
  kind: "support" | "resistance";
  status: "active" | "broken" | "retested";
  touches: number;
  lastTouchTime: number;
  firstPivotTime: number;
  confirmedAt: number;
  pivotCount: number;
  breakTime: number | null;
  lastRetestTime: number | null;
  lastRetestRvol20: number | null;
  breakRvol20: number | null;
  closesBeyondBreak: number | null;
  atrAtConfirmation: number;
  reactions: { time: number; closeClv: number | null; rvol20: number | null; moveAtr: number | null }[];
}
export interface HistoricalRange {
  samples: number;
  bars: number;
  favorableMovePct: { p50: number; p75: number; p90: number } | null;
}
export interface ResearchProposal {
  marketRegime: "trend" | "range" | "transition";
  scenario: "continuation" | "reversal" | "none";
  timeframeAnalysis: Record<Interval, string>;
  entryZoneId: string | null;
  stopZoneId: string | null;
  riskFactors: string[];
  researchHorizon: ResearchHours;
}
