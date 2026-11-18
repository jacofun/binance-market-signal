import { generateKeyPairSync, sign } from "node:crypto";
export const NOW = Date.UTC(2026, 10, 18, 10, 30);
export const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const jwk = { ...publicKey.export({ format: "jwk" }), kid: "trade-sync-v1", use: "sig", alg: "RS256" };
export const env = { DASHSCOPE_API_KEY: "test-private-model-key", SIGNAL_COOLDOWN_SECONDS: "0" };
export const platform = { "x-fc-control-path": "/http-invoke", "x-fc-function-name": "binance-market-signal", "x-fc-request-id": "platform-id" };
export function jwt(delta = {}, headerDelta = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const h = encode({ typ: "JWT", alg: "RS256", kid: jwk.kid, ...headerDelta });
  const p = encode({ iss: "https://www.yanxiao.me", aud: "binance-trade-sync", scope: "trading:sync", sub: "owner", jti: "test-id", iat: NOW / 1000, exp: NOW / 1000 + 120, ...delta });
  return `Bearer ${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}
export const quote = (delta = {}) => ({ symbol: "BTCUSDT", price: 10000, indexPrice: 10001, fundingRate: 0.0001, nextFundingTime: NOW + 3600000, time: NOW, ...delta });
export const snapshot = () => ({ symbol: "BTCUSDT", asOf: NOW, receivedAt: NOW, quote: quote(), source: "rest", warnings: [], openInterest: [], frames: ["1h", "4h", "1d"].map(interval => ({ interval, lastCloseTime: NOW - 1, close: 10000, ema20: 9900, ema50: 9800, atr14: 100, volumeRatio20: 1.5, high20: 10100, low20: 9700, recentCandles: [] })) });
export const proposal = (delta = {}) => ({ status: "candidate", direction: "long", title: "趋势候选", summary: "等待本人确认触发条件", entry: { min: 9990, max: 10010 }, stopLoss: 9900, targets: [{ price: 10200, reason: "前方结构目标" }], triggerConditions: ["确认回踩"], invalidationConditions: ["跌破止损"], evidence: [{ metric: "1h.ema20", reason: "趋势条件" }], counterarguments: ["信号未经收益验证"], validForSeconds: 120, ...delta });
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
  else if (u.pathname.endsWith("/klines")) data = klines({ "1h": 3600000, "4h": 14400000, "1d": 86400000 }[u.searchParams.get("interval")]);
  else if (u.pathname.endsWith("/premiumIndex")) data = { symbol: "BTCUSDT", markPrice: "10000", indexPrice: "10001", lastFundingRate: "0.0001", nextFundingTime: NOW + 3600000, time: NOW };
  else data = [{ symbol: "BTCUSDT", timestamp: NOW - 1000, sumOpenInterest: "100", sumOpenInterestValue: "1000000" }];
  return Promise.resolve(new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));
}
