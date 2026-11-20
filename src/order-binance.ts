import { createHmac } from "node:crypto";
import { object, type OrderConfig } from "./order-auth.js";
import { AppError } from "./errors.js";
import { boundedJson } from "./http.js";
import { DECIMAL, type Grid, type OrderKind, type OrderOption, type Quote, type TradingRules } from "./order-rules.js";

const SYMBOL = "BTCUSDT";
export type PositionSide = "LONG" | "SHORT";
export type ProtectionLeg = "stop" | "target";
const openingSide = (side: PositionSide) => side === "LONG" ? "BUY" : "SELL";
const closingSide = (side: PositionSide) => side === "LONG" ? "SELL" : "BUY";
const protectionType = (leg: ProtectionLeg) => leg === "stop" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
export interface ExchangeOrder {
  state: "accepted" | "rejected" | "unknown";
  exchangeStatus?: string; childStatus?: string; childOrderId?: string; executedQty?: string; avgPrice?: string;
  exchangeCode?: number; upstreamStatus?: number; reason?: string;
}
export interface OrderExchange {
  rules(): Promise<TradingRules>;
  quote(): Promise<Quote>;
  assertFlat(): Promise<void>;
  position(side: PositionSide, maxQuantity: string): Promise<number>;
  enter(side: PositionSide, quantity: string, clientId: string, issuedAt: number, option: OrderOption): Promise<ExchangeOrder>;
  findEntry(kind: OrderKind, clientId: string): Promise<ExchangeOrder | null>;
  cancelEntry(kind: "limit" | "conditional", clientId: string, entry: ExchangeOrder): Promise<void>;
  protect(side: PositionSide, leg: ProtectionLeg, trigger: string, clientId: string, issuedAt: number): Promise<string>;
  findProtection(side: PositionSide, leg: ProtectionLeg, trigger: string, clientId: string): Promise<string | null>;
  cancelProtection(clientId: string): Promise<void>;
  query(kind: OrderKind, clientId: string): Promise<ExchangeOrder>;
}

const id = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) || typeof v === "string") && /^[1-9]\d{0,18}$/.test(String(v)) ? String(v) : undefined;
const status = (v: unknown) => typeof v === "string" && /^[A-Z_]{2,32}$/.test(v) ? v : undefined;
function decimal(value: unknown, allowZero = false): value is string {
  return typeof value === "string" && DECIMAL.test(value) && (allowZero || Number(value) > 0);
}
const invalid = () => new AppError("ORDER_BINANCE_RESPONSE", "币安返回的委托校验数据不完整。", 502);
const untriggeredTerminal = new Set(["CANCELED", "CANCELLED", "EXPIRED", "REJECTED"]);
function parseOrder(data: unknown, clientId: string, algo: boolean): ExchangeOrder {
  if (!object(data) || data[algo ? "clientAlgoId" : "clientOrderId"] !== clientId || data.symbol !== SYMBOL ||
    !id(data[algo ? "algoId" : "orderId"])) throw invalid();
  const exchangeStatus = status(data[algo ? "algoStatus" : "status"]);
  if (!exchangeStatus) throw invalid();
  return { state: "accepted", exchangeStatus, ...(!algo && decimal(data.executedQty, true) ? { executedQty: data.executedQty } : {}),
    ...(!algo && decimal(data.avgPrice, true) ? { avgPrice: data.avgPrice } : {}) };
}

export function makeOrderExchange(config: OrderConfig, now: () => number, fetchImpl = fetch): OrderExchange {
  async function call(path: string, params: Record<string, string> = {}, signed = false, method: "GET" | "POST" | "DELETE" = "GET", issuedAt = now()) {
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = {};
    if (signed) {
      query.set("recvWindow", "3000");
      query.set("timestamp", String(issuedAt));
      query.set("signature", createHmac("sha256", config.apiSecret).update(query.toString()).digest("hex"));
      headers["X-MBX-APIKEY"] = config.apiKey;
    }
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response: Response;
    try {
      response = await fetchImpl(`${config.base}${path}${method !== "POST" && query.size ? `?${query}` : ""}`,
        { method, body: method === "POST" ? query.toString() : undefined, headers, signal: AbortSignal.timeout(4000), redirect: "error" });
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
  const bySymbol = { symbol: SYMBOL };
  async function positions() {
    const rows = await call("/fapi/v3/positionRisk", bySymbol, true);
    if (!Array.isArray(rows) || rows.some(row => !object(row) || row.symbol !== SYMBOL ||
      !["BOTH", "LONG", "SHORT"].includes(String(row.positionSide)) ||
      typeof row.positionAmt !== "string" || !DECIMAL.test(row.positionAmt.replace(/^-/, "")))) throw invalid();
    return rows as { positionSide: string; positionAmt: string }[];
  }
  function hasCode(error: unknown, ...codes: number[]) {
    const upstream = error instanceof AppError ? error.upstream : undefined;
    return upstream?.upstreamStatus === 400 && "upstreamCode" in upstream && codes.includes(Number(upstream.upstreamCode));
  }
  function readProtection(data: unknown, side: PositionSide, leg: ProtectionLeg, trigger: string, clientId: string) {
    const parsed = parseOrder(data, clientId, true);
    if (!object(data) || data.positionSide !== side || data.side !== closingSide(side) || data.orderType !== protectionType(leg) ||
      data.workingType !== "MARK_PRICE" || data.closePosition !== true ||
      !decimal(data.triggerPrice) || Number(data.triggerPrice) !== Number(trigger)) throw invalid();
    return parsed.exchangeStatus!;
  }
  async function assertFlat() {
    const [mode, current, normal, conditional] = await Promise.all([
      call("/fapi/v1/positionSide/dual", {}, true), positions(),
      call("/fapi/v1/openOrders", bySymbol, true), call("/fapi/v1/openAlgoOrders", bySymbol, true),
    ]);
    if (!object(mode) || typeof mode.dualSidePosition !== "boolean" || !Array.isArray(normal) || !Array.isArray(conditional)) throw invalid();
    if (!mode.dualSidePosition) throw new AppError("ORDER_HEDGE_MODE_REQUIRED", "本站仅支持 BTCUSDT 双向持仓模式。", 409);
    if (current.some(row => Number(row.positionAmt) !== 0) || normal.length || conditional.length) {
      throw new AppError("ORDER_ACCOUNT_BUSY", "BTCUSDT 已有持仓或挂单，请先核对账户。", 409);
    }
  }
  return {
    rules, quote, assertFlat,
    async position(side, maxQuantity) {
      const current = await positions();
      const row = current.find(item => item.positionSide === side);
      const qty = Number(row?.positionAmt ?? 0) * (side === "LONG" ? 1 : -1);
      if (qty < 0 || qty > Number(maxQuantity) || current.some(item => item.positionSide !== side && Number(item.positionAmt) !== 0)) {
        throw new AppError("ORDER_POSITION_MISMATCH", "当前 BTCUSDT 持仓与本次开仓不符。请核对账户。", 409);
      }
      return qty;
    },
    async enter(side, quantity, clientId, issuedAt, option) {
      try {
        const common = { ...bySymbol, side: openingSide(side), positionSide: side, quantity };
        if (option.kind === "conditional") {
          if (!option.triggerPrice) throw invalid();
          const data = await call("/fapi/v1/algoOrder", { ...common, type: "STOP", algoType: "CONDITIONAL", timeInForce: "GTC",
            clientAlgoId: clientId, price: option.price, triggerPrice: option.triggerPrice, workingType: "MARK_PRICE" }, true, "POST", issuedAt);
          if (!object(data) || data.positionSide !== side || data.side !== openingSide(side) || data.orderType !== "STOP") throw invalid();
          return parseOrder(data, clientId, true);
        }
        const immediate = option.timeInForce === "IOC";
        const params: Record<string, string> = option.kind === "market" ? { type: "MARKET", newOrderRespType: "RESULT" } :
          { type: "LIMIT", timeInForce: immediate ? "IOC" : "GTX", price: option.price, newOrderRespType: immediate ? "RESULT" : "ACK" };
        const data = await call("/fapi/v1/order", { ...common, ...params, newClientOrderId: clientId }, true, "POST", issuedAt);
        if (!object(data) || data.positionSide !== side || data.side !== openingSide(side) ||
          (option.kind === "market" || immediate) && !decimal(data.executedQty, true)) throw invalid();
        return parseOrder(data, clientId, false);
      } catch (error) {
        if (!hasCode(error, -1013, -1021, -1022, -1100, -1102, -1111, -1116, -1121, -2019, -2021, -4061, -4164, -5022)) throw error;
        const upstream = (error as AppError).upstream;
        return { state: "rejected", exchangeCode: Number(upstream && "upstreamCode" in upstream ? upstream.upstreamCode : undefined) };
      }
    },
    async findEntry(kind, clientId) {
      try { return await this.query(kind, clientId); }
      catch (error) { if (hasCode(error, -2013)) return null; throw error; }
    },
    async cancelEntry(kind, clientId, entry) {
      try {
        if (kind === "limit") await call("/fapi/v1/order", { ...bySymbol, origClientOrderId: clientId }, true, "DELETE");
        if (kind === "conditional" && entry.childOrderId) {
          await call("/fapi/v1/order", { ...bySymbol, orderId: entry.childOrderId }, true, "DELETE");
        } else if (kind === "conditional" && entry.exchangeStatus === "NEW") {
          await call("/fapi/v1/algoOrder", { clientAlgoId: clientId }, true, "DELETE");
        }
      } catch (error) { if (!hasCode(error, -2013, -2011)) throw error; }
    },
    async protect(side, leg, trigger, clientId, issuedAt) {
      const data = await call("/fapi/v1/algoOrder", { ...bySymbol, side: closingSide(side), positionSide: side, algoType: "CONDITIONAL",
        type: protectionType(leg), triggerPrice: trigger, workingType: "MARK_PRICE", closePosition: "true", clientAlgoId: clientId },
        true, "POST", issuedAt);
      return readProtection(data, side, leg, trigger, clientId);
    },
    async findProtection(side, leg, trigger, clientId) {
      try {
        return readProtection(await call("/fapi/v1/algoOrder", { clientAlgoId: clientId }, true), side, leg, trigger, clientId);
      } catch (error) { if (hasCode(error, -2013, -2011)) return null; throw error; }
    },
    async cancelProtection(clientId) {
      try { await call("/fapi/v1/algoOrder", { clientAlgoId: clientId }, true, "DELETE"); }
      catch (error) { if (!hasCode(error, -2013, -2011)) throw error; }
    },
    async query(kind, clientId) {
      const algo = kind === "conditional";
      const data = await call(algo ? "/fapi/v1/algoOrder" : "/fapi/v1/order", algo ? { clientAlgoId: clientId } :
        { symbol: SYMBOL, origClientOrderId: clientId }, true);
      const order = parseOrder(data, clientId, algo);
      if (algo && object(data)) {
        const childOrderId = id(data.actualOrderId);
        if (childOrderId) {
          const child = await call("/fapi/v1/order", { symbol: SYMBOL, orderId: childOrderId }, true)
            .catch(error => { if (hasCode(error, -2013)) return null; throw error; });
          if (!child) return { ...order, childOrderId };
          if (!object(child) || id(child.orderId) !== childOrderId || child.symbol !== SYMBOL ||
            child.side !== data.side || child.positionSide !== data.positionSide ||
            !status(child.status) || !decimal(child.executedQty, true)) throw invalid();
          return { ...order, childOrderId, childStatus: child.status as string, executedQty: child.executedQty,
            ...(decimal(child.avgPrice, true) ? { avgPrice: child.avgPrice } : {}) };
        }
        if (data.actualOrderId === "" && Number(data.triggerTime) === 0 && untriggeredTerminal.has(order.exchangeStatus!)) {
          return { ...order, executedQty: "0" };
        }
      }
      return order;
    },
  };
}
