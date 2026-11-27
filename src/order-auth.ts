import { createHash, randomBytes } from "node:crypto";
import type { analyze } from "./analysis.js";
import { gatewayClaims } from "./auth.js";
import type { Env } from "./config.js";
import { AppError } from "./errors.js";
import { loadOssConfig } from "./oss-config.js";
import type { OrderStore } from "./order-oss.js";

export const ORDER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const ORDER_REFERENCE = /^[A-Za-z0-9_-]{1,1500}\.[A-Za-z0-9_-]{43}$/;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type OrderMode = "demo" | "live";
export interface OrderConfig extends ReturnType<typeof loadOssConfig> {
  mode: OrderMode;
  executionEnabled: boolean;
  base: string;
  apiKey: string;
  apiSecret: string;
  quantity: string;
  maxRisk: number;
  prefix: string;
  issuer: string;
  audience: string;
}
function configuredOrderBase(env: Env): string | undefined {
  const base = env.BINANCE_BASE_URL?.trim().replace(/\/$/, "");
  if (env.SIGNAL_ORDER_MODE === "live" && base === "https://fapi.binance.com" ||
    env.SIGNAL_ORDER_MODE === "demo" && (base === "https://demo-fapi.binance.com" || base === "https://testnet.binancefuture.com")) {
    return base;
  }
}

export function autoOrderBase(env: Env): string | undefined {
  if (env.SIGNAL_AUTO_ORDER_EXECUTE === "true" && env.SIGNAL_ORDER_EXECUTE === "true") return configuredOrderBase(env);
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
  const base = configuredOrderBase(env);
  if (!base) throw bad("BINANCE_BASE_URL");
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
    base, quantity, maxRisk: Number(risk),
    prefix: `${prefix}/${mode}`,
    apiKey: required("BINANCE_API_KEY", /^[A-Za-z0-9_-]{16,200}$/),
    apiSecret: required("BINANCE_API_SECRET", /^[A-Za-z0-9_-]{16,200}$/),
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
export function validateRecoveryTimer(input: Record<string, unknown>, now: number) {
  const { triggerName, triggerTime } = input;
  const time = typeof triggerTime === "string" ? Date.parse(triggerTime) : NaN;
  if (triggerName !== "market-order-protection" || !Number.isFinite(time) || time > now + 5000 || now - time > 180000) {
    throw new AppError("INVALID_ORDER_RECOVERY_TIMER", "订单保护定时事件的触发时间无效。", 400);
  }
}

type ReferenceKind = "research" | "submission";
function referencePath(config: OrderConfig, kind: ReferenceKind, token: string) {
  // "market" was the original storage path for all executable drafts.
  const namespace = kind === "submission" ? "market" : kind;
  return `temporary/${digest(`${config.base}/${config.apiKey}`)}/${namespace}/${digest(token)}.json`;
}
export async function storeOrderReference(store: OrderStore, config: OrderConfig, kind: ReferenceKind, value: unknown) {
  // Keep the public token format accepted by the website's ticket endpoint.
  const token = `v3.${randomBytes(32).toString("base64url")}`;
  if (!await store.create(referencePath(config, kind, token), value)) {
    throw new AppError("ORDER_STORAGE_UNAVAILABLE", "暂时无法保存订单草稿，请稍后再试。", 503);
  }
  return token;
}
export async function loadOrderReference<T extends object>(store: OrderStore, config: OrderConfig, kind: ReferenceKind, token: unknown): Promise<T> {
  if (typeof token === "string" && /^v3\.[A-Za-z0-9_-]{43}$/.test(token)) {
    const value = await store.read(referencePath(config, kind, token));
    if (object(value)) return value as T;
  }
  throw new AppError("INVALID_ORDER_DRAFT", "订单草稿来源无效，请重新分析。", 400);
}
export interface OrderPlan {
  id: string; owner: string; status: "candidate" | "watch"; direction: "long" | "short";
  min: number; max: number; stop: number; target: number;
  mark: number; expiresAt: number;
  decisionSource?: "deterministic";
}
export function makeOrderPermit(result: Awaited<ReturnType<typeof analyze>>, owner: string, now: number): OrderPlan | undefined {
  const { direction, entry, stopLoss, targets } = result.opportunity;
  if (result.symbol !== "BTCUSDT" || (result.status !== "candidate" && result.status !== "watch") ||
    !direction || !entry || !stopLoss || !targets[0] || result.timing.validUntil <= now) return undefined;
  return {
    id: result.analysisId, owner: digest(owner), status: result.status, direction, min: entry.min, max: entry.max, stop: stopLoss,
    target: targets[0].price, mark: result.market.latestQuote.price, expiresAt: result.timing.validUntil,
    ...(result.decisionSource ? { decisionSource: result.decisionSource } : {}),
  };
}
