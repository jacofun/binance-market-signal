import { AppError, exceptionChain } from "./errors.js";
import { digest, object, ORDER_ID, type OrderConfig, type OrderPlan } from "./order-auth.js";
import type { ExchangeOrder, OrderExchange, PositionSide, ProtectionLeg } from "./order-binance.js";
import { assertQuote, DECIMAL, orderOption, type OrderOption, type TradingRules } from "./order-rules.js";
import type { OrderStore } from "./order-oss.js";

const activePath = "locks/btcusdt.json";
const heartbeatPath = "protection/heartbeat.json";
const legs = ["stop", "target"] as const;
const maxProtectionAttempts = 4;
const retryMs = 10000;
const recoverySlotMs = 60000;
const terminalEntry = new Set(["FILLED", "CANCELED", "EXPIRED", "REJECTED", "EXPIRED_IN_MATCH"]);
const terminalProtection = new Set(["FINISHED", "CANCELED", "CANCELLED", "EXPIRED", "REJECTED"]);
type ProtectionState = "pending" | "active" | "attention" | "closed" | "not_required";

export interface ProtectedDraft {
  plan: OrderPlan; option: OrderOption; quantity: string; expiresAt: number;
}
interface Intent {
  version: 2; analysisId: string; owner: string; kind: "market"; clientId: string;
  apiKeyHash: string; side: PositionSide; quantity: string; stop: string; target: string; openingUntil: number;
}
const orderPath = (owner: string, id: string) => `attempts/${owner}/${id}`;
const detailedError = (error: unknown) => ({
  error: exceptionChain(error), ...(error instanceof AppError ? error.upstream : {}),
});
export const supportsExits = (rules: TradingRules) => ["STOP_MARKET", "TAKE_PROFIT_MARKET"].every(kind => rules.kinds.includes(kind));

export function isProtectedIntent(value: unknown): value is Intent {
  return object(value) && value.version === 2 && typeof value.analysisId === "string" && ORDER_ID.test(value.analysisId) &&
    typeof value.owner === "string" && /^[a-f0-9]{64}$/.test(value.owner) && value.kind === "market" &&
    typeof value.clientId === "string" && /^ms[e][a-f0-9]{30}$/.test(value.clientId) &&
    typeof value.apiKeyHash === "string" && /^[a-f0-9]{64}$/.test(value.apiKeyHash) &&
    (value.side === "LONG" || value.side === "SHORT") && [value.quantity, value.stop, value.target].every(
      field => typeof field === "string" && DECIMAL.test(field) && Number(field) > 0) && Number.isSafeInteger(value.openingUntil);
}
const hasFinalFill = (entry: ExchangeOrder) => terminalEntry.has(entry.exchangeStatus ?? "") && entry.executedQty !== undefined;
const legId = (intent: Intent, leg: ProtectionLeg) => `ms${leg === "stop" ? "s" : "t"}${intent.clientId.slice(3)}`;

export function makeProtectedExecution(config: OrderConfig, store: OrderStore, exchange: OrderExchange, now: () => number,
  report: (event: Record<string, unknown>) => void) {
  const credentials = digest(config.apiKey);
  const path = (intent: Intent) => orderPath(intent.owner, intent.analysisId);
  const context = (intent: Intent) => ({ analysisId: intent.analysisId, clientId: intent.clientId });
  const knownOrder = (intent: Intent) => store.read(`${path(intent)}/entry.json`) as Promise<ExchangeOrder | null>;
  const protectedStatus = (intent: Intent, state: ProtectionState, stopStatus?: string | null, targetStatus?: string | null) => ({
    state,
    stop: { price: intent.stop, clientId: legId(intent, "stop"), exchangeStatus: stopStatus ?? null },
    target: { price: intent.target, clientId: legId(intent, "target"), exchangeStatus: targetStatus ?? null },
  });
  const result = (intent: Intent, protection: ReturnType<typeof protectedStatus>, entry?: ExchangeOrder | null) => ({
    mode: config.mode, ...context(intent), kind: intent.kind, ...(entry ?? { state: "unknown" as const }), protection,
  });
  async function rememberEntry(intent: Intent, entry: ExchangeOrder) {
    if (!hasFinalFill(entry) && entry.state !== "rejected") return;
    try { await store.create(`${path(intent)}/entry.json`, entry); }
    catch (error) { report({ event: "order_entry_receipt_write_failed", ...context(intent), ...detailedError(error) }); }
  }
  async function ready() {
    if (!config.executionEnabled) return false;
    const pulse = await store.read(heartbeatPath);
    return object(pulse) && pulse.apiKeyHash === credentials && Number.isSafeInteger(pulse.at) &&
      Number(pulse.at) <= now() + 3000 && now() - Number(pulse.at) <= 90000;
  }
  async function release(intent: Intent, state: "closed" | "not_required") {
    // Only the process that creates the terminal marker may delete the global lock.
    if (await store.create(`${path(intent)}/closed.json`, { state, at: now() })) await store.removeLock(activePath);
  }
  async function findLeg(intent: Intent, leg: ProtectionLeg) {
    return exchange.findProtection(intent.side, leg, intent[leg], legId(intent, leg));
  }
  async function ensureLeg(intent: Intent, leg: ProtectionLeg, until: number) {
    const current = await findLeg(intent, leg);
    if (current) return current;
    for (let attempt = 0; attempt < maxProtectionAttempts; attempt++) {
      const claimPath = `${path(intent)}/${leg}-${attempt}.json`;
      const claim = await store.read(claimPath);
      if (object(claim) && Number.isSafeInteger(claim.at)) {
        if (now() - Number(claim.at) < retryMs) return null;
        continue;
      }
      if (claim !== null) throw new AppError("ORDER_RECOVERY_STATE", "保护单恢复记录格式无效。", 503);
      // Capture a timestamp before writing the claim. Binance's short recvWindow
      // fences old workers that resume after a newer recovery attempt has started.
      if (now() + 3500 >= until) return null;
      if (attempt > 0) {
        const existing = await findLeg(intent, leg);
        if (existing) return existing;
      }
      const at = now();
      if (at + 3500 >= until || !await store.create(claimPath, { at })) return null;
      if (now() - at >= 3000 || now() + 3500 >= until) return null;
      return exchange.protect(intent.side, leg, intent[leg], legId(intent, leg), at);
    }
    report({ event: "order_protection_attempts_exhausted", ...context(intent), leg });
    return null;
  }
  async function settle(intent: Intent, entry: ExchangeOrder, openedInRequest: boolean, until: number) {
    const terminal = hasFinalFill(entry);
    if (entry.state === "rejected" || (terminal && Number(entry.executedQty) === 0)) {
      await release(intent, "not_required");
      return result(intent, protectedStatus(intent, "not_required"), entry);
    }
    if (!Number(entry.executedQty)) return result(intent, protectedStatus(intent, "pending"), entry);
    if (Number(entry.executedQty) > Number(intent.quantity)) {
      throw new AppError("ORDER_POSITION_MISMATCH", "币安回报的 BTCUSDT 成交量超出本次开仓计划。", 409);
    }
    const maxQty = entry.executedQty!;
    if (!openedInRequest && await exchange.position(intent.side, maxQty) === 0) {
      if (!terminal) return result(intent, protectedStatus(intent, "pending"), entry);
      // Do not cancel a sibling while a closing order is triggering, or while
      // the opening request could still be completing on another instance.
      const found = await Promise.all(legs.map(leg => findLeg(intent, leg)));
      if (!found.includes("FINISHED")) {
        const slot = Math.floor(now() / recoverySlotMs);
        if (!await store.read(`${path(intent)}/flat-${slot - 1}.json`)) {
          await store.create(`${path(intent)}/flat-${slot}.json`, { at: now() });
          return result(intent, protectedStatus(intent, "attention", found[0], found[1]), entry);
        }
      }
      if (found.some(status => status !== null && status !== "NEW" && !terminalProtection.has(status))) {
        return result(intent, protectedStatus(intent, "attention", found[0], found[1]), entry);
      }
      if (now() + 3500 >= until) return result(intent, protectedStatus(intent, "attention"), entry);
      await Promise.all(legs.filter((_, index) => found[index] === "NEW").map(leg => exchange.cancelProtection(legId(intent, leg))));
      const remaining = await Promise.all(legs.map(leg => findLeg(intent, leg)));
      if (remaining.some(status => status !== null && !terminalProtection.has(status))) {
        return result(intent, protectedStatus(intent, "attention", remaining[0], remaining[1]), entry);
      }
      await release(intent, "closed");
      return result(intent, protectedStatus(intent, "closed", remaining[0], remaining[1]), entry);
    }
    let stop: string | null = null;
    let target: string | null = null;
    try {
      stop = await ensureLeg(intent, "stop", until);
      if (stop === "NEW") target = await ensureLeg(intent, "target", until);
    } catch (error) {
      report({ event: "order_protection_incomplete", ...context(intent), leg: stop === "NEW" ? "target" : "stop", ...detailedError(error) });
    }
    const state = stop === "NEW" && target === "NEW" ? "active" : "attention";
    if (state === "attention") report({ event: "order_protection_requires_attention", ...context(intent), stop, target });
    return result(intent, protectedStatus(intent, state, stop, target), entry);
  }
  return {
    ready,
    async submit(draft: ProtectedDraft) {
      if (!await ready()) throw new AppError("ORDER_RECOVERY_NOT_READY", "订单保护恢复任务未就绪，暂时禁止开仓。", 503);
      const { plan, quantity } = draft;
      if (quantity !== config.quantity || draft.expiresAt <= now()) {
        throw new AppError("ORDER_DRAFT_EXPIRED", "草稿报价已失效，请刷新。", 409);
      }
      if (await store.read(`${orderPath(plan.owner, plan.id)}/intent.json`)) {
        throw new AppError("ORDER_ALREADY_RESERVED", "本次研究已有委托记录，请查单。", 409);
      }
      const [rules] = await Promise.all([exchange.rules(), exchange.assertFlat(), store.assertAtomicWrites()]);
      const quote = await exchange.quote();
      assertQuote(plan, quote, now());
      const option = orderOption("market", plan, quote, rules, config);
      if (!supportsExits(rules) || typeof option === "string" ||
        option.stopLossPrice !== draft.option.stopLossPrice || option.takeProfitPrice !== draft.option.takeProfitPrice) {
        throw new AppError("ORDER_RULE_CHANGED", typeof option === "string" ? option : "止盈或止损未通过复核。", 409);
      }
      if (Math.abs(Number(option.price) - Number(draft.option.price)) / Number(draft.option.price) > 0.003) {
        throw new AppError("ORDER_QUOTE_CHANGED", "盘口相较确认草稿变化过大，请刷新。", 409);
      }
      const intent: Intent = { version: 2, analysisId: plan.id, owner: plan.owner, kind: "market",
        clientId: `mse${digest(`${config.mode}/${plan.owner}/${plan.id}`).slice(0, 30)}`,
        apiKeyHash: credentials, side: plan.direction === "long" ? "LONG" : "SHORT", quantity,
        stop: option.stopLossPrice, target: option.takeProfitPrice,
        openingUntil: Math.min(draft.expiresAt, plan.expiresAt, now() + 15000) };
      if (intent.openingUntil - now() <= 3000) throw new AppError("ORDER_DRAFT_EXPIRED", "草稿剩余时间不足，请刷新。", 409);
      if (!await store.create(activePath, intent)) {
        throw new AppError("ORDER_SUBMISSION_LOCKED", "已有 BTCUSDT 委托正在处理或持仓尚未结束。", 409);
      }
      if (!await store.create(`${path(intent)}/intent.json`, intent)) {
        // This invocation owns the new lock and has not sent anything. A
        // conflict here means a previous attempt completed during preflight.
        await store.removeLock(activePath);
        throw new AppError("ORDER_ALREADY_RESERVED", "本次研究已有委托记录，请查单。", 409);
      }
      const issuedAt = now();
      let entry: ExchangeOrder;
      if (issuedAt + 3000 >= intent.openingUntil || issuedAt - Math.min(quote.bookTime, quote.markTime) > 5000) {
        entry = { state: "rejected", reason: "ORDER_DRAFT_EXPIRED" };
      } else {
        try { entry = await exchange.enter(intent.side, quantity, intent.clientId, issuedAt); }
        catch (error) {
          report({ event: "order_entry_unknown", ...context(intent), ...detailedError(error) });
          return result(intent, protectedStatus(intent, "pending"));
        }
      }
      // The recovery task can query a filled order using its persisted client ID.
      // Give the stop request priority over persisting any post-trade receipt.
      if (entry.state === "rejected") await rememberEntry(intent, entry);
      const outcome = await settle(intent, entry, true, intent.openingUntil + retryMs);
      if (entry.state !== "rejected") await rememberEntry(intent, entry);
      report({ event: "order_execution_completed", ...context(intent), entry: entry.state,
        executedQty: entry.executedQty, protection: outcome.protection.state });
      return outcome;
    },
    async inspect(intent: Intent) {
      const closed = await store.read(`${path(intent)}/closed.json`);
      const cached = await knownOrder(intent);
      if (cached?.state === "rejected") return result(intent, protectedStatus(intent, "not_required"), cached);
      const finalState = object(closed) && (closed.state === "closed" || closed.state === "not_required") ? closed.state : undefined;
      if (finalState && cached) return result(intent, protectedStatus(intent, finalState), cached);
      if (intent.apiKeyHash !== credentials) return { ...result(intent, protectedStatus(intent, "attention")), lookupUnavailable: true };
      try {
        const [entry, stop, target] = await Promise.all([exchange.findEntry(intent.clientId), findLeg(intent, "stop"), findLeg(intent, "target")]);
        const state = finalState ?? (stop === "NEW" && target === "NEW" ? "active" : Number(entry?.executedQty) > 0 ? "attention" : "pending");
        return result(intent, protectedStatus(intent, state, stop, target), entry ?? cached);
      } catch (error) {
        report({ event: "order_protection_lookup_failed", ...context(intent), ...detailedError(error) });
        return { ...result(intent, protectedStatus(intent, finalState ?? "attention"), cached), lookupUnavailable: true };
      }
    },
    async recover() {
      // Keep recovering outstanding obligations even when new entries are disabled.
      await store.assertAtomicWrites();
      const intent = await store.read(activePath);
      if (intent !== null && (!isProtectedIntent(intent) || intent.apiKeyHash !== credentials)) {
        throw new AppError("ORDER_RECOVERY_STATE", "存在旧版或与当前交易密钥不匹配的活跃委托。", 409);
      }
      if (intent !== null && await store.read(`${path(intent)}/closed.json`)) {
        throw new AppError("ORDER_RECOVERY_RELEASE", "上次交易已结束但 OSS 锁仍存在，请核对后清理。", 409);
      }
      if (intent === null || now() < intent.openingUntil + retryMs) {
        await store.write(heartbeatPath, { at: now(), apiKeyHash: credentials });
        return { recovered: false };
      }
      const slot = Math.floor(now() / recoverySlotMs);
      const until = (slot + 1) * recoverySlotMs;
      if (until - now() < 25000 || !await store.create(`${path(intent)}/recover-${slot}.json`, { at: now() })) {
        return { recovered: false, ...context(intent), reason: "recovery_slot_busy" };
      }
      const reserved = await store.read(`${path(intent)}/intent.json`);
      if (reserved === null) {
        await release(intent, "not_required");
        return { recovered: true, ...context(intent), reason: "entry_never_reserved" };
      }
      if (!isProtectedIntent(reserved) || (Object.keys(intent) as (keyof Intent)[]).some(key => intent[key] !== reserved[key])) {
        throw new AppError("ORDER_RECOVERY_STATE", "恢复队列与确认的订单计划不一致。", 409);
      }
      const cached = await knownOrder(intent);
      const entry = cached ?? await exchange.findEntry(intent.clientId);
      if (!entry) {
        report({ event: "order_entry_unresolved", ...context(intent) });
        return { recovered: false, ...context(intent), reason: "entry_unknown" };
      }
      const outcome = await settle(intent, entry, false, until);
      if (!cached) await rememberEntry(intent, entry);
      await store.write(heartbeatPath, { at: now(), apiKeyHash: credentials });
      return { recovered: true, ...outcome };
    },
  };
}
