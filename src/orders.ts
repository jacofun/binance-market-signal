import { AppError, exceptionChain } from "./errors.js";
import { ORDER_ID, SEALED, digest, object, orderSubject, unseal, type OrderConfig, type OrderPlan } from "./order-auth.js";
import { assertQuote, orderOption, type OrderKind } from "./order-rules.js";
import type { ExchangeOrder, OrderExchange } from "./order-binance.js";
import type { OrderStore } from "./order-oss.js";

interface Reservation { kind: OrderKind; clientId: string }
interface Outcome extends ExchangeOrder { checkedAt: number; reason?: string }

const protectionUnavailable = {
  state: "blocked",
  code: "ORDER_PROTECTION_UNAVAILABLE",
  reason: "币安 U 本位公开 API 暂无可同时提交开仓、止盈和止损的接口。当前仅可预览。",
} as const;
const symbol = "BTCUSDT";
const kinds: OrderKind[] = ["market", "limit", "conditional"];
const alreadySent = () => new AppError("ORDER_ALREADY_RESERVED", "本次研究已有提交记录，请查询订单。", 409);
const invalidRequest = () => new AppError("INVALID_ORDER_REQUEST", "订单请求参数无效。", 400);

export function makeOrders(config: OrderConfig, store: OrderStore, exchange: OrderExchange, now: () => number,
  report: (event: Record<string, unknown>) => void) {
  const path = (owner: string, id: string) => `attempts/${owner}/${id}`;
  async function status(owner: string, analysisId: string) {
    const key = path(owner, analysisId);
    const reservation = await store.read(`${key}/intent.json`) as Reservation | null;
    if (!reservation) return { state: "not_recorded", analysisId, mode: config.mode };
    const outcome = await store.read(`${key}/result.json`) as Outcome | null;
    const base = { mode: config.mode, analysisId, kind: reservation.kind, clientId: reservation.clientId };
    if (outcome?.state === "rejected") return { ...base, ...outcome };
    try {
      const live = await exchange.query(reservation.kind, reservation.clientId);
      return { ...base, ...live, checkedAt: now() };
    } catch (error) {
      report({ event: "order_lookup_failed", analysisId, clientId: reservation.clientId, error: exceptionChain(error),
        ...(error instanceof AppError ? error.upstream : {}) });
      return { ...base, ...(outcome ?? { state: "unknown" }), lookupUnavailable: true };
    }
  }
  async function preview(plan: OrderPlan) {
    if (plan.expiresAt <= now()) throw new AppError("ORDER_DRAFT_EXPIRED", "机会已过期，请重新分析。", 409);
    if (await store.read(`${path(plan.owner, plan.id)}/intent.json`)) throw alreadySent();
    const rules = await exchange.rules();
    const quote = await exchange.quote();
    assertQuote(plan, quote, now());
    const expiresAt = Math.min(plan.expiresAt, now() + 30000);
    const options = [];
    const unavailable: Record<string, string> = {};
    for (const kind of kinds) {
      const option = orderOption(kind, plan, quote, rules, config);
      if (typeof option === "string") unavailable[kind] = option;
      else options.push(option);
    }
    return { mode: config.mode, symbol, analysisId: plan.id, direction: plan.direction, quantity: config.quantity, stop: plan.stop,
      target: plan.target, riskCap: config.maxRisk, markPrice: quote.mark, expiresAt, options, unavailable, submission: protectionUnavailable };
  }
  return async (input: Record<string, unknown>, token: string) => {
    if (input.action === "status" && Object.keys(input).length === 2 && typeof input.analysisId === "string" && ORDER_ID.test(input.analysisId)) {
      const owner = digest(orderSubject(token, config, "trading:orders:read", now()));
      return status(owner, input.analysisId);
    }
    if (input.action === "preview" && Object.keys(input).length === 2) {
      const owner = digest(orderSubject(token, config, "trading:orders:read", now()));
      const plan = unseal<OrderPlan>(config, "research", input.permit);
      if (!object(plan) || plan.owner !== owner) throw invalidRequest();
      return preview(plan);
    }
    if (input.action === "submit" && Object.keys(input).length === 2 && typeof input.draft === "string" && SEALED.test(input.draft)) {
      // Cached clients may still hold a valid ticket from the previous version.
      // Stop before OSS writes or any request to the exchange.
      orderSubject(token, config, "trading:orders:submit", now(), digest(input.draft));
      throw new AppError(protectionUnavailable.code, protectionUnavailable.reason, 409);
    }
    throw invalidRequest();
  };
}
