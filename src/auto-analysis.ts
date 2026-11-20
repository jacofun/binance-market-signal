import { analyze, type AnalysisStage } from "./analysis.js";
import { loadConfig, type Config, type Env } from "./config.js";
import { AppError, exceptionChain, publicError } from "./errors.js";
import { autoOutcomePath, type AutoAnalysisOutcome, type ScanEvidence } from "./market-scanner.js";
import { analyzeWithModel } from "./model.js";
import { makeOrderStore } from "./order-oss.js";
import { loadOssConfig } from "./oss-config.js";
import type { MarketDataProvider } from "./types.js";

const limitField = "SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT";
const hourMs = 3_600_000;
const maxHistoryTime = 9_999_999_999_999;
const quotaEntry = 1;
const quotaEntryBytes = Buffer.byteLength(`${JSON.stringify(quotaEntry)}\n`);
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

// Each successful append adds the two bytes of "1\n". OSS checks the expected
// append position, so overlapping invocations cannot spend the same slot.
export async function reserveAutoAnalysisQuota(store: Pick<Store, "appendJsonLineAt">, day: string, limit: number) {
  let position = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (position / quotaEntryBytes >= limit) return false;
    const current = await store.appendJsonLineAt(`BTCUSDT/auto-analysis/quota/${day}.ndjson`, quotaEntry, position);
    if (current === null) return true;
    if (current % quotaEntryBytes !== 0) break;
    position = current;
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
}): Promise<AutoAnalysisOutcome> {
  const { env, now, request, deadline, acquire, market, logger } = options;
  const start = now();
  const ids = { requestId: evidence.scanId, symbol: evidence.symbol, candleClosedAt: evidence.candleClosedAt };
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

  async function execute(): Promise<AutoAnalysisOutcome> {
    const limit = autoAnalysisLimit(env);
    if (!limit) return { status: "disabled" };
    const timeLeft = deadline - now();
    if (timeLeft <= 0) return { status: "stale" };
    const release = acquire();
    if (!release) return { status: "busy" };
    try {
      const config = loadConfig(env);
      if (!config.symbols.includes(evidence.symbol)) throw new AppError("SYMBOL_NOT_ALLOWED", "自动分析交易对不在允许列表中。", 400);
      const history = historyStore(env, now, request);
      const signal = AbortSignal.timeout(Math.min(config.requestTimeoutMs, timeLeft));
      const claim = `${evidence.symbol}/auto-analysis/candles/${evidence.candleClosedAt}.ndjson`;
      stage = "quota";
      if ((await store.readJsonLines(claim, 8192)).length) return { status: "duplicate" };
      const passed = evidence.rules.filter(rule => rule.status === "passed");
      const style = passed.length === 1 ? passed[0]?.kind === "breakout" ? "trend" : "reversal" : "neutral";
      const result = await analyze(config, market(config), evidence.symbol, style, signal, async (cfg, snapshot, focus, abort) => {
        if (snapshot.frames.find(frame => frame.interval === "15m")?.lastCloseTime !== evidence.candleClosedAt - 1) {
          throw new AppError("AUTO_ANALYSIS_STALE_SCAN", "当前分析快照已不是本次扫描的 K 线。", 409);
        }
        return analyzeWithModel(cfg, snapshot, focus, abort, async (input, init) => {
          stage = "quota";
          init?.signal?.throwIfAborted();
          if (await store.appendJsonLineAt(claim, evidence.scanId, 0) !== null) {
            throw new AppError("AUTO_ANALYSIS_DUPLICATE", "同一根 K 线已取得自动分析资格。", 409);
          }
          const day = beijingDay(now());
          if (!await reserveAutoAnalysisQuota(store, day, limit)) {
            throw new AppError("AUTO_ANALYSIS_DAILY_LIMIT", "已达到今日自动分析次数上限。", 409);
          }
          quotaClaimed = true;
          if (day !== beijingDay(now())) throw new AppError("AUTO_ANALYSIS_STALE_SCAN", "自动分析额度日期已切换。", 409);
          init?.signal?.throwIfAborted();
          stage = "model";
          modelStarted = true;
          return request(input, init);
        }, evidence);
      }, now, value => { stage = value; });
      analysisId = result.analysisId;
      stage = "archive";
      const model = { ...result.model, promptVersion: "market-research-v4-auto-scan-v1" };
      await archiveResult(history, { ...result, model, requestId: evidence.scanId, scanEvidence: evidence });
      logger.info(JSON.stringify({ event: "market_auto_analysis_completed", ...ids, analysisId, status: result.status,
        ...model, elapsedMs: now() - start }));
      return { status: "completed", analysisId };
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
