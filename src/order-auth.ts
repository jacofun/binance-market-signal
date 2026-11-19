import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { analyze } from "./analysis.js";
import { gatewayClaims } from "./auth.js";
import type { Env } from "./config.js";
import { AppError } from "./errors.js";
import { loadOssConfig } from "./oss-config.js";

export const ORDER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const SEALED = /^[A-Za-z0-9_-]{1,1500}\.[A-Za-z0-9_-]{43}$/;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type OrderMode = "demo" | "live";
export interface OrderConfig extends ReturnType<typeof loadOssConfig> {
  mode: OrderMode;
  executionEnabled: boolean;
  recoverySecret?: string;
  base: string;
  apiKey: string;
  apiSecret: string;
  quantity: string;
  maxRisk: number;
  prefix: string;
  signingSecret: string;
  issuer: string;
  audience: string;
}
export function loadOrderConfig(env: Env): OrderConfig {
  const mode = env.SIGNAL_ORDER_MODE;
  if (mode !== "demo" && mode !== "live") throw new AppError("ORDERS_DISABLED", "订单功能未启用。", 503);
  const bad = (field: string) => new AppError("ORDER_CONFIGURATION", `请检查订单环境变量 ${field}。`, 503,
    undefined, undefined, { configurationField: field });
  const required = (field: string, pattern: RegExp) => {
    const value = env[field]?.trim() || "";
    if (!pattern.test(value)) throw bad(field);
    return value;
  };
  const base = required("BINANCE_BASE_URL", /^https:\/\/[a-z0-9.-]+\/?$/).replace(/\/$/, "");
  if (mode === "live" ? base !== "https://fapi.binance.com" :
    !["https://demo-fapi.binance.com", "https://testnet.binancefuture.com"].includes(base)) throw bad("BINANCE_BASE_URL");
  const quantity = env.SIGNAL_ORDER_QUANTITY?.trim() || "0.001";
  const risk = env.SIGNAL_ORDER_MAX_RISK_USDT?.trim() || "1";
  const positiveDecimal = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,8})?$/;
  if (!positiveDecimal.test(quantity) || Number(quantity) <= 0) throw bad("SIGNAL_ORDER_QUANTITY");
  if (!positiveDecimal.test(risk) || Number(risk) <= 0) throw bad("SIGNAL_ORDER_MAX_RISK_USDT");
  const prefix = env.SIGNAL_ORDER_OSS_PREFIX?.trim() || "private/market-signal-orders/v1";
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+){0,7}$/.test(prefix) || prefix.length > 180) throw bad("SIGNAL_ORDER_OSS_PREFIX");
  return {
    ...loadOssConfig(env, "ORDER"),
    mode, executionEnabled: env.SIGNAL_ORDER_EXECUTE === "true",
    recoverySecret: /^[0-9a-f]{64}$/.test(env.SIGNAL_ORDER_RECOVERY_SECRET || "") ? env.SIGNAL_ORDER_RECOVERY_SECRET : undefined,
    base, quantity, maxRisk: Number(risk),
    prefix: `${prefix}/${mode}`,
    apiKey: required("BINANCE_API_KEY", /^[A-Za-z0-9_-]{16,200}$/),
    apiSecret: required("BINANCE_API_SECRET", /^[A-Za-z0-9_-]{16,200}$/),
    signingSecret: required("SIGNAL_ORDER_SIGNING_SECRET", /^[A-Fa-f0-9]{64}$/).toLowerCase(),
    issuer: env.BINANCE_SYNC_ISSUER?.trim() || "https://www.yanxiao.me",
    audience: env.BINANCE_SYNC_AUDIENCE?.trim() || "binance-trade-sync",
  };
}

export function orderSubject(token: string, config: OrderConfig, scope: string, now: number, intent?: string) {
  const denied = () => new AppError("ORDER_UNAUTHORIZED", "请通过站点所有者会话获取订单凭证。", 401);
  try {
    const seconds = Math.floor(now / 1000);
    const c = gatewayClaims(token, seconds);
    if (c.iss !== config.issuer || c.aud !== config.audience || c.scope !== scope ||
      typeof c.iat !== "number" || !Number.isSafeInteger(c.iat) || c.exp <= c.iat || c.iat > seconds + 3 ||
      c.exp - c.iat > (scope === "trading:orders:submit-protected" ? 30 : 120) ||
      (intent !== undefined && c.intent !== intent)) throw denied();
    return c.sub;
  } catch { throw denied(); }
}
export function authorizeRecovery(input: Record<string, unknown>, config: OrderConfig, now: number) {
  const { triggerName, payload, triggerTime } = input;
  const time = typeof triggerTime === "string" ? Date.parse(triggerTime) : NaN;
  if (triggerName !== "market-order-protection" || !Number.isFinite(time) || time > now + 5000 || now - time > 180000 ||
    !config.recoverySecret || typeof payload !== "string" || !/^[0-9a-f]{64}$/.test(payload) ||
    !timingSafeEqual(Buffer.from(payload, "hex"), Buffer.from(config.recoverySecret, "hex"))) {
    throw new AppError("ORDER_RECOVERY_UNAUTHORIZED", "订单恢复定时事件未通过验证。", 401);
  }
}

function mac(config: OrderConfig, purpose: string, data: string) {
  return createHmac("sha256", Buffer.from(config.signingSecret, "hex")).update(`market-orders/v1/${config.mode}/${config.base}/${digest(config.apiKey)}/${purpose}/${data}`).digest();
}
export function seal(config: OrderConfig, purpose: string, value: unknown) {
  const data = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${data}.${mac(config, purpose, data).toString("base64url")}`;
}
export function unseal<T>(config: OrderConfig, purpose: string, token: unknown): T {
  if (typeof token === "string" && SEALED.test(token)) {
    const [data, signature] = token.split(".") as [string, string];
    const supplied = Buffer.from(signature, "base64url");
    if (timingSafeEqual(supplied, mac(config, purpose, data))) {
      return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
    }
  }
  throw new AppError("INVALID_ORDER_DRAFT", "订单草稿来源无效，请重新分析。", 400);
}
export interface OrderPlan {
  id: string; owner: string; status: "candidate" | "watch"; direction: "long" | "short";
  min: number; max: number; stop: number; target: number;
  mark: number; expiresAt: number;
}
export function makeOrderPermit(result: Awaited<ReturnType<typeof analyze>>, config: OrderConfig, owner: string, now: number) {
  const { direction, entry, stopLoss, targets } = result.opportunity;
  if (result.symbol !== "BTCUSDT" || (result.status !== "candidate" && result.status !== "watch") ||
    !direction || !entry || !stopLoss || !targets[0] || result.timing.validUntil <= now) return undefined;
  return seal(config, "research", {
    id: result.analysisId, owner: digest(owner), status: result.status, direction, min: entry.min, max: entry.max, stop: stopLoss,
    target: targets[0].price, mark: result.market.latestQuote.price, expiresAt: result.timing.validUntil,
  } satisfies OrderPlan);
}
