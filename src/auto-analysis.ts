import { analyze, type AnalysisStage } from "./analysis.js";
import { loadConfig, type Config, type Env } from "./config.js";
import { AppError, exceptionChain, publicError } from "./errors.js";
import { autoOutcomePath, makeScanStore, type AutoAnalysisOutcome, type AutoOrderOutcome, type ScanEvidence } from "./market-scanner.js";
import { analyzeWithModel, AUTO_ORDER_PROMPT_VERSION, AUTO_SCAN_PROMPT_VERSION } from "./model.js";
import { loadOrderConfig, makeOrderPermit } from "./order-auth.js";
import { makeOrderExchange } from "./order-binance.js";
import { makeProtectedExecution } from "./order-execution.js";
import { makeOrderStore } from "./order-oss.js";
import { loadOssConfig } from "./oss-config.js";
import type { MarketDataProvider } from "./types.js";
import { claimBlock, episodeMs, minuteMs, ordinaryAnalysisLimit, type AnalysisClaim } from "./movement.js";

const limitField = "SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT";
const hourMs = 3_600_000;
const maxHistoryTime = 9_999_999_999_999;
export const analysisIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const limitError = () => new AppError("AUTO_ANALYSIS_CONFIGURATION", `${limitField} 必须为非负整数。`, 503,
  undefined, undefined, { configurationField: limitField });
const beijingDay = (time: number) => new Date(time + 8 * hourMs).toISOString().slice(0, 10);
type Store = ReturnType<typeof makeOrderStore>;
type Stage = AnalysisStage | "configuration" | "quota" | "archive" | "scan_outcome";

export function autoAnalysisLimit(env: Env): number | undefined {
  const value = env[limitField]?.trim();
  if (!value) return undefined;
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) throw limitError();
  return limit;
}

const quotaPath = (day: string) => `BTCUSDT/auto-analysis/quota/${day}.ndjson`;
type QuotaStore = Pick<Store, "appendJsonLineAt" | "readJsonLines">;
type Blocked = "duplicate" | "episode" | "reserved_quota" | "daily_limit";
type QuotaRow = 1 | AnalysisClaim;
async function quotaRows(store: QuotaStore, day: string): Promise<QuotaRow[]> {
  const rows = await store.readJsonLines(quotaPath(day), 256 * 1024);
  if (!rows.every((row): row is QuotaRow => {
    if (row === 1) return true; // legacy model call before movement scanning
    const item = row as Partial<AnalysisClaim> | null;
    return !!item && Number.isSafeInteger(item.eventAt) && Number(item.eventAt) > 0 && Number(item.eventAt) % minuteMs === 0 &&
      (item.direction === null || item.direction === "long" || item.direction === "short") &&
      typeof item.severe === "boolean";
  })) throw new AppError("AUTO_ANALYSIS_QUOTA_UNCONFIRMED", "自动分析额度记录无法验证。", 503);
  return rows;
}

function quotaBlock(rows: QuotaRow[], previous: QuotaRow[], limit: number, claim: AnalysisClaim): Blocked | undefined {
  const blocked = claimBlock([...previous, ...rows].filter(item => item !== 1), claim);
  if (blocked === "duplicate") return blocked;
  if (rows.length >= limit) return "daily_limit";
  if (!claim.severe && rows.filter(row => row === 1 || !row.severe).length >= ordinaryAnalysisLimit(limit)) return "reserved_quota";
  return blocked;
}

async function previousClaims(store: QuotaStore, now: number, eventAt: number) {
  return beijingDay(eventAt - episodeMs) === beijingDay(now) ? [] : quotaRows(store, beijingDay(now - 24 * hourMs));
}

// The same conditional append reserves both the quota and the episode. A
// concurrent caller recomputes the decision from the winning append.
export async function reserveAutoAnalysisQuota(store: QuotaStore, now: number, limit: number, claim: AnalysisClaim) {
  const day = beijingDay(now);
  const previous = await previousClaims(store, now, claim.eventAt);
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await quotaRows(store, day);
    const blocked = quotaBlock(rows, previous, limit, claim);
    if (blocked) return blocked;
    const position = rows.reduce((bytes, row) => bytes + Buffer.byteLength(`${JSON.stringify(row)}\n`), 0);
    if (await store.appendJsonLineAt(quotaPath(day), claim, position) === null) return "reserved";
  }
  throw new AppError("AUTO_ANALYSIS_QUOTA_UNCONFIRMED", "无法确认自动分析额度。", 503);
}

function historyStore(env: Env, now: () => number, request: typeof fetch) {
  const root = env.PRIVATE_RESOURCE_ROOT?.trim() || "/private";
  if (!/^(?:\/[a-zA-Z0-9_.-]+)+$/.test(root) || root.includes("..")) {
    throw new AppError("AUTO_ANALYSIS_CONFIGURATION", "PRIVATE_RESOURCE_ROOT 无效。", 503, undefined, undefined,
      { configurationField: "PRIVATE_RESOURCE_ROOT" });
  }
  const bucket = env.OSS_CONTENT_BUCKET?.trim();
  const region = env.OSS_CONTENT_REGION?.trim().replace(/^oss-/, "");
  if (Boolean(bucket) !== Boolean(region)) {
    const field = bucket ? "OSS_CONTENT_REGION" : "OSS_CONTENT_BUCKET";
    throw new AppError("AUTO_ANALYSIS_CONFIGURATION", `请配置 ${field}。`, 503, undefined, undefined, { configurationField: field });
  }
  const settings = bucket ? { ...env, OSS_BUCKET: bucket, OSS_REGION: region, OSS_NETWORK: "public" } : env;
  return makeOrderStore({ ...loadOssConfig(settings, "SCAN"), prefix: `${root.slice(1)}/.trading/owner/market-signals` }, now, request, "SCAN");
}

export async function readAutoAnalysisArchive(env: Env, now: () => number, request: typeof fetch,
  scanId: string, analysisId: string) {
  const missing = () => new AppError("SIGNAL_NOT_FOUND", "未找到与这次扫描匹配的分析归档。", 404);
  const outcome = await makeScanStore(env, now, request).read(autoOutcomePath(scanId)) as
    { status?: unknown; analysisId?: unknown } | null;
  if (outcome?.status !== "completed" || outcome.analysisId !== analysisId) throw missing();
  const saved = await historyStore(env, now, request).read(`records/${analysisId}.json`, 512 * 1024) as
    (Record<string, unknown> & { orderPermit?: unknown }) | null;
  if (!saved) throw missing();
  if (saved.schemaVersion !== 4 || saved.analysisId !== analysisId || saved.requestId !== scanId) {
    throw new AppError("SIGNAL_ARCHIVE_INVALID", "分析归档与扫描记录不一致。", 502);
  }
  const { orderPermit: _permit, ...result } = saved;
  return result;
}

async function archiveResult(store: Store, result: Awaited<ReturnType<typeof analyze>> & { requestId: string; scanEvidence: ScanEvidence }) {
  const { analysisId, symbol, status, style, opportunity, timing: { completedAt } } = result;
  await store.create(`records/${analysisId}.json`, result);
  // Same queue key and publication order as the site's manual archive. The
  // existing review worker picks up these jobs without a separate trigger.
  await Promise.all([4, 12, 24].map(hours => {
    const due = String(completedAt + hours * hourMs + 120_000).padStart(13, "0");
    return store.create(`review-queue/${due}-${analysisId}-${hours}h-0.json`, {});
  }));
  await store.create(`review-enqueued/${analysisId}.json`, { schemaVersion: 1 });
  const inverseTime = String(maxHistoryTime - completedAt).padStart(13, "0");
  await store.create(`index/${inverseTime}-${analysisId}.json`, {
    analysisId, symbol, status, style, completedAt, title: opportunity.title, schemaVersion: 4,
    direction: opportunity.direction, source: "auto_scan",
  });
}

export async function runAutoAnalysis(evidence: ScanEvidence, store: Store, options: {
  env: Env; now: () => number; request: typeof fetch; deadline: number; acquire: () => (() => void) | undefined;
  market: (config: Config) => MarketDataProvider; logger: Pick<Console, "info" | "error">;
  orderRequest: typeof fetch; orderDeadline: number; orderBase?: string | undefined;
}): Promise<AutoAnalysisOutcome> {
  const { env, now, request, deadline, acquire, market, logger } = options;
  const start = now();
  const ids = { requestId: evidence.scanId, symbol: evidence.symbol, candleClosedAt: evidence.candleClosedAt, trigger: evidence.trigger };
  let stage: Stage = "configuration";
  let quotaClaimed = false;
  let modelStarted = false;
  let analysisId: string | undefined;
  const failure = (error: unknown, at: Stage) => {
    const safe = publicError(error);
    const original = error instanceof AppError ? error : undefined;
    const failureStage = original?.validation ? "proposal_validation" : at;
    logger.error(JSON.stringify({ event: "market_auto_analysis_failed", ...ids, analysisId, stage: failureStage, code: safe.code,
      httpStatus: safe.status, elapsedMs: now() - start, quotaClaimed, modelStarted, configurationField: original?.configurationField,
      ...original?.upstream, validation: original?.validation, marketEndpoint: original?.marketEndpoint,
      marketHttpStatus: original?.marketHttpStatus, exception: exceptionChain(error) }));
    return { status: "failed", stage: failureStage, errorCode: safe.code } as const;
  };

  async function placeOrder(result: Awaited<ReturnType<typeof analyze>>): Promise<AutoOrderOutcome> {
    if (env.SIGNAL_ORDER_EXECUTE !== "true") return { status: "skipped", code: "ORDER_EXECUTION_DISABLED" };
    if (evidence.trigger.kind !== "structure") return { status: "skipped", code: "AUTO_ORDER_RESEARCH_ONLY" };
    const plan = result.status === "candidate" && makeOrderPermit(result, "owner", now());
    if (!plan) return { status: "skipped", code: result.status === "candidate" ? "ORDER_DRAFT_EXPIRED" : "AUTO_ORDER_NOT_CANDIDATE" };
    if (!evidence.rules.some(rule => rule.status === "passed" && rule.direction === plan.direction)) {
      return { status: "skipped", code: "AUTO_ORDER_SCAN_DIRECTION_MISMATCH" };
    }
    try {
      const settings = loadOrderConfig(env);
      if (settings.base !== options.orderBase) throw new AppError("AUTO_ORDER_MARKET_MISMATCH", "扫描行情和下单端点不一致。", 409);
      const request = options.orderRequest;
      const execution = makeProtectedExecution(settings, makeOrderStore(settings, now, request), makeOrderExchange(settings, now, request),
        now, event => logger.info(JSON.stringify({ ...ids, ...event })));
      const order = await execution.submitAutomatic(plan, options.orderDeadline);
      return { status: order.state, clientId: order.clientId, protection: order.protection.state,
        exchangeStatus: order.exchangeStatus, executedQty: order.executedQty, exchangeCode: order.exchangeCode, code: order.reason };
    } catch (error) {
      const safe = publicError(error);
      const original = error instanceof AppError ? error : undefined;
      logger.error(JSON.stringify({ event: "market_auto_order_failed", ...ids, analysisId: result.analysisId,
        code: safe.code, httpStatus: safe.status, configurationField: original?.configurationField,
        ...original?.upstream, exception: exceptionChain(error) }));
      return { status: "failed", code: safe.code };
    }
  }

  async function execute(): Promise<AutoAnalysisOutcome> {
    const limit = autoAnalysisLimit(env);
    if (!limit) return { status: "disabled" };
    const timeLeft = deadline - now();
    if (timeLeft <= 0 || now() - evidence.trigger.eventAt >= 3 * minuteMs) return { status: "stale" };
    const release = acquire();
    if (!release) return { status: "busy" };
    try {
      const config = loadConfig(env);
      if (!config.symbols.includes(evidence.symbol)) throw new AppError("SYMBOL_NOT_ALLOWED", "自动分析交易对不在允许列表中。", 400);
      const history = historyStore(env, now, request);
      const signal = AbortSignal.timeout(Math.min(config.requestTimeoutMs, timeLeft));
      const claim: AnalysisClaim = { eventAt: evidence.trigger.eventAt, direction: evidence.trigger.direction, severe: evidence.trigger.severe };
      const legacyClaim = `${evidence.symbol}/auto-analysis/candles/${evidence.candleClosedAt}.ndjson`;
      stage = "quota";
      if (evidence.trigger.kind === "structure" && (await store.readJsonLines(legacyClaim, 8192)).length) return { status: "duplicate" };
      const gateAt = now();
      const [current, previous] = await Promise.all([quotaRows(store, beijingDay(gateAt)), previousClaims(store, gateAt, claim.eventAt)]);
      const blocked = quotaBlock(current, previous, limit, claim);
      if (blocked) return { status: blocked };
      const passed = evidence.rules.filter(rule => rule.status === "passed");
      const style = evidence.trigger.kind === "structure" && passed.length === 1 ? passed[0]?.kind === "breakout" ? "trend" : "reversal" : "neutral";
      const immediate = !!options.orderBase && evidence.trigger.kind === "structure" && passed.length > 0;
      const result = await analyze(config, market(config), evidence.symbol, style, signal, async (cfg, snapshot, focus, abort) => {
        if (evidence.trigger.kind === "structure" &&
            snapshot.frames.find(frame => frame.interval === "15m")?.lastCloseTime !== evidence.trigger.eventAt - 1) {
          throw new AppError("AUTO_ANALYSIS_STALE_SCAN", "当前分析快照已不是本次扫描的 K 线。", 409);
        }
        return analyzeWithModel(cfg, snapshot, focus, abort, async (input, init) => {
          stage = "quota";
          init?.signal?.throwIfAborted();
          const dispatchAt = now();
          if (dispatchAt - claim.eventAt >= 3 * minuteMs) throw new AppError("AUTO_ANALYSIS_STALE_SCAN", "异动扫描已过时。", 409);
          const reservation = await reserveAutoAnalysisQuota(store, dispatchAt, limit, claim);
          if (reservation !== "reserved") throw new AppError(`AUTO_ANALYSIS_${reservation.toUpperCase()}`, "本次扫描无需重复分析或额度不足。", 409);
          quotaClaimed = true;
          if (beijingDay(dispatchAt) !== beijingDay(now())) throw new AppError("AUTO_ANALYSIS_STALE_SCAN", "自动分析额度日期已切换。", 409);
          init?.signal?.throwIfAborted();
          stage = "model";
          modelStarted = true;
          return request(input, init);
        }, evidence, immediate);
      }, now, value => { stage = value; });
      analysisId = result.analysisId;
      stage = "archive";
      const model = { ...result.model, promptVersion: immediate ? AUTO_ORDER_PROMPT_VERSION : AUTO_SCAN_PROMPT_VERSION };
      const notes = immediate ? ["同向候选通过即时委托复核后可自动提交，实际结果以订单记录为准。", ...result.notes.slice(1)] : result.notes;
      await archiveResult(history, { ...result, model, notes, requestId: evidence.scanId, scanEvidence: evidence });
      logger.info(JSON.stringify({ event: "market_auto_analysis_completed", ...ids, analysisId, status: result.status,
        modelStatus: result.decision.modelStatus, modelDirection: result.decision.modelDirection,
        decisionReasons: result.decision.reasons.map(reason => reason.code),
        ...model, elapsedMs: now() - start }));
      if (env.SIGNAL_AUTO_ORDER_EXECUTE !== "true") return { status: "completed", analysisId };
      const order = await placeOrder(result);
      logger.info(JSON.stringify({ event: "market_auto_order_outcome", ...ids, analysisId, ...order }));
      return { status: "completed", analysisId, order };
    } finally {
      release();
    }
  }

  let outcome: AutoAnalysisOutcome;
  try {
    outcome = await execute();
  } catch (error) {
    const code = error instanceof AppError ? error.code : undefined;
    outcome = code === "AUTO_ANALYSIS_DUPLICATE" ? { status: "duplicate" } :
      code === "AUTO_ANALYSIS_EPISODE" ? { status: "episode" } :
      code === "AUTO_ANALYSIS_RESERVED_QUOTA" ? { status: "reserved_quota" } :
      code === "AUTO_ANALYSIS_DAILY_LIMIT" ? { status: "daily_limit" } :
      code === "AUTO_ANALYSIS_STALE_SCAN" ? { status: "stale" } : failure(error, stage);
  }
  try {
    await store.create(autoOutcomePath(evidence.scanId), outcome);
  } catch (error) {
    failure(error, "scan_outcome");
  }
  return outcome;
}
