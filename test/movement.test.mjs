import assert from "node:assert/strict";
import test from "node:test";
import { claimBlock, minuteMs, ordinaryAnalysisLimit, scanMovement } from "../build/movement.js";

const candles = (prices, volume = 10) => prices.map((close, index) => ({
  close, closeTime: (index + 1) * minuteMs - 1, volume,
}));

test("ordinary movement excludes the current window from the baseline and reports volume separately", () => {
  const history = candles(Array(211).fill(100));
  history.at(-1).close = 99.4;
  history.at(-1).volume = 0;
  const result = scanMovement(history);
  assert.equal(result.direction, "short");
  assert.equal(result.severity, "normal");
  assert.equal(result.closedAt, 211 * minuteMs);
  assert.equal(result.windows[0].baselinePct, 0);
  assert.equal(result.windows[0].thresholdPct, 0.6);
  assert.equal(result.windows[0].volumeRatio, 0.8);
  assert.equal(result.windows[1].severity, "none");
});

test("the adaptive threshold filters routine moves and the severe trigger only requires its fixed threshold", () => {
  const history = candles(Array.from({ length: 211 }, (_, index) => 100 * 1.0016 ** index), 0);
  const fiveMinutesPrior = history.at(-6).close;
  history.at(-16).close = fiveMinutesPrior;
  history.at(-1).close = fiveMinutesPrior * 1.011;
  const steady = scanMovement(history);
  assert.ok(steady.windows[0].thresholdPct > 2);
  assert.equal(steady.severity, "none");
  history.at(-1).close = fiveMinutesPrior * 1.012;
  const extreme = scanMovement(history);
  assert.equal(extreme.direction, "long");
  assert.equal(extreme.severity, "severe");
  assert.equal(extreme.windows[0].volumeRatio, null);
});

test("limited history skips ordinary triggers but retains severe 15-minute detection", () => {
  const history = candles([...Array(10).fill(100), ...Array(21).fill(98)]);
  const result = scanMovement(history);
  assert.equal(result.severity, "none");
  history[history.length - 16].close = 100;
  const severe = scanMovement(history);
  assert.equal(severe.windows[1].thresholdPct, null);
  assert.equal(severe.windows[1].severity, "severe");
  assert.equal(severe.direction, "short");
});

test("claims allow an opposite move, one severe escalation and a fresh event at 20 minutes", () => {
  const ordinary = { eventAt: minuteMs, direction: "short", severe: false };
  const severe = { ...ordinary, eventAt: 2 * minuteMs, severe: true };
  assert.equal(claimBlock([ordinary], { ...ordinary, severe: true }), "duplicate");
  assert.equal(claimBlock([ordinary], severe), undefined);
  assert.equal(claimBlock([ordinary, severe], { ...severe, eventAt: 3 * minuteMs }), "episode");
  assert.equal(claimBlock([ordinary, severe], { ...severe, eventAt: 3 * minuteMs, direction: "long" }), undefined);
  assert.equal(claimBlock([ordinary, severe], { ...ordinary, eventAt: 22 * minuteMs }), undefined);
  assert.deepEqual([1, 2, 3, 10].map(ordinaryAnalysisLimit), [1, 1, 2, 7]);
});
