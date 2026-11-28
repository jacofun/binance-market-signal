import assert from "node:assert/strict";
import test from "node:test";
import { evaluateM1Trigger } from "../build/m1-trigger.js";
import { deterministicProposal, generateM2Order } from "../build/m2-order.js";
import { validateProposal } from "../build/model.js";
import { m2Snapshot, snapshot } from "./fixtures.mjs";

const hourly = market => market.frames.find(frame => frame.interval === "1h");
const short = market => market.frames.find(frame => frame.interval === "15m");

test("deterministic long order uses the M1 zone, tick-aligned prices and the adverse entry for R", () => {
  const market = m2Snapshot();
  const first = hourly(market).zones.find(zone => zone.id === "up");
  first.lower = 10180.04;
  hourly(market).zones.push({ ...first, id: "second", lower: 10400, upper: 10500 });
  const trigger = evaluateM1Trigger(market, "trend");
  const order = generateM2Order(market, trigger, "trend");
  assert.ok(trigger.triggered);
  assert.equal(order.direction, "long");
  assert.deepEqual(order.entryRange, { min: 9985, max: 10020 });
  assert.equal(order.stopLoss, 9935);
  assert.equal(order.keyFeatures.riskDistance, 85);
  assert.equal(order.keyFeatures.entryZoneId, "entry");
  assert.deepEqual(order.takeProfits, [
    { price: 10180.1, zoneId: "up", rMultiple: (10180.1 - 10020) / 85 },
    { price: 10400, zoneId: "second", rMultiple: (10400 - 10020) / 85 },
  ]);
  assert.equal(order.riskReward, order.takeProfits[0].rMultiple);
  assert.deepEqual(generateM2Order(market, trigger, "trend"), order);
  assert.equal(validateProposal(deterministicProposal(market, trigger, order), market).status, "candidate");
});

test("short proposals round toward the inside of target zones and beyond the stop", () => {
  const market = m2Snapshot();
  const [zone] = hourly(market).zones;
  hourly(market).zones = [
    { ...zone, id: "short-entry", kind: "resistance", upper: 10020.04 },
    { ...zone, id: "first-support", lower: 9779.96, upper: 9820.04 },
    { ...zone, id: "second-support", lower: 9600, upper: 9700 },
  ];
  for (const frame of market.frames) frame.trend = "down";
  short(market).volumePrice[0].closeChangePct = -0.5;
  const trigger = evaluateM1Trigger(market);
  const order = generateM2Order(market, trigger);
  assert.equal(order.direction, "short");
  assert.deepEqual(order.entryRange, { min: 9980, max: 10015 });
  assert.equal(order.stopLoss, 10065);
  assert.deepEqual(order.takeProfits.map(target => target.price), [9820, 9700]);
  assert.equal(validateProposal(deterministicProposal(market, trigger, order), market).direction, "short");
});

test("missing, stale or incompatible triggers and broken or tickless entry zones produce no order", () => {
  const market = m2Snapshot();
  const trigger = evaluateM1Trigger(market);
  assert.equal(generateM2Order(market, { ...trigger, triggered: false }), null);
  assert.equal(generateM2Order(market, trigger, "reversal"), null);
  assert.equal(generateM2Order({ ...market, asOf: market.asOf + 1 }, trigger), null);
  const [zone] = hourly(market).zones;
  zone.status = "broken";
  assert.equal(generateM2Order(market, trigger), null);
  Object.assign(zone, { status: "active", lower: 9999.94, upper: 9999.96 });
  assert.equal(generateM2Order(market, trigger), null);
});

test("M2 holds the structural range and stop constant as the mark moves", () => {
  const market = m2Snapshot();
  const trigger = evaluateM1Trigger(market);
  const base = generateM2Order(market, trigger);
  market.quote.price = 10090;
  const waiting = generateM2Order(market, trigger);
  assert.deepEqual(waiting.entryRange, base.entryRange);
  assert.equal(waiting.stopLoss, base.stopLoss);
  assert.deepEqual(waiting.takeProfits, base.takeProfits);
  market.quote.price = 9979.9;
  assert.equal(generateM2Order(market, trigger), null);
  market.quote.price = base.takeProfits[0].price;
  assert.equal(generateM2Order(market, trigger), null);
});

test("M2 trims the unfavorable edge to 1.5R and rejects a target even one tick too close", () => {
  const market = m2Snapshot();
  const trigger = evaluateM1Trigger(market);
  const first = hourly(market).zones.find(item => item.id === "up");
  first.lower = 10120;
  assert.deepEqual(generateM2Order(market, trigger).entryRange, { min: 9985, max: 10009 });
  assert.equal(generateM2Order(market, trigger).riskReward, 1.5);
  first.lower = 10060;
  assert.deepEqual(generateM2Order(market, trigger).entryRange, { min: 9985, max: 9985 });
  first.lower = 10059.9;
  assert.equal(generateM2Order(market, trigger), null);
});

test("M2 neither invents targets nor skips a closer zone to obtain a higher R", () => {
  const market = snapshot();
  const trigger = evaluateM1Trigger(market);
  assert.ok(trigger.triggered);
  assert.equal(generateM2Order(market, trigger), null);
  hourly(market).zones = hourly(market).zones.filter(zone => zone.kind === "support");
  assert.equal(generateM2Order(market, trigger), null);
  hourly(market).zones.push({ ...hourly(market).zones[0], id: "far", kind: "resistance", lower: 10700, upper: 10800 });
  assert.equal(generateM2Order(market, trigger), null);
  hourly(market).zones[3].lower = 10200;
  hourly(market).zones.push({ ...hourly(market).zones[3], id: "tickless-obstacle", lower: 10150.01, upper: 10150.04, touches: 2 });
  assert.equal(generateM2Order(market, trigger), null);
});

test("M2 reports an empty intersection instead of skipping a nearby target", () => {
  const market = m2Snapshot();
  const trigger = evaluateM1Trigger(market);
  const messages = [];
  const evaluate = () => generateM2Order(market, trigger, undefined, reason => messages.push(reason));
  assert.deepEqual(evaluate(), generateM2Order(market, trigger));
  assert.equal(messages.length, 0);
  const [support] = hourly(market).zones;
  hourly(market).zones.push({ ...support, id: "retested", status: "retested", lower: 10059.9, upper: 10100 });
  assert.equal(evaluate(), null);
  assert.match(messages.pop(), /止损 9935.*目标 10059\.9.*没有达到 1\.50R/);
});
