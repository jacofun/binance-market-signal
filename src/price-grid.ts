export function onPriceGrid(price: number, tickSize: number): boolean {
  const ticks = price / tickSize;
  return Number.isFinite(ticks) && ticks <= Number.MAX_SAFE_INTEGER / 8 &&
    Math.abs(Math.round(ticks) - ticks) <= Math.min(0.0001, 8 * Number.EPSILON * ticks);
}

export function tickPriceRange(lower: number, upper: number, tickSize: number) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  const [mantissa, exponent = "0"] = tickSize.toString().split("e");
  const decimals = Math.max(0, (mantissa?.split(".")[1]?.length ?? 0) - Number(exponent));
  if (decimals > 100) return null;
  const priceAt = (ticks: number) => Number((ticks * tickSize).toFixed(decimals));
  // The normalized value can be on the edge even when division falls between ticks.
  const below = Math.floor(lower / tickSize);
  const above = Math.ceil(upper / tickSize);
  const min = priceAt(priceAt(below) >= lower ? below : below + 1);
  const max = priceAt(priceAt(above) <= upper ? above : above - 1);
  return min > 0 && min >= lower && min <= max && max <= upper &&
    onPriceGrid(min, tickSize) && onPriceGrid(max, tickSize) ? { min, max } : null;
}
