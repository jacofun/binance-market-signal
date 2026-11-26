import assert from "node:assert/strict";
import test from "node:test";
import { evaluateM1Trigger } from "../build/m1-trigger.js";
import { snapshot } from "./fixtures.mjs";

test("aligned closed-bar trends, sufficient volume and support produce a repeatable 100 score", () => {
  const market = snapshot();
  const before = structuredClone(market);
  const result = evaluateM1Trigger(market, "trend");
  assert.equal(result.triggered, true);
  assert.equal(result.score, 100);
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.reasons, ["continuation", "near_zone", "rvol_sufficient", "trends_aligned", "atr_in_range"]);
  assert.equal(result.keyFeatures.direction, "long");
  assert.equal(result.keyFeatures.marketState, "trend");
  assert.equal(result.keyFeatures.zone.id, "entry");
  assert.deepEqual(evaluateM1Trigger(market, "trend"), result);
  assert.deepEqual(market, before);
  market.quote.price = 12000;
  assert.deepEqual(evaluateM1Trigger(market, "trend"), result);
});

test("reversal style can score a countertrend recovery and neutral prefers a matching continuation", () => {
  const market = snapshot();
  for (const frame of market.frames) frame.trend = "down";
  const short = market.frames.find(frame => frame.interval === "15m");
  short.volumePrice[0].closeChangePct = -0.5;
  assert.equal(evaluateM1Trigger(market, "reversal").triggered, false);
  short.volumePrice[0].observations = ["high_volume_down", "high_volume_lower_recovery"];
  const reversal = evaluateM1Trigger(market, "reversal");
  assert.equal(reversal.triggered, true);
  assert.equal(reversal.score, 90);
  assert.equal(reversal.confidence, "medium");
  assert.equal(reversal.keyFeatures.direction, "long");
  assert.equal(reversal.keyFeatures.setup, "reversal");
  assert.equal(evaluateM1Trigger(market).keyFeatures.direction, "short");
  assert.equal(evaluateM1Trigger(market).keyFeatures.setup, "continuation");
  market.frames.find(frame => frame.interval === "1h").trend = "flat";
  assert.equal(evaluateM1Trigger(market).keyFeatures.setup, "reversal");
});

test("zone distance uses 15m ATR and accepts retested support while excluding broken or crossed zones", () => {
  const market = snapshot();
  const hourly = market.frames.find(frame => frame.interval === "1h");
  const [support] = hourly.zones;
  const retested = { ...support, id: "retested", kind: "resistance", status: "retested", lower: 9800, upper: 9900 };
  hourly.zones = [
    { ...support, status: "broken" },
    { ...support, id: "crossed", lower: 10001, upper: 10002 },
    retested,
  ];
  const result = evaluateM1Trigger(market);
  assert.equal(result.triggered, true);
  assert.equal(result.keyFeatures.zone.id, "retested");
  assert.equal(result.keyFeatures.zone.kind, "support");
  assert.equal(result.keyFeatures.zone.distanceAtr, 1);
  retested.upper = 9899;
  assert.equal(evaluateM1Trigger(market).triggered, false);
  assert.ok(evaluateM1Trigger(market).reasons.includes("no_near_zone"));
});

test("weak or unavailable volume, out-of-range ATR and incomplete frames fail the trigger", () => {
  const market = snapshot();
  const short = market.frames.find(frame => frame.interval === "15m");
  short.volumeRatio20 = 1.19;
  assert.equal(evaluateM1Trigger(market).score, 75);
  assert.equal(evaluateM1Trigger(market).triggered, false);
  short.volumeRatio20 = null;
  assert.ok(evaluateM1Trigger(market).reasons.includes("rvol_unavailable"));
  short.volumeRatio20 = 1.2;
  short.atrPct = 2;
  assert.equal(evaluateM1Trigger(market).triggered, true);
  short.atrPct = 2.01;
  const result = evaluateM1Trigger(market);
  assert.equal(result.score, 90);
  assert.equal(result.triggered, false);
  assert.equal(result.confidence, "low");
  assert.ok(result.reasons.includes("atr_out_of_range"));
  market.frames = [short];
  assert.deepEqual(evaluateM1Trigger(market).reasons, ["missing_analysis_frames"]);
});
