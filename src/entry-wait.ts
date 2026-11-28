import { createHmac } from "node:crypto";
import type { analyze } from "./analysis.js";
import { loadConfig, type Env } from "./config.js";
import { AppError, publicError } from "./errors.js";
import { limited } from "./http.js";
import { closedCandleBoundary, INTERVAL_MS, RestMarketDataProvider } from "./market.js";
import { minimumM2RewardToRisk } from "./m2-order.js";
import { evaluateProposal } from "./model.js";
import { autoOrderBase, digest, loadOrderConfig, object, ORDER_ID } from "./order-auth.js";
import { makeOrderExchange } from "./order-binance.js";
import { makeProtectedExecution } from "./order-execution.js";
import { makeOrderStore } from "./order-oss.js";
import { loadAnalysisArchiveConfig } from "./oss-config.js";
import { readAutomaticExecution, type TradeResultLog } from "./trade-result-log.js";
import type { Proposal } from "./types.js";

export const ENTRY_RECHECK_TRIGGER = "market-entry-recheck";
const symbol = "BTCUSDT";
const production = "https://fapi.binance.com";
const waitMs = 15 * INTERVAL_MS["1m"];
const scanMs = INTERVAL_MS["5m"];
type Store = ReturnType<typeof makeOrderStore>;
type Analysis = Awaited<ReturnType<typeof analyze>>;
type Wait = { analysisId: string; candleClosedAt: number; createdAt: number; waitUntil: number; base: string;
  account?: string; proposal: Proposal & { entry: NonNullable<Proposal["entry"]>; stopLoss: number; direction: "long" | "short" } };
type FinishReason = "target_touched" | "stop_touched" | "stop_or_target_touched" | "wait_expired" | "structure_invalid" | "execution_disabled";
const prefix = "records/entry-waits/v1";
const jobPath = (candle: number) => `${prefix}/jobs/${candle}.json`;
const outcomePath = (id: string) => `${prefix}/resolutions/${id}.json`;
const failurePath = (id: string) => `${prefix}/failures/${id}.json`;
const makeStore = (env: Env, now: () => number, request: typeof fetch) => makeOrderStore(loadAnalysisArchiveConfig(env), now, request, "SCAN");
const accountBinding = (env: Env) => createHmac("sha256", loadAnalysisArchiveConfig(env).ossSecret)
  .update(env.BINANCE_API_KEY?.trim() ?? "").digest("hex");

export function validateEntryRecheckTimer(input: Record<string, unknown>, now: number) {
  const at = typeof input.triggerTime === "string" ? Date.parse(input.triggerTime) : NaN;
  if (input.triggerName !== ENTRY_RECHECK_TRIGGER || !Number.isFinite(at) || at <= 0 || at > now + 5000 || now - at >= INTERVAL_MS["1m"]) {
    throw new AppError("INVALID_ENTRY_RECHECK_TIMER", "入场复查定时事件已过时或触发时间无效。");
  }
}

async function readWait(store: Store, candle: number): Promise<Wait | null> {
  const value = await store.read(jobPath(candle), 16 * 1024);
  if (value === null) return null;
  if (!object(value) || value.schemaVersion !== 1 || typeof value.analysisId !== "string" || !ORDER_ID.test(value.analysisId) ||
    value.candleClosedAt !== candle || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < candle || value.createdAt - candle >= scanMs || value.waitUntil !== value.createdAt + waitMs ||
    typeof value.base !== "string" || ![production, "https://demo-fapi.binance.com", "https://testnet.binancefuture.com"].includes(value.base) ||
    !object(value.proposal) || !object(value.proposal.entry) || !object(value.proposal.research) ||
    (value.proposal.direction !== "long" && value.proposal.direction !== "short") ||
    typeof value.proposal.research.entryZoneId !== "string" || typeof value.proposal.research.stopZoneId !== "string" ||
    !Array.isArray(value.proposal.targets) || !object(value.proposal.targets[0]) ||
    ![value.proposal.entry.min, value.proposal.entry.max, value.proposal.stopLoss, value.proposal.targets[0].price]
      .every(x => typeof x === "number" && Number.isFinite(x) && x > 0)) {
    throw new AppError("ENTRY_WAIT_RECORD_INVALID", "等待入场记录无效。", 503);
  }
  const wait = value as unknown as Wait;
  const { entry, stopLoss, direction, targets } = wait.proposal;
  const target = targets[0]!.price;
  if (entry.min > entry.max || (direction === "long" ? stopLoss >= entry.min || target <= entry.max :
    target >= entry.min || stopLoss <= entry.max)) {
    throw new AppError("ENTRY_WAIT_RECORD_INVALID", "等待入场记录的价位关系无效。", 503);
  }
  return wait;
}

function recentWaits(store: Store, candle: number, count: number, skipCurrent = 0) {
  return limited(Array.from({ length: count }, (_, i) => () => readWait(store, candle - (count - i - 1 + skipCurrent) * scanMs)), 4);
}

export async function retainEntryWait(store: Store, env: Env, now: () => number, result: Analysis, candleClosedAt: number, orderBase?: string) {
  const { entry, stopLoss, direction, ...details } = result.opportunity;
  const { rewardRisk: _rr, triggerVerified: _verified, priceReference: _reference, expiredReasons: _expired, ...proposal } = details;
  if (!result.m2Order || !entry || !stopLoss || !direction || (result.status !== "candidate" &&
    !(result.status === "watch" && result.decision.reasons.some(reason => reason.code === "quote_outside_entry")))) return null;
  const base = orderBase ?? production;
  const earlier = await recentWaits(store, candleClosedAt, 3, 1);
  const matching = earlier.find(wait => wait && wait.waitUntil > now() && wait.base === base && wait.proposal.direction === direction &&
    wait.proposal.research.entryZoneId === proposal.research.entryZoneId);
  if (matching) return { state: "existing" as const, waitUntil: matching.waitUntil, analysisId: matching.analysisId };
  if (result.status !== "watch") return null;
  const createdAt = result.timing.completedAt;
  const account = orderBase && env.BINANCE_API_KEY?.trim() ? accountBinding(env) : undefined;
  const wait = { schemaVersion: 1, analysisId: result.analysisId, candleClosedAt, createdAt, waitUntil: createdAt + waitMs, base,
    account, proposal: { ...proposal, status: "candidate", entry, stopLoss, direction } };
  if (!await store.create(jobPath(candleClosedAt), wait)) throw new AppError("ENTRY_WAIT_EXISTS", "该收盘时段已有等待方案。", 409);
  return { state: "waiting" as const, waitUntil: wait.waitUntil, analysisId: wait.analysisId };
}

export async function readEntryWait(store: Store, candleClosedAt: number, analysisId: string, now: number) {
  const job = await readWait(store, candleClosedAt);
  if (!job || job.analysisId !== analysisId) return { state: "unavailable" as const };
  const update = await store.read(outcomePath(analysisId));
  const waitUntil = job.waitUntil;
  if (object(update) && update.analysisId === analysisId && update.state === "attempt") {
    const order = await readAutomaticExecution(store, analysisId);
    if (order.state !== "unavailable") return { ...order, waitUntil };
    const failure = await store.read(failurePath(analysisId));
    return { state: "unknown" as const, reasonCode: object(failure) && typeof failure.reason === "string" ? failure.reason : "entry_wait_attempted", waitUntil };
  }
  if (object(update) && update.analysisId === analysisId && typeof update.reason === "string") {
    return { state: update.reason === "execution_disabled" ? "blocked" as const : "invalidated" as const, reasonCode: update.reason, waitUntil };
  }
  if (now >= waitUntil) return { state: "invalidated" as const, reasonCode: "wait_expired", waitUntil };
  const failure = await store.read(failurePath(analysisId));
  return { state: "waiting" as const, waitUntil,
    reasonCode: object(failure) && typeof failure.reason === "string" ? failure.reason : undefined };
}

function touchedExit(wait: Wait, high: number, low: number): FinishReason | undefined {
  const { direction, stopLoss, targets } = wait.proposal;
  const target = targets[0]!.price;
  const long = direction === "long";
  const stopHit = long ? low <= stopLoss : high >= stopLoss;
  const targetHit = long ? high >= target : low <= target;
  if (stopHit && targetHit) return "stop_or_target_touched";
  if (stopHit) return "stop_touched";
  if (targetHit) return "target_touched";
}

export async function runEntryRecheck(options: { env: Env; now: () => number; request: typeof fetch; orderRequest: typeof fetch;
  deadline: number; tradeResults: TradeResultLog; report: (event: Record<string, unknown>) => void }) {
  const { env, now, request, orderRequest, deadline, tradeResults, report } = options;
  const store = makeStore(env, now, request);
  const jobs = await recentWaits(store, closedCandleBoundary(now(), "5m"), 5);
  let atomic: Promise<void> | undefined;

  async function recordFailure(wait: Wait, reason: string) {
    try {
      await store.write(failurePath(wait.analysisId), { schemaVersion: 1, analysisId: wait.analysisId, recordedAt: now(), reason });
    } catch (error) {
      report({ event: "market_entry_recheck_failure_unavailable", analysisId: wait.analysisId, code: publicError(error).code });
    }
  }

  async function resolve(wait: Wait, reason?: FinishReason) {
    await (atomic ??= store.assertAtomicWrites());
    const created = await store.create(outcomePath(wait.analysisId), { schemaVersion: 1, analysisId: wait.analysisId,
      state: reason ? "closed" : "attempt", waitUntil: wait.waitUntil, recordedAt: now(), reason });
    if (created && reason) await tradeResults.logOutcome(wait.analysisId, "entry-wait", {
      finalStatus: reason === "wait_expired" ? "expired" : "not_executed", reason, waitUntil: wait.waitUntil,
    });
    return created;
  }

  async function check(wait: Wait) {
    if (await store.read(outcomePath(wait.analysisId))) return "resolved";
    if (now() >= wait.waitUntil) { await resolve(wait, "wait_expired"); return "wait_expired"; }
    const time = deadline - now();
    if (time <= 0) return "budget_exhausted";
    const config = loadConfig({ ...env, MARKET_DATA_MODE: "rest", USE_DETERMINISTIC_MODELS: "true" });
    const signal = AbortSignal.timeout(time);
    const market = new RestMarketDataProvider(config, request, now, wait.base, "5m");
    async function checkPath(mark: number, at: number) {
      if (at < wait.createdAt) throw new AppError("ENTRY_WAIT_STALE_QUOTE", "入场复查报价早于原信号。", 503);
      const { high, low } = await market.markPriceExtremes(symbol, wait.createdAt, at, signal);
      return touchedExit(wait, Math.max(mark, high), Math.min(mark, low));
    }
    const quote = await market.quote(symbol, signal);
    const hit = await checkPath(quote.price, quote.time);
    if (hit) { await resolve(wait, hit); return hit; }
    const { entry, direction, stopLoss, targets } = wait.proposal;
    const inRange = quote.price >= entry.min && quote.price <= entry.max;
    const newStructure = closedCandleBoundary(now(), "15m") > closedCandleBoundary(wait.createdAt, "15m");
    if (!inRange && !newStructure) return "waiting";
    const snapshot = await market.snapshot(symbol, signal);
    const freshZone = snapshot.frames.flatMap(frame => frame.zones).find(zone => zone.id === wait.proposal.research.stopZoneId);
    try {
      const { proposal } = evaluateProposal(wait.proposal, snapshot);
      if (proposal.status !== "candidate" || !freshZone || (direction === "long" ? stopLoss >= freshZone.lower : stopLoss <= freshZone.upper)) {
        await resolve(wait, "structure_invalid"); return "structure_invalid";
      }
    } catch (error) {
      if (!(error instanceof AppError) || !error.validation) throw error;
      await resolve(wait, "structure_invalid"); return "structure_invalid";
    }
    if (!inRange) return "waiting";
    if (!wait.account || autoOrderBase(env) !== wait.base || accountBinding(env) !== wait.account) {
      await resolve(wait, "execution_disabled"); return "execution_disabled";
    }
    const settings = loadOrderConfig(env);
    const execution = makeProtectedExecution(settings, makeOrderStore(settings, now, orderRequest),
      makeOrderExchange(settings, now, orderRequest), now, report, tradeResults);
    const id = wait.analysisId;
    const side = direction === "long" ? 1 : -1;
    try {
      const result = await execution.submitAutomatic({ id, owner: digest("owner"), status: "candidate", direction,
        min: entry.min, max: entry.max, stop: stopLoss, target: targets[0]!.price, mark: quote.price, expiresAt: wait.waitUntil,
        decisionSource: "deterministic" }, deadline, async (latest, option) => {
        const lateHit = await checkPath(Number(latest.mark), latest.markTime);
        if (lateHit) { await resolve(wait, lateHit); throw new AppError(lateHit, "等待方案已触及失效价位。", 409); }
        const price = Number(option.price);
        const risk = (price - stopLoss) * side;
        if (risk <= 0 || (targets[0]!.price - price) * side + 1e-9 < minimumM2RewardToRisk * risk) {
          throw new AppError("ENTRY_WAIT_REWARD_TOO_LOW", "对手价对应的预计盈亏比低于 1.5R。", 409);
        }
        if (Math.min(wait.waitUntil, deadline) - now() <= 5000 || now() - Math.min(latest.markTime, latest.bookTime) > 3000) {
          throw new AppError("ENTRY_WAIT_REQUOTE", "入场复查报价已失效或方案已到期。", 409);
        }
        if (!await resolve(wait)) throw new AppError("ENTRY_WAIT_ALREADY_RESOLVED", "等待方案已有处理记录。", 409);
      });
      return result.state;
    } catch (error) {
      const { code } = publicError(error);
      if (code !== "ENTRY_WAIT_ALREADY_RESOLVED") await recordFailure(wait, code);
      return code;
    }
  }

  const results = [];
  for (const job of jobs) {
    if (!job) continue;
    try { results.push({ analysisId: job.analysisId, result: await check(job) }); }
    catch (error) {
      const { code } = publicError(error);
      await recordFailure(job, code);
      results.push({ analysisId: job.analysisId, result: code });
    }
  }
  return results;
}
