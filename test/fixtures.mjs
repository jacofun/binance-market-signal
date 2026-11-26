import { generateKeyPairSync, sign } from "node:crypto";
import { ANALYSIS_INTERVALS, INTERVAL_MS } from "../build/market.js";
export const NOW = Date.UTC(2026, 10, 18, 10, 30);
export const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const jwk = { ...publicKey.export({ format: "jwk" }), kid: "trade-sync-v1", use: "sig", alg: "RS256" };
export const env = { USE_DETERMINISTIC_MODELS: "false", DASHSCOPE_API_KEY: "test-private-model-key", SIGNAL_COOLDOWN_SECONDS: "0" };
export function jwt(delta = {}, headerDelta = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const h = encode({ typ: "JWT", alg: "RS256", kid: jwk.kid, ...headerDelta });
  const p = encode({ iss: "https://www.yanxiao.me", aud: "binance-trade-sync", scope: "trading:sync", sub: "owner", jti: "test-id", iat: NOW / 1000, exp: NOW / 1000 + 120, ...delta });
  return `Bearer ${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}
export const quote = (delta = {}) => ({ symbol: "BTCUSDT", price: 10000, indexPrice: 10001, fundingRate: 0.0001, nextFundingTime: NOW + 3600000, time: NOW, ...delta });
const zone = (id, kind, lower, upper) => ({ id, kind, lower, upper, interval: "1h", status: "active", touches: 1 });
export const snapshot = () => ({
  symbol: "BTCUSDT", asOf: NOW, receivedAt: NOW, tickSize: 0.1, quote: quote(), source: "rest", warnings: [], openInterest: [],
  frames: ANALYSIS_INTERVALS.map(interval => ({
    interval, lastCloseTime: NOW - 1, close: 10000, ema20: 9900, ema50: 9800, atr14: 100, atrPct: 1, trend: "up", volumeRatio20: 1.5,
    high20: 10100, low20: 9700, recentCandles: [],
    volumePrice: [{ openTime: NOW - INTERVAL_MS[interval], closeChangePct: 0.5, volumeRatio20: 1.5, takerBuyShare: 0.6 }],
    priceLevels: { high200: 10200, low200: 9500, swingHighs: [], swingLows: [] },
    zones: interval === "1h" ? [zone("entry", "support", 9980, 10020), zone("short-stop", "resistance", 10020, 10080),
      zone("up", "resistance", 10180, 10220), zone("down", "support", 9680, 9720), zone("lower", "support", 9480, 9520)] : [],
    historicalRanges: { 4: {}, 12: {}, 24: {} },
  })),
});
export function m2Snapshot() {
  const market = snapshot();
  const hourly = market.frames.find(frame => frame.interval === "1h");
  hourly.zones = hourly.zones.filter(zone => zone.id !== "short-stop");
  return market;
}
export const proposal = (delta = {}) => {
  const direction = Object.hasOwn(delta, "direction") ? delta.direction : "long";
  return { status: "candidate", direction, title: "趋势候选", summary: "等待本人确认触发条件",
    entry: { min: 9990, max: 10010 }, stopLoss: 9900, targets: [{ price: 10200, reason: "前方结构目标", zoneId: "up" }],
    triggerConditions: ["确认回踩"], invalidationConditions: ["跌破止损"],
    evidence: [{ metric: "1h.volumePrice", reason: "1小时上涨0.5%，成交量为前20根均量的1.5倍" }],
    counterarguments: ["信号未经收益验证"], validForSeconds: 120,
    research: { marketRegime: "trend", scenario: direction ? "continuation" : "none", researchHorizon: 12,
      timeframeAnalysis: { "4h": "趋势背景", "1h": "区间结构", "15m": "量价变化" },
      entryZoneId: direction ? "entry" : null, stopZoneId: direction === "short" ? "short-stop" : direction ? "entry" : null, riskFactors: [] },
    ...delta,
  };
};
export const modelResult = (p = proposal()) => ({ proposal: p, usage: { inputTokens: 100, outputTokens: 100 } });
export const provider = (delta = {}) => ({ snapshot: async () => snapshot(), quote: async () => quote(), close() {}, ...delta });
export const silent = { info() {}, error() {} };
export function klines(period, at = NOW, count = 201) {
  const current = Math.floor(at / period) * period;
  return Array.from({ length: count }, (_, i) => {
    const start = current - (count - 1 - i) * period;
    return [start, "10000", "10100", "9900", "10010", "10", start + period - 1, "100000", 20, "4", "40000", "0"];
  });
}
export function marketFetch(url) {
  const u = new URL(url);
  let data;
  if (u.pathname.endsWith("/time")) data = { serverTime: NOW };
  else if (u.pathname.endsWith("/klines")) data = klines(INTERVAL_MS[u.searchParams.get("interval")]);
  else if (u.pathname.endsWith("/exchangeInfo")) data = { symbols: [{ symbol: "BTCUSDT", contractType: "PERPETUAL", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.10" }] }] };
  else if (u.pathname.endsWith("/premiumIndex")) data = { symbol: "BTCUSDT", markPrice: "10000", indexPrice: "10001", lastFundingRate: "0.0001", nextFundingTime: NOW + 3600000, time: NOW };
  else data = [{ symbol: "BTCUSDT", timestamp: NOW - 1000, sumOpenInterest: "100", sumOpenInterestValue: "1000000" }];
  return Promise.resolve(new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));
}
