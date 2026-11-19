import { createHmac } from "node:crypto";
import { object, type OrderConfig } from "./order-auth.js";
import { AppError } from "./errors.js";
import { boundedJson } from "./http.js";
import { DECIMAL, TYPES, type Grid, type OrderOption, type Quote, type TradingRules } from "./order-rules.js";

const SYMBOL = "BTCUSDT";
export type Side = "BUY" | "SELL";
export type PositionSide = "BOTH" | "LONG" | "SHORT";
export interface ExchangeOrder {
  state: "accepted" | "rejected" | "unknown";
  exchangeStatus?: string; childStatus?: string; executedQty?: string; avgPrice?: string; exchangeCode?: number; upstreamStatus?: number; reason?: string;
}
export interface OrderExchange {
  rules(): Promise<TradingRules>;
  quote(): Promise<Quote>;
  account(side: Side): Promise<PositionSide>;
  place(option: OrderOption, side: Side, positionSide: PositionSide, clientId: string): Promise<ExchangeOrder>;
  query(kind: OrderOption["kind"], clientId: string): Promise<ExchangeOrder>;
}

const id = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) || typeof v === "string") && /^[1-9]\d{0,18}$/.test(String(v)) ? String(v) : undefined;
const status = (v: unknown) => typeof v === "string" && /^[A-Z_]{2,32}$/.test(v) ? v : undefined;
function decimal(value: unknown, allowZero = false): value is string {
  return typeof value === "string" && DECIMAL.test(value) && (allowZero || Number(value) > 0);
}
const invalid = () => new AppError("ORDER_BINANCE_RESPONSE", "币安返回的委托校验数据不完整。", 502);
function parseOrder(data: unknown, clientId: string, algo: boolean): ExchangeOrder {
  if (!object(data) || data[algo ? "clientAlgoId" : "clientOrderId"] !== clientId || data.symbol !== SYMBOL ||
    !id(data[algo ? "algoId" : "orderId"])) throw invalid();
  const exchangeStatus = status(data[algo ? "algoStatus" : "status"]);
  if (!exchangeStatus) throw invalid();
  return { state: "accepted", exchangeStatus, ...(decimal(data.executedQty, true) ? { executedQty: data.executedQty } : {}),
    ...(decimal(data.avgPrice, true) ? { avgPrice: data.avgPrice } : {}) };
}

export function makeOrderExchange(config: OrderConfig, now: () => number, fetchImpl = fetch): OrderExchange {
  async function call(path: string, params: Record<string, string> = {}, signed = false, method = "GET") {
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = {};
    if (signed) {
      query.set("recvWindow", "3000");
      query.set("timestamp", String(now()));
      query.set("signature", createHmac("sha256", config.apiSecret).update(query.toString()).digest("hex"));
      headers["X-MBX-APIKEY"] = config.apiKey;
    }
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response: Response;
    try {
      response = await fetchImpl(`${config.base}${path}${method === "GET" && query.size ? `?${query}` : ""}`,
        { method, headers, body: method === "POST" ? query.toString() : undefined, signal: AbortSignal.timeout(4000), redirect: "error" });
    } catch (cause) {
      throw new AppError("ORDER_BINANCE_UNAVAILABLE", `币安接口 ${path} 连接失败。`, 502, undefined, undefined, { cause });
    }
    let data: unknown;
    try { data = await boundedJson(response, path.endsWith("/exchangeInfo") ? 4 * 1024 * 1024 : 256 * 1024, "ORDER_BINANCE_RESPONSE"); }
    catch (cause) { throw new AppError("ORDER_BINANCE_RESPONSE", `币安接口 ${path} 响应无法读取。`, 502, undefined, { upstreamStatus: response.status }, { cause }); }
    if (!response.ok || object(data) && typeof data.code === "number" && data.code < 0) {
      const code = object(data) && Number.isSafeInteger(data.code) && Number(data.code) < 0 ? String(data.code) : undefined;
      throw new AppError("ORDER_BINANCE_ERROR", `币安接口 ${path} 返回错误。`, 502, undefined,
        { upstreamStatus: response.status, ...(code ? { upstreamCode: code } : {}) });
    }
    return data;
  }
  async function quote(): Promise<Quote> {
    const [mark, book] = await Promise.all([
      call("/fapi/v1/premiumIndex", { symbol: SYMBOL }),
      call("/fapi/v1/ticker/bookTicker", { symbol: SYMBOL }),
    ]);
    if (!object(mark) || mark.symbol !== SYMBOL || !decimal(mark.markPrice) || !Number.isSafeInteger(mark.time) ||
      !object(book) || book.symbol !== SYMBOL || !decimal(book.bidPrice) || !decimal(book.askPrice) ||
      Number(book.bidPrice) >= Number(book.askPrice) || !decimal(book.bidQty, true) || !decimal(book.askQty, true) ||
      !Number.isSafeInteger(book.time)) throw invalid();
    return { mark: mark.markPrice, markTime: Number(mark.time), bid: book.bidPrice, ask: book.askPrice,
      bidQty: book.bidQty, askQty: book.askQty, bookTime: Number(book.time) };
  }
  async function rules(): Promise<TradingRules> {
    const exchange = await call("/fapi/v1/exchangeInfo");
    if (!object(exchange) || !Array.isArray(exchange.symbols)) throw invalid();
    const symbol: unknown = exchange.symbols.find(s => object(s) && s.symbol === SYMBOL);
    if (!object(symbol) || symbol.contractType !== "PERPETUAL" || symbol.status !== "TRADING" ||
      symbol.baseAsset !== "BTC" || symbol.quoteAsset !== "USDT" || !Array.isArray(symbol.orderTypes) ||
      !Array.isArray(symbol.timeInForce) || !Array.isArray(symbol.filters)) throw invalid();
    const filters = symbol.filters.filter(object);
    const get = (type: string) => filters.find(f => f.filterType === type);
    const grid = (type: string, names: [string, string, string]): Grid => {
      const f = get(type);
      const [min, max, step] = names.map(n => f?.[n]);
      if (!decimal(min, true) || !decimal(max, true) || !decimal(step, true)) throw invalid();
      return { min, max, step };
    };
    const qtyNames: [string, string, string] = ["minQty", "maxQty", "stepSize"];
    const notional = get("MIN_NOTIONAL")?.notional;
    const { multiplierUp, multiplierDown } = get("PERCENT_PRICE") ?? {};
    if (!decimal(notional) || !decimal(multiplierUp) || !decimal(multiplierDown)) throw invalid();
    return { kinds: symbol.orderTypes.filter((v): v is string => typeof v === "string"),
      times: symbol.timeInForce.filter((v): v is string => typeof v === "string"),
      price: grid("PRICE_FILTER", ["minPrice", "maxPrice", "tickSize"]),
      lot: grid("LOT_SIZE", qtyNames), marketLot: grid("MARKET_LOT_SIZE", qtyNames), notional, multiplierUp, multiplierDown };
  }
  async function account(side: Side): Promise<PositionSide> {
    const bySymbol = { symbol: SYMBOL };
    const [mode, positions, openOrders, algoOrders] = await Promise.all([
      call("/fapi/v1/positionSide/dual", {}, true),
      call("/fapi/v3/positionRisk", bySymbol, true),
      call("/fapi/v1/openOrders", bySymbol, true),
      call("/fapi/v1/openAlgoOrders", bySymbol, true),
    ]);
    if (!object(mode) || typeof mode.dualSidePosition !== "boolean" || !Array.isArray(positions) ||
      !Array.isArray(openOrders) || !Array.isArray(algoOrders) ||
      positions.some(row => !object(row) || row.symbol !== SYMBOL || typeof row.positionAmt !== "string" ||
        !DECIMAL.test(row.positionAmt.replace(/^-/, "")))) throw invalid();
    if (positions.some(row => Number(row.positionAmt) !== 0) || openOrders.length || algoOrders.length) {
      throw new AppError("ORDER_ACCOUNT_BUSY", "该交易对已有持仓、普通挂单或条件挂单，暂不能通过本站开仓。", 409);
    }
    // In hedge mode an opening-side order cannot reduce an opposite-side position
    // that appears between the account snapshot and order acceptance.
    if (!mode.dualSidePosition) throw new AppError("ORDER_HEDGE_MODE_REQUIRED", "本站开仓仅支持币安双向持仓模式，请在币安核对账户设置。", 409);
    return side === "BUY" ? "LONG" : "SHORT";
  }
  return {
    rules, quote, account,
    async place(option, side, positionSide, clientId) {
      const algo = option.kind === "conditional";
      const params: Record<string, string> = { symbol: SYMBOL, side, positionSide, type: TYPES[option.kind], quantity: config.quantity };
      if (algo) Object.assign(params, { algoType: "CONDITIONAL", clientAlgoId: clientId, timeInForce: "GTC", price: option.price,
        triggerPrice: option.triggerPrice!, workingType: "MARK_PRICE" });
      else {
        params.newClientOrderId = clientId;
        if (option.kind === "limit") Object.assign(params, { timeInForce: "GTX", price: option.price });
        if (option.kind === "market") params.newOrderRespType = "RESULT";
      }
      try { return parseOrder(await call(algo ? "/fapi/v1/algoOrder" : "/fapi/v1/order", params, true, "POST"), clientId, algo); }
      catch (error) {
        const upstream = error instanceof AppError ? error.upstream : undefined;
        const exchangeCode = upstream && "upstreamCode" in upstream ? Number(upstream.upstreamCode) : undefined;
        // Only explicit, known order rejections may unlock another submission.
        const rejected = upstream?.upstreamStatus === 400 && exchangeCode !== undefined &&
          [-1013, -1021, -1022, -1100, -1102, -1111, -1116, -1121, -2019, -2021, -2022, -4061, -4164, -5022].includes(exchangeCode);
        return { state: rejected ? "rejected" : "unknown", ...(Number.isSafeInteger(exchangeCode) ? { exchangeCode } : {}),
          ...(upstream ? { upstreamStatus: upstream.upstreamStatus } : {}), reason: error instanceof AppError ? error.code : "INTERNAL_ERROR" };
      }
    },
    async query(kind, clientId) {
      const algo = kind === "conditional";
      const data = await call(algo ? "/fapi/v1/algoOrder" : "/fapi/v1/order", algo ? { clientAlgoId: clientId } :
        { symbol: SYMBOL, origClientOrderId: clientId }, true);
      const order = parseOrder(data, clientId, algo);
      if (algo && object(data) && id(data.actualOrderId)) {
        const child = await call("/fapi/v1/order", { symbol: SYMBOL, orderId: id(data.actualOrderId)! }, true)
          .catch(() => null);
        if (object(child) && String(child.orderId) === String(data.actualOrderId) && child.symbol === SYMBOL &&
          status(child.status) && decimal(child.executedQty, true) && decimal(child.avgPrice, true)) {
          return { ...order, childStatus: child.status as string, executedQty: child.executedQty, avgPrice: child.avgPrice };
        }
      }
      return order;
    },
  };
}
