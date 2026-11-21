import { createInterface } from "node:readline";
import { claimBlock, episodeMs, minuteMs, ordinaryAnalysisLimit, scanMovement } from "../build/movement.js";

const limit = Number(process.argv[2] ?? 10);
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Supply a positive daily model call limit.");
const bars = [];
const days = new Map();
const recent = [];
let previous;
for await (const line of createInterface({ input: process.stdin })) {
  if (!/^\d+,/.test(line)) continue;
  const cols = line.split(",");
  const open = Number(cols[0]);
  const closeTime = Number(cols[6]);
  const close = Number(cols[4]);
  const volume = Number(cols[5]);
  if ((previous !== undefined && open !== previous + minuteMs) || closeTime !== open + minuteMs - 1 ||
      !Number.isFinite(close) || close <= 0 || !Number.isFinite(volume) || volume < 0) throw new Error(`Invalid or missing bar at ${open}`);
  previous = open;
  bars.push({ closeTime, close, volume });
  if (bars.length < 211) continue;
  const signal = scanMovement(bars);
  bars.shift();
  const day = new Date(signal.closedAt + 8 * 3_600_000).toISOString().slice(0, 10);
  const stats = days.get(day) ?? { bars: 0, normalMatches: 0, severeMatches: 0, duplicateEpisodes: 0, quotaBlocked: 0,
    ordinaryCalls: 0, severeCalls: 0, events: [] };
  days.set(day, stats);
  stats.bars++;
  if (!signal.direction) continue;
  const claim = { eventAt: signal.closedAt, direction: signal.direction, severe: signal.severity === "severe" };
  claim.severe ? stats.severeMatches++ : stats.normalMatches++;
  while (recent.length && claim.eventAt - recent[0].eventAt >= episodeMs) recent.shift();
  if (stats.ordinaryCalls + stats.severeCalls >= limit || (!claim.severe && stats.ordinaryCalls >= ordinaryAnalysisLimit(limit))) {
    stats.quotaBlocked++;
  } else if (claimBlock(recent, claim)) {
    stats.duplicateEpisodes++;
  } else {
    recent.push(claim);
    claim.severe ? stats.severeCalls++ : stats.ordinaryCalls++;
    stats.events.push({ at: new Date(claim.eventAt).toISOString(), direction: claim.direction,
      severe: claim.severe, returnsPct: signal.windows.map(window => Number(window.changePct.toFixed(3))) });
  }
}
if (!days.size) throw new Error("Replay needs at least 211 continuous Binance 1m CSV rows.");
console.log(JSON.stringify({ limit, days: Object.fromEntries(days) }, null, 2));
