import { AppError } from "./errors.js";
import type { OrderConfig, OrderPlan } from "./order-auth.js";

export type OrderKind = "market" | "limit" | "conditional";
export interface Quote {
  mark: string; markTime: number; bid: string; ask: string; bidQty: string; askQty: string; bookTime: number;
}
export interface Grid { min: string; max: string; step: string }
export interface TradingRules {
  kinds: string[]; times: string[]; price: Grid; lot: Grid; marketLot: Grid;
  notional: string; multiplierUp: string; multiplierDown: string;
}
export interface OrderOption {
  kind: OrderKind; price: string; triggerPrice?: string; risk: number; notional: number;
}
export const DECIMAL = /^\d{1,16}(?:\.\d{1,12})?$/;
// Normalize to exchange decimal units to keep filter checks exact.
function units(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(12, "0"));
}
function onGrid(value: string, limits: Grid) {
  const v = units(value), min = units(limits.min), max = units(limits.max), step = units(limits.step);
  return v > 0n && (min === 0n || v >= min) && (max === 0n || v <= max) && (step === 0n || v % step === 0n);
}
function priceText(value: number) {
  return String(value);
}
const allowedDrift = 30;
const drift = (price: number, reference: number) => Math.abs(price - reference) / reference * 10000;
export const TYPES: Record<OrderKind, string> = { market: "MARKET", limit: "LIMIT", conditional: "STOP" };

export function assertQuote(plan: OrderPlan, quote: Quote, now: number) {
  const mark = Number(quote.mark);
  const validRange = plan.direction === "long" ? mark > plan.stop && mark < plan.target : mark < plan.stop && mark > plan.target;
  if (plan.expiresAt <= now) throw new AppError("ORDER_DRAFT_EXPIRED", "机会已过期，请重新分析。", 409);
  if ([quote.markTime, quote.bookTime].some(time => time < now - 5000 || time > now + 2000) ||
    drift(mark, plan.mark) > allowedDrift || !validRange) {
    throw new AppError("ORDER_QUOTE_CHANGED", "盘口已偏离本次研究或报价不够新，请重新分析。", 409);
  }
}

export function orderOption(kind: OrderKind, plan: OrderPlan, quote: Quote, rules: TradingRules,
  config: OrderConfig, fixed?: OrderOption): OrderOption | string {
  const buy = plan.direction === "long";
  const mark = Number(quote.mark);
  const higher = Number(quote.ask);
  const lower = Number(quote.bid);
  const bound = buy ? plan.max : plan.min;
  const market = kind === "market";
  const conditional = kind === "conditional";
  if (market && plan.status !== "candidate") return "观望状态仅提供价格条件或回踩限价草稿。";
  const triggerPrice = conditional ? fixed?.triggerPrice ?? priceText(bound) : undefined;
  const price = market ? (buy ? quote.ask : quote.bid) :
    fixed?.price ?? priceText(conditional ? bound : buy ? plan.min : plan.max);
  const reference = Number(price);
  const quantity = Number(config.quantity);
  const risk = Math.abs(reference - plan.stop) * quantity;
  const notional = reference * quantity;
  if (!rules.kinds.includes(TYPES[kind]) || (!market && !rules.times.includes(conditional ? "GTC" : "GTX"))) return "交易所未开放此委托类型。";
  if (reference < plan.min || reference > plan.max || (market && (mark < plan.min || mark > plan.max))) return "预计入场价格须在研究入场区内。";
  if (market && (Number(buy ? quote.askQty : quote.bidQty) < quantity || (fixed && drift(reference, Number(fixed.price)) > allowedDrift))) {
    return "盘口深度不足或盘口价格已变化。";
  }
  if (kind === "limit" && (buy ? reference >= higher : reference <= lower)) return "限价已经跨过对手价，无法提交只挂单委托。";
  if (conditional && (triggerPrice !== price || (buy ? Number(triggerPrice) <= mark : Number(triggerPrice) >= mark))) return "标记价格已到达或越过条件触发价。";
  if (!onGrid(config.quantity, rules.lot) || (market && !onGrid(config.quantity, rules.marketLot)) || (!market && !onGrid(price, rules.price))) {
    return "数量或价格不符合交易所步长与上下限。";
  }
  if ((!market && (reference > mark * Number(rules.multiplierUp) || reference < mark * Number(rules.multiplierDown))) ||
    (market ? mark * quantity : notional) + 1e-9 < Number(rules.notional)) return "价格或名义金额不符合交易所过滤器。";
  if (risk > config.maxRisk + 1e-9) return "按研究失效价估算的价差风险超过配置上限。";
  return { kind, price, ...(triggerPrice ? { triggerPrice } : {}), risk, notional };
}
