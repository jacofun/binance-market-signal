import { randomUUID } from "node:crypto";
import { analysisIdPattern, readAutomaticScanRows } from "./auto-analysis.js";
import type { Env } from "./config.js";
import { AppError } from "./errors.js";
import { limited } from "./http.js";
import { object } from "./order-auth.js";
import { makeOrderStore } from "./order-oss.js";
import { loadAnalysisArchiveConfig } from "./oss-config.js";
import { tradeDecisionPath, tradeResultPrefix } from "./trade-result-log.js";

const maxSelected = 100; // Fits the existing 4 KiB JSON request limit.
const maxRange = 7 * 24 * 60 * 60 * 1000;
const downloadOrigin = "https://static.yanxiao.me";
const validId = (value: unknown): value is string => typeof value === "string" && analysisIdPattern.test(value);
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export async function exportScanDecisions(env: Env, now: () => number, request: typeof fetch, input: Record<string, unknown>) {
  const { analysisIds, from, to } = input;
  let selected: string[] | undefined;
  let range: { from: number; to: number } | undefined;
  if (Array.isArray(analysisIds) && Object.keys(input).length === 2 && analysisIds.length > 0 &&
    analysisIds.length <= maxSelected && analysisIds.every(validId)) {
    selected = [...new Set(analysisIds)];
  } else if (Object.keys(input).length === 3 && validTime(from) && validTime(to) && from <= to && to <= now() && to - from <= maxRange) {
    range = { from, to };
  } else {
    throw new AppError("INVALID_SCAN_EXPORT", "请选择 1–100 条扫描记录，或输入不超过 7 天且结束时间不晚于现在的区间。");
  }

  const config = loadAnalysisArchiveConfig(env);
  const store = makeOrderStore(config, now, request, "SCAN");
  let exported: string[];
  let skippedCount: number;
  if (range) {
    const rows = await readAutomaticScanRows(env, now, request, range.from, range.to, true, true);
    const inRange = rows.filter(row => row.candleClosedAt >= range.from && row.candleClosedAt <= range.to)
      .sort((a, b) => a.candleClosedAt - b.candleClosedAt);
    const ids = [...new Set(inRange.flatMap(row => row.exportAnalysisId ? [row.exportAnalysisId] : []))];
    const present = await limited(ids.map(id => async () => await store.exists(tradeDecisionPath(id)) ? id : null), 16);
    exported = present.filter(id => id !== null);
    skippedCount = inRange.length - exported.length;
  } else {
    const ids = selected!;
    const present = await limited(ids.map(id => async () => {
      const row = await store.read(tradeDecisionPath(id), 512 * 1024);
      return object(row) && row.schemaVersion === 1 && row.recordType === "decision" && row.analysisId === id &&
        row.symbol === "BTCUSDT" && row.source === "automatic" && row.decisionSource === "deterministic" &&
        validId(row.scanId) && row.scanId === row.requestId ? id : null;
    }), 8);
    exported = present.filter(id => id !== null);
    skippedCount = ids.length - exported.length;
  }
  if (!exported.length) throw new AppError("SCAN_EXPORT_EMPTY", "所选记录没有可读取的自动扫描决策日志。", 404);
  const exportId = randomUUID();
  const path = `${tradeResultPrefix}/exports/${exportId}.json`;
  const manifest = { schemaVersion: 1, exportId, exportedAt: now(), symbol: "BTCUSDT", count: exported.length, skippedCount,
    ...(range ? { range } : {}), analysisIds: exported };
  if (!await store.create(path, manifest)) throw new AppError("SCAN_EXPORT_CONFLICT", "导出编号冲突，请重试。", 409);
  return { exportId, count: manifest.count, skippedCount, url: `${downloadOrigin}/${config.prefix}/${path}` };
}
