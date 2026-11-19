import { createHmac } from "node:crypto";
import { object, type OrderConfig } from "./order-auth.js";
import { AppError } from "./errors.js";
import { boundedJson } from "./http.js";
import { DECIMAL, type Grid, type OrderKind, type Quote, type TradingRules } from "./order-rules.js";

const SYMBOL = "BTCUSDT";
export interface ExchangeOrder {
  state: "accepted" | "rejected" | "unknown";
  exchangeStatus?: string; childStatus?: string; executedQty?: string; avgPrice?: string; exchangeCode?: number; upstreamStatus?: number; reason?: string;
}
export interface OrderExchange {
  rules(): Promise<TradingRules>;
  quote(): Promise<Quote>;
  query(kind: OrderKind, clientId: string): Promise<ExchangeOrder>;
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
  async function call(path: string, params: Record<string, string> = {}, signed = false) {
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = {};
    if (signed) {
      query.set("recvWindow", "3000");
      query.set("timestamp", String(now()));
      query.set("signature", createHmac("sha256", config.apiSecret).update(query.toString()).digest("hex"));
      headers["X-MBX-APIKEY"] = config.apiKey;
    }
    let response: Response;
    try {
      response = await fetchImpl(`${config.base}${path}${query.size ? `?${query}` : ""}`,
        { method: "GET", headers, signal: AbortSignal.timeout(4000), redirect: "error" });
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
  return {
    rules, quote,
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
