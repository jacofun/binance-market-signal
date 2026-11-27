import assert from "node:assert/strict";
import test from "node:test";
import { closedTradeOutcome } from "../build/trade-result-log.js";

test("closed results are direction-aware and require a matching confirmed exit quantity", () => {
  const entry = { state: "accepted", exchangeStatus: "FILLED", executedQty: "0.002", avgPrice: "10000", updatedAt: 10000 };
  const exit = { state: "accepted", childStatus: "FILLED", executedQty: "0.002", avgPrice: "9800", updatedAt: 20000 };
  const close = (order, side = "SHORT") => closedTradeOutcome(entry, [{ leg: "target", order }], side, "10100");
  const result = close(exit);
  assert.equal(result.finalStatus, "win");
  assert.equal(result.grossRealizedPnlUsdt, 0.4);
  assert.equal(result.rMultiple, 2);
  assert.equal(result.holdingDurationMs, 10000);
  assert.equal(close(exit, "LONG").finalStatus, "loss");
  assert.equal(close({ ...exit, avgPrice: "10000" }).finalStatus, "breakeven");
  assert.equal(close({ ...exit, executedQty: "0.001" }).finalStatus, null);
  assert.equal(close({ ...exit, childStatus: "NEW" }).finalStatus, null);
});
