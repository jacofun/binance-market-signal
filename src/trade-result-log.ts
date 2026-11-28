import type { analyze } from "./analysis.js";
import type { Env } from "./config.js";
import { AppError, exceptionChain } from "./errors.js";
import { object, ORDER_ID } from "./order-auth.js";
import type { ExchangeOrder, PositionSide, ProtectionLeg } from "./order-binance.js";
import { makeOrderStore, type OrderStore } from "./order-oss.js";
import { loadAnalysisArchiveConfig } from "./oss-config.js";
import type { Snapshot, TriggerInterval } from "./types.js";

export const tradeResultPrefix = "records/trade-results/v1";
export const tradeDecisionPath = (analysisId: string) => `${tradeResultPrefix}/decisions/${analysisId}.json`;
const schemaVersion = 1;
type Phase = "analysis" | "entry-wait" | "submission" | "recovery" | "closure" | "terminal";
export type TradeFinalStatus = "win" | "loss" | "breakeven" | "expired" | "cancelled" | "not_executed";
type Analysis = Awaited<ReturnType<typeof analyze>>;
type DecisionContext = { source: "manual"; orderPermitIssued: boolean } | {
  source: "automatic"; scanId: string; candleClosedAt: number; candleInterval: TriggerInterval;
  slot: "reserved" | "no_trigger" | "daily_limit";
  marketMode: "demo" | "live";
};
interface Outcome {
  finalStatus: TradeFinalStatus | null;
  reason?: string;
  message?: string;
  waitUntil?: number;
  exchangeCode?: number;
  execution?: {
    mode: "demo" | "live"; clientId: string; requestedQty: string; entryState: ExchangeOrder["state"];
    orderKind: "market" | "limit" | "conditional"; positionSide: PositionSide; stopLossPrice: string; takeProfitPrice: string;
    submission?: { issuedAt: number; referencePrice: string; timeInForce?: "IOC"; triggerPrice?: string };
    exchangeStatus?: string; childStatus?: string; exchangeCode?: number; executedQty?: string; avgEntryPrice?: string;
    entryUpdatedAt?: number; protection: string; stopStatus: string | null; targetStatus: string | null;
  };
  exits?: { leg: ProtectionLeg; orderId?: string; quantity: string; averagePrice: string; updatedAt?: number }[];
  grossRealizedPnlUsdt?: number;
  rMultiple?: number;
  exitPrice?: number;
  exitTime?: number;
  holdingDurationMs?: number;
}

export function makeTradeResultLog(env: Env, now: () => number, request: typeof fetch, requestId: string,
  report: (event: Record<string, unknown>) => void) {
  async function write(recordType: "decision" | "outcome", analysisId: string, path: string, fields: object) {
    try {
      const store = makeOrderStore(loadAnalysisArchiveConfig(env), now, request, "SCAN");
      await store.create(path, { schemaVersion, recordType, analysisId, requestId, recordedAt: now(), ...fields });
    } catch (error) {
      report({ event: "trade_result_log_failed", recordType, analysisId, requestId,
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
        configurationField: error instanceof AppError ? error.configurationField : undefined,
        ...(error instanceof AppError ? error.upstream : {}), exception: exceptionChain(error) });
    }
  }
  return {
    async logDecision(result: Analysis, snapshot: Snapshot, context: DecisionContext) {
      if (result.decisionSource !== "deterministic" || !result.m1Trigger) return;
      await write("decision", result.analysisId, tradeDecisionPath(result.analysisId), {
        ...context, symbol: result.symbol, style: result.style, asOf: snapshot.asOf,
        decidedAt: result.timing.completedAt, validUntil: result.timing.validUntil,
        codeVersion: result.codeVersion, deterministicVersion: result.model.promptVersion,
        decisionSource: result.decisionSource, m1: result.m1Trigger, m2: result.m2Order ?? null,
        status: result.status, decision: result.decision, opportunity: result.opportunity, snapshot,
        latestQuote: result.market.latestQuote, priceDriftBps: result.market.priceDriftBps,
      });
    },
    async logOutcome(analysisId: string, phase: Phase, outcome: Outcome) {
      if (!ORDER_ID.test(analysisId)) return;
      await write("outcome", analysisId, `${tradeResultPrefix}/outcomes/${analysisId}/${phase}.json`, { phase, ...outcome });
    },
  };
}

export type TradeResultLog = ReturnType<typeof makeTradeResultLog>;

export async function readAutomaticExecution(store: Pick<OrderStore, "read">, analysisId: string) {
  // Prefer a resolved or recovered outcome over the initial IOC submission.
  const phases = ["terminal", "closure", "recovery", "submission", "analysis"] as const;
  const reads = await Promise.allSettled(phases.map(phase => store.read(`${tradeResultPrefix}/outcomes/${analysisId}/${phase}.json`, 8192)));
  const record = reads.flatMap((read, i) => {
    const value = read.status === "fulfilled" && read.value;
    return object(value) && value.schemaVersion === schemaVersion && value.recordType === "outcome" &&
      value.analysisId === analysisId && value.phase === phases[i] ? [value] : [];
  })[0];
  if (!record) return { state: "unavailable" as const };
  const execution = object(record.execution) ? record.execution : {};
  const text = (value: unknown, format: RegExp) => typeof value === "string" && format.test(value) ? value : undefined;
  const executedQty = text(execution.executedQty, /^\d{1,16}(?:\.\d{1,12})?$/);
  const requestedQty = text(execution.requestedQty, /^\d{1,16}(?:\.\d{1,12})?$/);
  const exchangeStatus = text(execution.childStatus ?? execution.exchangeStatus, /^[A-Z_]{2,32}$/);
  const upstreamCode = execution.exchangeCode ?? record.exchangeCode;
  const exchangeCode = typeof upstreamCode === "number" && Number.isSafeInteger(upstreamCode) && upstreamCode < 0 ? upstreamCode : undefined;
  const reasonCode = text(record.reason, /^[a-zA-Z_]{1,80}$/);
  const clientId = text(execution.clientId, /^mse[a-f0-9]{30}$/);
  const protection = text(execution.protection, /^(pending|active|attention|closed|not_required)$/);
  const message = typeof record.message === "string" && record.message.length <= 240 ? record.message : undefined;
  let state = "unknown";
  if (Number(executedQty) > 0) state = Number(executedQty) < Number(requestedQty) ? "partially_filled" : "filled";
  else if (execution.entryState === "rejected") state = clientId && exchangeCode !== undefined ? "rejected" : "blocked";
  else if (executedQty !== undefined && (record.finalStatus === "expired" || record.finalStatus === "cancelled")) state = "unfilled";
  else if (reasonCode === "entry_never_reserved" || record.phase === "analysis" &&
    (record.finalStatus === "not_executed" || record.finalStatus === "expired")) state = "blocked";
  return { state, reasonCode, message, clientId, exchangeStatus, executedQty, requestedQty, protection, exchangeCode };
}

export function closedTradeOutcome(entry: ExchangeOrder,
  exits: { leg: ProtectionLeg; order: ExchangeOrder }[], side: PositionSide, stop: string): Outcome {
  const unresolved: Outcome = { finalStatus: null, reason: "exit_fills_unverified" };
  const entryQty = Number(entry.executedQty);
  const entryPrice = Number(entry.avgPrice);
  if (!(entryQty > 0 && entryPrice > 0) || !exits.length) return unresolved;
  let totalQty = 0;
  let totalValue = 0;
  for (const { order } of exits) {
    const qty = Number(order.executedQty);
    const price = Number(order.avgPrice);
    if (order.childStatus !== "FILLED" || !(qty > 0 && price > 0)) return unresolved;
    totalQty += qty;
    totalValue += price * qty;
  }
  if (Math.abs(totalQty - entryQty) > 1e-10) return unresolved;
  const exitPrice = totalValue / totalQty;
  const signedMove = (exitPrice - entryPrice) * (side === "LONG" ? 1 : -1);
  const grossRealizedPnlUsdt = Number((signedMove * entryQty).toFixed(8)) || 0;
  const risk = Math.abs(entryPrice - Number(stop));
  const exitTime = exits.every(({ order }) => order.updatedAt !== undefined) ? Math.max(...exits.map(({ order }) => order.updatedAt!)) : undefined;
  const entryTime = (entry.childStatus ?? entry.exchangeStatus) === "FILLED" ? entry.updatedAt : undefined;
  return {
    finalStatus: grossRealizedPnlUsdt > 0 ? "win" : grossRealizedPnlUsdt < 0 ? "loss" : "breakeven",
    grossRealizedPnlUsdt, ...(risk > 0 ? { rMultiple: signedMove / risk } : {}), exitPrice, exitTime,
    ...(entryTime !== undefined && exitTime !== undefined && exitTime >= entryTime ? { holdingDurationMs: exitTime - entryTime } : {}),
    exits: exits.map(({ leg, order }) => ({ leg, orderId: order.childOrderId, quantity: order.executedQty!,
      averagePrice: order.avgPrice!, updatedAt: order.updatedAt })),
  };
}
