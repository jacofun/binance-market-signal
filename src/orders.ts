import { randomUUID } from "node:crypto";
import { AppError, exceptionChain } from "./errors.js";
import { ORDER_ID, ORDER_REFERENCE, digest, loadOrderReference, orderSubject, storeOrderReference, type OrderConfig, type OrderPlan } from "./order-auth.js";
import { assertQuote, demoOrderPrices, orderOption, type OrderKind } from "./order-rules.js";
import type { ExchangeOrder, OrderExchange } from "./order-binance.js";
import type { OrderStore } from "./order-oss.js";
import { isProtectedIntent, makeProtectedExecution, pendingEntryMs, supportsExits, type ProtectedDraft } from "./order-execution.js";
import type { TradeResultLog } from "./trade-result-log.js";

interface Reservation { kind: OrderKind; clientId: string }
interface Outcome extends ExchangeOrder { checkedAt: number; reason?: string }

const symbol = "BTCUSDT";
const kinds: OrderKind[] = ["market", "limit", "conditional"];
const alreadySent = () => new AppError("ORDER_ALREADY_RESERVED", "本次研究已有提交记录，请查询订单。", 409);
const invalidRequest = () => new AppError("INVALID_ORDER_REQUEST", "订单请求参数无效。", 400);

export function makeOrders(config: OrderConfig, store: OrderStore, exchange: OrderExchange, now: () => number,
  report: (event: Record<string, unknown>) => void, tradeResults?: TradeResultLog) {
  const execution = makeProtectedExecution(config, store, exchange, now, report, tradeResults);
  const path = (owner: string, id: string) => `attempts/${owner}/${id}`;
  async function status(owner: string, analysisId: string) {
    const key = path(owner, analysisId);
    const value = await store.read(`${key}/intent.json`);
    if (isProtectedIntent(value)) return execution.inspect(value);
    const reservation = value as Reservation | null;
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
  async function preview(plan: OrderPlan, includePending: boolean) {
    if (plan.expiresAt <= now()) throw new AppError("ORDER_DRAFT_EXPIRED", "机会已过期，请重新分析。", 409);
    if (await store.read(`${path(plan.owner, plan.id)}/intent.json`)) throw alreadySent();
    const rules = await exchange.rules();
    const quote = await exchange.quote();
    assertQuote(plan, quote, now());
    const expiresAt = Math.min(plan.expiresAt, now() + 30000);
    const options: (Exclude<ReturnType<typeof orderOption>, string> & { draft?: string; entryWaitingSeconds?: number })[] = [];
    const unavailable: Record<string, string> = {};
    let executionAvailable: boolean | undefined;
    for (const kind of kinds) {
      const option = orderOption(kind, plan, quote, rules, config);
      if (typeof option === "string") unavailable[kind] = option;
      else if ((kind === "market" || includePending) &&
        (executionAvailable ??= supportsExits(rules) && await execution.ready())) {
        const draft = await storeOrderReference(store, config, "submission", { plan, option, quantity: config.quantity, expiresAt } satisfies ProtectedDraft);
        options.push({ ...option, draft, ...(kind === "market" ? {} : { entryWaitingSeconds: pendingEntryMs / 1000 }) });
      } else options.push(option);
    }
    const enabled = options.some(option => !!option.draft);
    return { mode: config.mode, symbol, analysisId: plan.id, direction: plan.direction, quantity: config.quantity, stop: plan.stop,
      target: plan.target, riskCap: config.maxRisk, markPrice: quote.mark, expiresAt, options, unavailable, submission: enabled ? { state: "enabled" as const } :
        { state: "blocked" as const, reason: executionAvailable === false
          ? "执行开关、保护恢复任务或交易所条件单尚未就绪，当前仅可预览。" : "本次研究暂无可提交的方案。" } };
  }
  return async (input: Record<string, unknown>, token: string) => {
    if (input.action === "demo-plan" && Object.keys(input).length === 2 && (input.direction === "long" || input.direction === "short")) {
      const owner = digest(orderSubject(token, config, "trading:orders:read", now()));
      if (config.mode !== "demo") throw new AppError("ORDER_DEMO_ONLY", "订单验证入口仅在 Binance Demo 测试网模式可用。", 409);
      const [rules, quote] = await Promise.all([exchange.rules(), exchange.quote()]);
      const direction = input.direction;
      const plan: OrderPlan = { id: randomUUID(), owner, status: "candidate", direction, expiresAt: now() + 60000,
        ...demoOrderPrices(direction, quote, rules, config) };
      assertQuote(plan, quote, now());
      const orderPermit = await storeOrderReference(store, config, "research", plan);
      report({ event: "order_demo_plan_created", analysisId: plan.id, direction });
      return { mode: config.mode, analysisId: plan.id, orderPermit, validUntil: plan.expiresAt };
    }
    if (input.action === "status" && Object.keys(input).length === 2 && typeof input.analysisId === "string" && ORDER_ID.test(input.analysisId)) {
      const owner = digest(orderSubject(token, config, "trading:orders:read", now()));
      return status(owner, input.analysisId);
    }
    if (input.action === "preview" && typeof input.permit === "string" &&
      Object.keys(input).every(key => key === "action" || key === "permit" || key === "includePending") &&
      (input.includePending === undefined || typeof input.includePending === "boolean")) {
      const owner = digest(orderSubject(token, config, "trading:orders:read", now()));
      const plan = await loadOrderReference<OrderPlan>(store, config, "research", input.permit);
      if (plan.owner !== owner) throw invalidRequest();
      return preview(plan, input.includePending === true);
    }
    if (input.action === "submit" && Object.keys(input).length === 2 && typeof input.draft === "string" && ORDER_REFERENCE.test(input.draft)) {
      const owner = digest(orderSubject(token, config, "trading:orders:submit-protected", now(), digest(input.draft)));
      const draft = await loadOrderReference<ProtectedDraft>(store, config, "submission", input.draft);
      if (draft.plan?.owner !== owner || !draft.option || !kinds.includes(draft.option.kind)) throw invalidRequest();
      return execution.submit(draft);
    }
    throw invalidRequest();
  };
}
