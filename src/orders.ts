import { AppError, exceptionChain } from "./errors.js";
import { ORDER_ID, SEALED, digest, object, orderSubject, seal, unseal, type OrderConfig, type OrderPlan } from "./order-auth.js";
import { assertQuote, orderOption, type OrderKind, type OrderOption } from "./order-rules.js";
import type { ExchangeOrder, OrderExchange, PositionSide, Side } from "./order-binance.js";
import type { OrderStore } from "./order-oss.js";

interface Draft { plan: OrderPlan; option: OrderOption; quantity: string; expiresAt: number }
interface Reservation {
  analysisId: string; owner: string; kind: OrderKind; side: Side; positionSide: PositionSide;
  quantity: string; clientId: string; price: string; triggerPrice?: string; submittedAt: number;
}
interface Outcome extends ExchangeOrder { checkedAt: number; reason?: string }
const LOCK = "locks/btcusdt.json";
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
      else options.push({ ...option, draft: seal(config, "submit", { plan, option, quantity: config.quantity, expiresAt } satisfies Draft) });
    }
    return { mode: config.mode, symbol, analysisId: plan.id, direction: plan.direction, quantity: config.quantity, stop: plan.stop,
      target: plan.target, riskCap: config.maxRisk, markPrice: quote.mark, expiresAt, options, unavailable };
  }
  async function submit(draft: Draft) {
    const { plan, option, quantity } = draft;
    if (draft.expiresAt <= now() || plan.expiresAt <= now() || quantity !== config.quantity) {
      throw new AppError("ORDER_DRAFT_EXPIRED", "订单报价过期或数量设置已调整，请刷新草稿。", 409);
    }
    const key = path(plan.owner, plan.id);
    if (await store.read(`${key}/intent.json`)) throw alreadySent();
    await store.assertAtomicWrites();
    const clientId = `ms-${digest(`${config.mode}/${plan.owner}/${plan.id}`).slice(0, 32)}`;
    if (!await store.create(LOCK, { analysisId: plan.id, owner: plan.owner, clientId, createdAt: now() })) {
      throw new AppError("ORDER_SUBMISSION_LOCKED", "BTCUSDT 还有一笔提交处理中或结果待核对，请先查单。", 409);
    }
    let release = true;
    try {
      const side = plan.direction === "long" ? "BUY" : "SELL";
      const [rules, positionSide] = await Promise.all([exchange.rules(), exchange.account(side)]);
      const quote = await exchange.quote();
      assertQuote(plan, quote, now());
      const checked = orderOption(option.kind, plan, quote, rules, config, option);
      if (typeof checked === "string") throw new AppError("ORDER_RULE_CHANGED", checked, 409);
      if (draft.expiresAt <= now()) throw new AppError("ORDER_DRAFT_EXPIRED", "下单前校验超过报价有效期，请刷新草稿。", 409);
      const record: Reservation = { analysisId: plan.id, owner: plan.owner, kind: option.kind, side, positionSide,
        quantity, clientId, price: checked.price, ...(checked.triggerPrice ? { triggerPrice: checked.triggerPrice } : {}),
        submittedAt: now() };
      // A recorded intent is never submitted a second time, including after
      // timeouts, crashes and a lost response from OSS or the exchange.
      release = false;
      if (!await store.create(`${key}/intent.json`, record)) { release = true; throw alreadySent(); }
      let outcome: Outcome;
      try {
        assertQuote(plan, quote, now());
        if (draft.expiresAt <= now()) throw new AppError("ORDER_DRAFT_EXPIRED", "草稿在发送前已过期。", 409);
      } catch (error) {
        outcome = { state: "rejected", checkedAt: now(), reason: (error as AppError).code };
      }
      // Do not tie exchange submission or persistence to the browser connection.
      outcome ??= { ...await exchange.place(checked, side, positionSide, clientId), checkedAt: now() };
      try {
        if (!await store.create(`${key}/result.json`, outcome)) throw new Error("Order result already exists");
        release = outcome.state !== "unknown";
      } catch (error) {
        report({ event: "order_outcome_write_failed", analysisId: plan.id, clientId, error: exceptionChain(error),
          ...(error instanceof AppError ? error.upstream : {}) });
      }
      report({ event: "order_submission_outcome", analysisId: plan.id, clientId, kind: option.kind, mode: config.mode,
        state: outcome.state, upstreamStatus: outcome.upstreamStatus, exchangeStatus: outcome.exchangeStatus, exchangeCode: outcome.exchangeCode, reason: outcome.reason });
      return { analysisId: plan.id, mode: config.mode, kind: option.kind, clientId, ...outcome, ...(release ? {} : { reconciliationRequired: true }) };
    } finally {
      if (release) {
        try { await store.removeLock(LOCK); }
        catch (error) { report({ event: "order_lock_release_failed", analysisId: plan.id, clientId, error: exceptionChain(error),
          ...(error instanceof AppError ? error.upstream : {}) }); }
      }
    }
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
      const owner = digest(orderSubject(token, config, "trading:orders:submit", now(), digest(input.draft)));
      const draft = unseal<Draft>(config, "submit", input.draft);
      if (!object(draft) || draft.plan?.owner !== owner) throw invalidRequest();
      return submit(draft);
    }
    throw invalidRequest();
  };
}
