import { analyze, type AnalysisStage } from "./analysis.js";
import { loadConfig, type Env } from "./config.js";
import { AppError, exceptionChain, publicError } from "./errors.js";
import { closedCandleBoundary, INTERVAL_MS, RestMarketDataProvider } from "./market.js";
import { legacyOutcomePath, makeLegacyScanStore } from "./scan-history.js";
import { autoOrderBase, loadOrderConfig, makeOrderPermit } from "./order-auth.js";
import { makeOrderExchange } from "./order-binance.js";
import { makeProtectedExecution } from "./order-execution.js";
import { makeOrderStore } from "./order-oss.js";
import { loadOssConfig } from "./oss-config.js";
import type { Trend } from "./types.js";

export const AUTO_ANALYSIS_TRIGGER = "binance-market-analysis";
export const analysisIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const symbol = "BTCUSDT";
const limitField = "SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT";
const hourMs = INTERVAL_MS["1h"];
const closeFreshnessMs = 180_000;
const maxHistoryTime = 9_999_999_999_999;
const beijingDay = (time: number) => new Date(time + 8 * hourMs).toISOString().slice(0, 10);
type Store = ReturnType<typeof makeOrderStore>;
type Stage = AnalysisStage | "configuration" | "quota" | "archive";
type SlotStatus = "reserved" | "duplicate" | "daily_limit" | "no_trigger";
type Observation = {
  requestId: string; triggeredAt: number; close: number; rvol20: number | null; trend4h: Trend;
  m1: { score: number; reasons: string[] }; analysisId: string;
};

const autoSlotsPath = (closedAt: number) => `${symbol}/slots/${beijingDay(closedAt)}.ndjson`;
const makeAutoStore = (env: Env, now: () => number, request: typeof fetch) =>
  makeOrderStore({ ...loadOssConfig(env, "SCAN"), prefix: "private/market-signal-auto-analysis/v1" }, now, request, "SCAN");

export function validateAutoAnalysisTimer(input: Record<string, unknown>, now: number) {
  const time = typeof input.triggerTime === "string" ? Date.parse(input.triggerTime) : NaN;
  if (input.triggerName !== AUTO_ANALYSIS_TRIGGER || !Number.isFinite(time) || time <= 0 || time > now + 5000) {
    throw new AppError("INVALID_AUTO_ANALYSIS_TIMER", "自动分析触发时间无效或超出容许时钟偏差。");
  }
  return time;
}

export function autoAnalysisLimit(env: Env): number | undefined {
  const value = env[limitField]?.trim();
  if (!value) return undefined;
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) {
    throw new AppError("AUTO_ANALYSIS_CONFIGURATION", `${limitField} 必须为非负整数。`, 503,
      undefined, undefined, { configurationField: limitField });
  }
  return limit;
}

export async function reserveAutoAnalysisSlot(store: Pick<Store, "appendJsonLineAt" | "readJsonLines">,
  closedAt: number, limit: number, triggered: boolean, observation?: Observation): Promise<SlotStatus> {
  const path = autoSlotsPath(closedAt);
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await store.readJsonLines(path, 256 * 1024);
    const seen = new Set<number>();
    let used = 0;
    for (const row of rows) {
      const item = row as { closedAt?: unknown; status?: unknown } | null;
      if (!item || typeof item.closedAt !== "number" || !Number.isSafeInteger(item.closedAt) || item.closedAt <= 0 ||
        item.closedAt % INTERVAL_MS["15m"] !== 0 || beijingDay(item.closedAt) !== beijingDay(closedAt) || seen.has(item.closedAt) ||
        !["no_trigger", "reserved", "daily_limit"].includes(item.status as string)) {
        throw new AppError("AUTO_ANALYSIS_QUOTA_UNCONFIRMED", "自动分析额度记录无法验证。", 503);
      }
      seen.add(item.closedAt);
      if (item.status === "reserved") used++;
    }
    if (seen.has(closedAt)) return "duplicate";
    const status = !triggered ? "no_trigger" : used >= limit ? "daily_limit" : "reserved";
    const position = rows.reduce<number>((bytes, row) => bytes + Buffer.byteLength(`${JSON.stringify(row)}\n`), 0);
    if (await store.appendJsonLineAt(path, { closedAt, status, ...(observation ? { observation } : {}) }, position) === null) return status;
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

export async function readLinkedAnalysisArchive(env: Env, now: () => number, request: typeof fetch,
  scanId: string, analysisId: string) {
  const missing = () => new AppError("SIGNAL_NOT_FOUND", "未找到与这次扫描匹配的分析归档。", 404);
  const saved = await readArchivedAnalysis(historyStore(env, now, request), analysisId);
  if (!isAutomaticRecord(saved, scanId, analysisId)) {
    const outcome = await makeLegacyScanStore(env, now, request).read(legacyOutcomePath(scanId)) as
      { status?: unknown; analysisId?: unknown } | null;
    if (outcome?.status !== "completed" || outcome.analysisId !== analysisId) throw missing();
  }
  if (!saved) throw missing();
  if (saved.schemaVersion !== 4 || saved.analysisId !== analysisId || saved.requestId !== scanId) {
    throw new AppError("SIGNAL_ARCHIVE_INVALID", "分析归档与扫描记录不一致。", 502);
  }
  const { orderPermit: _permit, ...result } = saved;
  return result;
}

async function readArchivedAnalysis(store: Store, analysisId: string) {
  return await store.read(`records/${analysisId}.json`, 512 * 1024) as
    (Record<string, unknown> & { orderPermit?: unknown; automaticAnalysis?: { candleClosedAt?: unknown } }) | null;
}

function isAutomaticRecord(saved: Awaited<ReturnType<typeof readArchivedAnalysis>>, requestId: string, analysisId: string,
  candleClosedAt?: number) {
  return saved?.schemaVersion === 4 && saved.analysisId === analysisId && saved.requestId === requestId &&
    saved.decisionSource === "deterministic" && typeof saved.automaticAnalysis?.candleClosedAt === "number" &&
    (candleClosedAt === undefined || saved.automaticAnalysis.candleClosedAt === candleClosedAt);
}

export async function readAutomaticScanRows(env: Env, now: () => number, request: typeof fetch, from: number, to: number) {
  const store = makeAutoStore(env, now, request);
  const paths = new Set([autoSlotsPath(from), autoSlotsPath(to)]);
  const rows = (await Promise.all([...paths].map(path => store.readJsonLines(path, 256 * 1024)))).flat();
  return rows.flatMap(value => {
    const item = value as { closedAt?: unknown; status?: unknown; observation?: Observation } | null;
    if (!item || typeof item.closedAt !== "number" || !Number.isSafeInteger(item.closedAt) || item.closedAt <= 0 ||
      item.closedAt % INTERVAL_MS["15m"] !== 0 ||
      (item.status !== "reserved" && item.status !== "no_trigger" && item.status !== "daily_limit")) return [];
    const { closedAt, observation } = item;
    const run = observation && typeof observation.requestId === "string" && analysisIdPattern.test(observation.requestId) &&
      Number.isSafeInteger(observation.triggeredAt) && closedCandleBoundary(observation.triggeredAt, "15m") === closedAt ?
      observation : undefined;
    return [{ kind: "deterministic", symbol, id: run?.requestId ?? `m1-slot-${closedAt}`, time: run?.triggeredAt ?? closedAt,
      scannedAt: run?.triggeredAt ?? null, candleClosedAt: closedAt,
      status: item.status === "reserved" ? "triggered" : item.status,
      ...(run ? { m1: run.m1, close: run.close, rvol20: run.rvol20, trend4h: run.trend4h,
        ...(item.status === "reserved" && typeof run.analysisId === "string" && analysisIdPattern.test(run.analysisId) ?
          { analysisId: run.analysisId } : {}) } : {}) }];
  });
}

export async function attachAutomaticScanArchive(env: Env, now: () => number, request: typeof fetch, record: Record<string, unknown>) {
  const { analysisId, ...row } = record;
  if (typeof analysisId !== "string" || !analysisIdPattern.test(analysisId) || typeof row.id !== "string" ||
    typeof row.candleClosedAt !== "number") return row;
  const saved = await readArchivedAnalysis(historyStore(env, now, request), analysisId);
  const opportunityStatus = saved?.status;
  if (!isAutomaticRecord(saved, row.id, analysisId, row.candleClosedAt) ||
    (opportunityStatus !== "candidate" && opportunityStatus !== "watch" && opportunityStatus !== "none" && opportunityStatus !== "expired")) return row;
  return { ...row, analysisId, opportunityStatus };
}

async function archiveResult(store: Store, result: Awaited<ReturnType<typeof analyze>> & { requestId: string; automaticAnalysis: { triggeredAt: number; candleClosedAt: number } }) {
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
    // The existing website history reader recognizes this source value.
    direction: opportunity.direction, source: "auto_scan",
  });
}

export async function runAutoAnalysis(requestId: string, triggeredAt: number, options: {
  env: Env; now: () => number; request: typeof fetch; deadline: number; acquire: () => (() => void) | undefined;
  logger: Pick<Console, "info" | "error">; orderRequest: typeof fetch; orderDeadline: number;
}) {
  const { env, now, request, deadline, acquire, logger } = options;
  const start = now();
  const candleClosedAt = closedCandleBoundary(triggeredAt, "15m");
  const ids = { requestId, symbol, triggeredAt, candleClosedAt };
  let stage: Stage = "configuration";
  let analysisId: string | undefined;
  let quotaClaimed = false;

  async function placeOrder(result: Awaited<ReturnType<typeof analyze>>, orderBase?: string) {
    if (env.SIGNAL_ORDER_EXECUTE !== "true") return { status: "skipped", code: "ORDER_EXECUTION_DISABLED" };
    const plan = result.status === "candidate" && makeOrderPermit(result, "owner", now());
    if (!plan) return { status: "skipped", code: result.status === "candidate" ? "ORDER_DRAFT_EXPIRED" : "AUTO_ORDER_NOT_CANDIDATE" };
    try {
      const settings = loadOrderConfig(env);
      if (settings.base !== orderBase) throw new AppError("AUTO_ORDER_MARKET_MISMATCH", "行情和下单端点不一致。", 409);
      const orderRequest = options.orderRequest;
      const execution = makeProtectedExecution(settings, makeOrderStore(settings, now, orderRequest),
        makeOrderExchange(settings, now, orderRequest), now, event => logger.info(JSON.stringify({ ...ids, ...event })));
      const order = await execution.submitAutomatic(plan, options.orderDeadline);
      return { status: order.state, clientId: order.clientId, protection: order.protection.state,
        exchangeStatus: order.exchangeStatus, executedQty: order.executedQty, exchangeCode: order.exchangeCode, code: order.reason };
    } catch (error) {
      const safe = publicError(error);
      const original = error instanceof AppError ? error : undefined;
      logger.error(JSON.stringify({ event: "market_auto_order_failed", ...ids, analysisId,
        code: safe.code, httpStatus: safe.status, configurationField: original?.configurationField,
        ...original?.upstream, exception: exceptionChain(error) }));
      return { status: "failed", code: safe.code };
    }
  }

  try {
    const limit = autoAnalysisLimit(env);
    if (!limit) return { status: "disabled", candleClosedAt };
    const timeLeft = deadline - now();
    const stale = () => now() - candleClosedAt >= closeFreshnessMs;
    if (timeLeft <= 0 || stale()) return { status: "stale", candleClosedAt };
    const release = acquire();
    if (!release) return { status: "busy", candleClosedAt };
    try {
      const config = loadConfig({ ...env, MARKET_DATA_MODE: "rest", USE_DETERMINISTIC_MODELS: "true" });
      if (!config.symbols.includes(symbol)) throw new AppError("SYMBOL_NOT_ALLOWED", "自动分析交易对不在允许列表中。", 400);
      const store = makeAutoStore(env, now, request);
      const history = historyStore(env, now, request);
      const orderBase = autoOrderBase(env);
      const market = new RestMarketDataProvider(config, request, now, orderBase);
      const signal = AbortSignal.timeout(Math.min(config.requestTimeoutMs, timeLeft));
      const result = await analyze(config, market, symbol, "neutral", signal, undefined, now, value => { stage = value; }, snapshot => {
        if (stale() || snapshot.frames.find(frame => frame.interval === "15m")?.lastCloseTime !== candleClosedAt - 1) {
          throw new AppError("AUTO_ANALYSIS_STALE_TIMER", "当前快照不对应本次定时事件的 15m 收盘。", 409);
        }
      });
      if (stale()) return { status: "stale", candleClosedAt };
      stage = "quota";
      const short = result.market.frames.find(frame => frame.interval === "15m");
      const trend4h = result.market.frames.find(frame => frame.interval === "4h")?.trend;
      const m1 = result.m1Trigger;
      const observation = short && trend4h && m1 ? { requestId, triggeredAt, close: short.close,
        rvol20: short.volumeRatio20, trend4h, m1: { score: m1.score, reasons: m1.reasons },
        analysisId: result.analysisId } : undefined;
      const checked = await reserveAutoAnalysisSlot(store, candleClosedAt, limit, m1?.triggered === true, observation);
      if (checked !== "reserved") {
        return { status: checked, candleClosedAt, m1Trigger: result.m1Trigger };
      }
      quotaClaimed = true;
      analysisId = result.analysisId;
      stage = "archive";
      const notes = orderBase ? ["候选通过即时委托复核后可自动提交，实际结果以订单记录为准。", ...result.notes.slice(1)] : result.notes;
      await archiveResult(history, { ...result, notes, requestId, automaticAnalysis: { triggeredAt, candleClosedAt } });
      logger.info(JSON.stringify({ event: "market_auto_analysis_completed", ...ids, analysisId, status: result.status,
        decisionSource: result.decisionSource, m1Score: result.m1Trigger?.score,
        decisionReasons: result.decision.reasons.map(reason => reason.code), elapsedMs: now() - start }));
      if (env.SIGNAL_AUTO_ORDER_EXECUTE !== "true") return { status: "completed", candleClosedAt, analysisId };
      const order = await placeOrder(result, orderBase);
      logger.info(JSON.stringify({ event: "market_auto_order_outcome", ...ids, analysisId, ...order }));
      return { status: "completed", candleClosedAt, analysisId, order };
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTO_ANALYSIS_STALE_TIMER") return { status: "stale", candleClosedAt };
    const safe = publicError(error);
    const original = error instanceof AppError ? error : undefined;
    logger.error(JSON.stringify({ event: "market_auto_analysis_failed", ...ids, analysisId, stage, code: safe.code,
      httpStatus: safe.status, elapsedMs: now() - start, quotaClaimed, configurationField: original?.configurationField,
      ...original?.upstream, validation: original?.validation, marketEndpoint: original?.marketEndpoint,
      marketHttpStatus: original?.marketHttpStatus, exception: exceptionChain(error) }));
    return { status: "failed", candleClosedAt, stage, errorCode: safe.code };
  }
}
