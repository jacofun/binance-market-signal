import { AppError } from "./errors.js";
import type { Env } from "./config.js";
import { limited } from "./http.js";
import { closedCandleBoundary, INTERVAL_MS } from "./market.js";
import { makeOrderStore } from "./order-oss.js";
import { loadOssConfig } from "./oss-config.js";

const symbol = "BTCUSDT";
const interval = INTERVAL_MS["15m"];
const pageSize = 16;
const hour = INTERVAL_MS["1h"];
const pageWindow = 4 * hour;
const historyDays = 30;

const scanError = (code: string, message: string, status = 400) => new AppError(code, message, status);
const hourFor = (time: number) => Math.floor(time / hour) * hour;
const slotFor = (time: number) => closedCandleBoundary(time, "15m");
const legacyKey = (slot: number) => `${symbol}/${slot}.json`;
const logKey = (time: number) => `${symbol}/runs/${hourFor(time)}.ndjson`;
const cursorFormat = /^(\d{13}):([a-z0-9-]{0,60})$/;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const makeLegacyScanStore = (env: Env, now: () => number, request: typeof fetch) =>
  makeOrderStore({ ...loadOssConfig(env, "SCAN"), prefix: "private/market-signal-scanner/v1" }, now, request, "SCAN");

export function makeScanHistory(env: Env, now: () => number, request: typeof fetch, automatic?: {
  read: (from: number, to: number) => Promise<unknown[]>;
  attachArchive: (record: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const store = makeLegacyScanStore(env, now, request);
  async function listLegacy(input: Record<string, unknown>) {
    const latest = slotFor(now());
    const oldest = latest - historyDays * 24 * hour;
    const before = input.before === undefined ? latest + interval : input.before;
    if (Object.keys(input).some(key => key !== "before") || typeof before !== "number" || !Number.isSafeInteger(before) ||
      before % interval !== 0 || before <= oldest || before > latest + interval) {
      throw scanError("INVALID_SCAN_CURSOR", "扫描记录分页参数无效。");
    }
    const slots = Array.from({ length: pageSize }, (_, i) => before - (i + 1) * interval).filter(slot => slot >= oldest);
    const rows = await limited(slots.map(slot => () => store.read(legacyKey(slot))), 4);
    const start = slots.at(-1)!;
    return { records: rows.filter(row => row !== null), from: start, to: before - interval, next: start > oldest ? start : null };
  }

  return {
    async list(input: Record<string, unknown>) {
      const includeAutomatic = (input.version === 3 || input.version === 4) && automatic;
      if (input.version !== 2 && !includeAutomatic) return listLegacy(input);
      const latest = now();
      const oldest = hourFor(latest) - historyDays * 24 * hour;
      const before = typeof input.before === "string" ? cursorFormat.exec(input.before) : null;
      const to = before ? Number(before[1]) : latest;
      if (Object.keys(input).some(key => key !== "version" && key !== "before") || input.before !== undefined && !before ||
        to < oldest || to > latest) throw scanError("INVALID_SCAN_CURSOR", "扫描记录分页参数无效。");
      const from = Math.max(oldest, to - pageWindow + 1);
      const hours = Array.from({ length: (hourFor(to) - hourFor(from)) / hour + 1 }, (_, i) => hourFor(to) - i * hour);
      const slots = Array.from({ length: pageSize + 1 }, (_, i) => slotFor(to) - i * interval).filter(slot => slot >= from);
      const reads: (() => Promise<unknown[]>)[] = hours.map(h => () => store.readJsonLines(logKey(h), 8 * 1024 * 1024));
      if (includeAutomatic) reads.unshift(() => includeAutomatic.read(from, to));
      for (const slot of slots) reads.push(async () => {
        const row = asObject(await store.read(legacyKey(slot)));
        return row ? [{ ...row, time: slot, id: `legacy-${slot}`, scannedAt: null,
          candleClosedAt: row.status === "error" ? null : slot }] : [];
      });
      const rows = (await limited(reads, 4)).flat().flatMap(value => {
        const item = asObject(value);
        if (!item || typeof item.id !== "string" || !/^[a-z0-9-]{1,60}$/.test(item.id) ||
          typeof item.time !== "number" || !Number.isSafeInteger(item.time) || item.time < from || item.time > to ||
          (before && item.time === to && item.id >= before[2]!)) return [];
        return [{ record: item, time: item.time, id: item.id }];
      }).sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const visible = rows.slice(0, pageSize);
      const last = visible.at(-1);
      const hasMore = rows.length > pageSize && last;
      const records = await limited(visible.map(({ record, id }) => async () => {
        if (record.kind === "deterministic" && automatic) {
          return automatic.attachArchive(record).catch(() => {
            const { analysisId: _unverified, ...row } = record;
            return row;
          });
        }
        if (asObject(record.autoAnalysis)?.status !== "pending") return record;
        // A failed status lookup must not hide the saved scan.
        const outcome = await store.read(legacyOutcomePath(id)).catch(() => null);
        return outcome ? { ...record, autoAnalysis: outcome } : record;
      }), 4);
      return { records, from: hasMore ? last.time : from, to,
        next: hasMore ? `${last.time}:${last.id}` : from > oldest ? `${from}:` : null };
    },
  };
}

export const legacyOutcomePath = (id: string) => `${symbol}/auto-analysis/outcomes/${id}.json`;
