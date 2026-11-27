import type { analyze } from "./analysis.js";
import type { Env } from "./config.js";
import { AppError, exceptionChain } from "./errors.js";
import { ORDER_ID } from "./order-auth.js";
import type { ExchangeOrder, PositionSide, ProtectionLeg } from "./order-binance.js";
import { makeOrderStore } from "./order-oss.js";
import { loadAnalysisArchiveConfig } from "./oss-config.js";
import type { Snapshot, TriggerInterval } from "./types.js";

const prefix = "records/trade-results/v1";
const schemaVersion = 1;
type Phase = "analysis" | "submission" | "recovery" | "closure" | "terminal";
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
      await store.create(`${prefix}/${path}`, { schemaVersion, recordType, analysisId, requestId, recordedAt: now(), ...fields });
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
      await write("decision", result.analysisId, `decisions/${result.analysisId}.json`, {
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
      await write("outcome", analysisId, `outcomes/${analysisId}/${phase}.json`, { phase, ...outcome });
    },
  };
}

export type TradeResultLog = ReturnType<typeof makeTradeResultLog>;

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
