import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../build/analysis.js";
import { loadConfig } from "../build/config.js";
import { atrSeries, historicalRanges, openInterestChanges, volumeBars, volumeWindows } from "../build/features.js";
import { priceZones } from "../build/price-zones.js";
import { assessResearch, researchContext } from "../build/research.js";
import { validateProposal } from "../build/model.js";
import { env, modelResult, NOW, proposal, provider, snapshot } from "./fixtures.mjs";

const hour = 3_600_000;
const start = NOW - 200 * hour;
const bar = (i, options = {}) => ({ openTime: start + i * hour, closeTime: start + (i + 1) * hour - 1,
  open: 100, high: 102, low: 98, close: 100, volume: 10, takerBuyVolume: 4, ...options });
const bars = (n, options) => Array.from({ length: n }, (_, i) => bar(i, options));

test("candle features use prior close and prior 20 volumes, with defined flat and missing states", () => {
  const history = bars(20);
  const data = [...history, bar(20, { open: 100, high: 112, low: 98, close: 99, volume: 30, takerBuyVolume: 18 })];
  const features = volumeBars(data);
  assert.equal(features[0].closeChangePct, null);
  assert.equal(features[19].volumeRatio20, null);
  const latest = features[20];
  assert.ok(Math.abs(latest.rangePct - 14) < 1e-12);
  assert.equal(latest.upperWickShare, 12 / 14);
  assert.equal(latest.lowerWickShare, 1 / 14);
  assert.equal(latest.bodyShare, 1 / 14);
  assert.equal(latest.clv, -12 / 14);
  assert.equal(latest.volumeRatio20, 3);
  assert.equal(latest.takerBuyShare, 0.6);
  assert.equal(latest.newHigh20, true);
  assert.deepEqual(latest.observations, ["high_volume_down", "high_volume_upper_rejection"]);
  assert.deepEqual(volumeBars([...data, bar(21, { volume: 10_000 })]).slice(0, 21), features);
  const flat = volumeBars(bars(21, { high: 100, low: 100, volume: 0, takerBuyVolume: 0 })).at(-1);
  for (const key of ["volumeRatio20", "takerBuyShare", "clv", "bodyShare", "lowerWickShare", "upperWickShare"]) assert.equal(flat[key], null);
  assert.equal(flat.rangePct, 0);
});

test("low-volume countertrend tags require a prior EMA alignment", () => {
  const trendBars = bars(55).map((row, i) => {
    const close = 100 + i;
    return { ...row, close, open: close, high: close + 1, low: close - 1 };
  });
  const pullback = { ...bar(55), close: 153, open: 154, high: 155, low: 152, volume: 5, takerBuyVolume: 2 };
  const history = [...trendBars, pullback];
  const observed = volumeBars(history).at(-1);
  assert.deepEqual(observed.observations, ["low_volume_down", "low_volume_pullback_in_uptrend"]);
  assert.deepEqual(volumeBars(history.slice(-25)).at(-1).observations, ["low_volume_down"]);
});

test("volume windows are weighted by observed volume and compare equal-length periods", () => {
  const data = bars(100);
  data.splice(95, 5, ...bars(5, { volume: 20, takerBuyVolume: 12 }));
  const [five, twenty, fifty] = volumeWindows(data);
  assert.equal(five.meanVolume, 20);
  assert.equal(five.volumeChangePct, 100);
  assert.ok(Math.abs(five.takerBuyChangePp - 20) < 1e-10);
  assert.equal(twenty.meanVolume, 12.5);
  assert.equal(fifty.meanVolume, 11);
  assert.equal(volumeWindows(data.slice(0, 60))[2].volumeChangePct, null);
});

test("Wilder ATR handles gaps, zero ranges, and is unchanged by later candles", () => {
  const data = bars(17);
  data[15] = bar(15, { open: 110, high: 112, low: 109, close: 111 });
  assert.equal(atrSeries(data)[13], null);
  assert.equal(atrSeries(data)[14], 4);
  assert.equal(atrSeries(data)[15], (4 * 13 + 12) / 14);
  assert.deepEqual(atrSeries(data).slice(0, 16), atrSeries(data.slice(0, 16)));
  assert.equal(atrSeries(bars(15, { high: 100, low: 100 })).at(-1), 0);
});

test("zones require two close confirmations, use historical ATR, and enforce a non-chained cluster width", () => {
  const data = bars(36);
  data[20] = bar(20, { high: 110 });
  data[25] = bar(25, { high: 111.5 });
  data[30] = bar(30, { high: 113 });
  const compute = (count, unit = 4) => {
    const sample = data.slice(0, count);
    return priceZones(sample, "1h", sample.map(() => unit), volumeBars(sample));
  };
  assert.equal(compute(22).length, 0);
  const [first] = compute(23);
  assert.equal(first.confirmedAt, data[22].closeTime + 1);
  assert.equal(first.lower, 109.4);
  const [merged, distinct] = compute(36);
  assert.equal(merged.id, first.id);
  assert.equal(merged.pivotCount, 2);
  assert.equal(merged.upper, 112.1);
  assert.equal(distinct.pivotCount, 1);
  assert.equal(compute(36, 2).length, 3);
  assert.deepEqual(compute(36, 0), []);
});

test("confirmed zone distinguishes volume breakout, held closes, retest and failure", () => {
  const data = bars(30);
  data[20] = bar(20, { high: 110 });
  data[24] = bar(24, { open: 111, high: 114, low: 111, close: 113, volume: 20 });
  data[25] = bar(25, { open: 113, high: 114, low: 111, close: 113 });
  data[26] = bar(26, { open: 112, high: 114, low: 110, close: 113, volume: 5 });
  data[27] = bar(27, { open: 110, high: 110, low: 107, close: 108 });
  const lookup = count => {
    const sample = data.slice(0, count);
    return priceZones(sample, "1h", sample.map(() => 4), volumeBars(sample)).find(z => z.firstPivotTime === data[20].openTime);
  };
  assert.equal(lookup(24).status, "active");
  assert.equal(lookup(25).status, "broken");
  assert.equal(lookup(26).closesBeyondBreak, 2);
  assert.equal(lookup(26).breakRvol20, 2);
  assert.equal(lookup(27).status, "retested");
  assert.equal(lookup(27).lastRetestTime, data[26].openTime);
  assert.ok(lookup(27).lastRetestRvol20 < 0.75);
  assert.equal(lookup(28).status, "active");
});

test("OI only compares matching prior close times at the observation boundary", () => {
  const market = snapshot();
  market.asOf = start + 3 * hour;
  market.frames[1].trend = "down";
  market.frames[1].recentCandles = [bar(0), bar(1, { close: 101 }), bar(2, { close: 102 }), bar(3)];
  market.openInterest = [100, 110, 0, 200].map((contracts, i) => ({ time: start + (i + 1) * hour, contracts, notional: contracts * 100 }));
  const changes = openInterestChanges(market);
  assert.equal(changes.length, 2);
  assert.ok(Math.abs(changes[0].contractsChangePct - 10) < 1e-10);
  assert.deepEqual(changes[0].combination, { oi: "up", price: "up" });
  assert.deepEqual(changes[1].combination, { oi: "down", price: "up" });
  market.openInterest[0].time--;
  assert.equal(openInterestChanges(market).length, 1);
  assert.equal(researchContext(market).alignment, "conflict");
});

test("range distributions use disjoint windows entirely before the snapshot", () => {
  const data = bars(25);
  const all = historicalRanges(data, hour);
  assert.equal(all[4].long.samples, 6);
  assert.equal(all[12].long.samples, 2);
  assert.equal(all[24].short.samples, 1);
  assert.ok(Math.abs(all[24].short.favorableMovePct.p90 - 2) < 1e-10);
  assert.equal(historicalRanges(data.slice(1), hour)[24].short.favorableMovePct, null);
});

test("structural validation enforces tick grid, stop reference roles and near obstacles", () => {
  const market = snapshot();
  const target = { zoneId: "up", reason: "区内参考", price: 10199.8 };
  const accepted = validateProposal(proposal({ targets: [target] }), market);
  assert.equal(accepted.targets[0].price, target.price);
  assert.throws(() => validateProposal(proposal({ targets: [{ ...target, price: 10199.81 }] }), market),
    { upstream: { outputReason: "price_precision", outputField: "entry/stopLoss/targets" } });
  assert.throws(() => validateProposal(proposal({ targets: [{ ...target, zoneId: "invented" }] }), market),
    { upstream: { outputReason: "unsupported_target", outputField: "targets[0].price" } });
  for (const stopLoss of [9800, 9985]) assert.equal(validateProposal(proposal({ stopLoss }), market).stopLoss, stopLoss);
  const wrongStopZone = proposal();
  wrongStopZone.research.stopZoneId = "up";
  assert.throws(() => validateProposal(wrongStopZone, market),
    { upstream: { outputReason: "unsupported_zone", outputField: "research.stopZoneId" } });
  const near = { id: "near", lower: 10100, upper: 10140, kind: "resistance", interval: "1h", touches: 2, status: "active" };
  market.frames[1].zones.push(near);
  assert.throws(() => validateProposal(accepted, market), { upstream: { outputReason: "target_obstacle", outputField: "targets[0].price" } });
  const nearTarget = { zoneId: "near", reason: "前方阻力", price: 10120 };
  const withNear = validateProposal(proposal({ targets: [nearTarget, target] }), market);
  const assessed = assessResearch(market, withNear);
  assert.deepEqual(assessed.targetAssessment[1].obstacles, ["short-stop", "near"]);
  assert.equal(assessed.targetAssessment[0].rewardRisk, 1);
  assert.equal(assessed.targetAssessment[0].atr14Multiple, 1.1);
});

test("watch can omit a plan and the long research window never extends short-term validity", async () => {
  const empty = proposal({ status: "watch", direction: null, entry: null, stopLoss: null, targets: [] });
  assert.equal(validateProposal(empty, snapshot()).status, "watch");
  let now = NOW;
  const proposed = proposal();
  proposed.research.researchHorizon = 24;
  proposed.validForSeconds = 30;
  const result = await analyze(loadConfig(env), provider({ quote: async () => ({ ...snapshot().quote, time: now }) }), "BTCUSDT", "trend",
    AbortSignal.timeout(1000), async () => { now += 31_000; return modelResult(proposed); }, () => now);
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.status, "expired");
  assert.equal(result.research.researchHorizon, 24);
  assert.equal(result.timing.validUntil, NOW + 30_000);
});
