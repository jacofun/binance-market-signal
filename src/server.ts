import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { AppError, publicError } from "./errors.js";
import { makeAuthorizer, TOKEN_HEADER } from "./auth.js";
import { loadConfig, type Config, type Env } from "./config.js";
import { RestMarketDataProvider } from "./market.js";
import { WebSocketMarketDataProvider } from "./websocket-market.js";
import { analyze, type Model } from "./analysis.js";
import type { MarketDataProvider, Style } from "./types.js";
import { SOURCE_COMMIT } from "./version.js";

const ORIGINS = new Set(["https://yanxiao.me", "https://www.yanxiao.me"]);
const ALLOWED_HEADERS = new Set(["x-jwt-token", "content-type", "accept"]);
const ANALYSIS_PATHS = new Set(["/", "/analyze", "/trade/api/signal", "/trade/api/signal/analyze"]);
const HEALTH_PATHS = new Set(["/", "/health", "/trade/api/signal", "/trade/api/signal/health"]);
async function body(req: IncomingMessage, ramProbe = false): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] || "";
  if (!/^application\/json(?:\s*;|$)/i.test(type) && !(ramProbe && /^application\/octet-stream(?:\s*;|$)/i.test(type))) throw new AppError("UNSUPPORTED_MEDIA_TYPE", "请使用 application/json。", 415);
  if (Number(req.headers["content-length"] || 0) > 4096) throw new AppError("BODY_TOO_LARGE", "请求体超过 4 KiB。", 413);
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new AppError("BODY_TOO_LARGE", "请求体超过 4 KiB。", 413);
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new AppError("INVALID_REQUEST", "请求体必须为 JSON 对象。", 400); }
}
function health() { return { status: "ok", service: "binance-market-signal", codeVersion: SOURCE_COMMIT, nodeMajor: Number(process.versions.node.split(".")[0]) }; }
export function makeServer({ env = process.env, provider, model, now = Date.now, logger = console }: {
  env?: Env; provider?: MarketDataProvider; model?: Model; now?: () => number;
  logger?: Pick<Console, "info" | "error">;
} = {}) {
  const authorize = makeAuthorizer(env);
  let config: Config | undefined;
  let market = provider;
  let active = false;
  const cooldowns = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const origin = req.headers.origin;
    const cors = origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {};
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId, Vary: "Origin", ...cors };
    const send = (status: number, value: unknown, extra: Record<string, string> = {}) => {
      if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { ...headers, ...extra }); res.end(value === null ? "" : JSON.stringify(value)); }
    };
    let acquired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableEnded) abort.abort(); };
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
      if (url.search) throw new AppError("INVALID_REQUEST", "接口不接受查询参数。", 400);
      if (HEALTH_PATHS.has(path) && (req.method === "GET" || req.method === "HEAD")) { send(200, req.method === "HEAD" ? null : health()); return; }
      if (!ANALYSIS_PATHS.has(path) && path !== "/invoke") throw new AppError("NOT_FOUND", "接口不存在。", 404);
      if (req.method === "OPTIONS") {
        if (!origin || !ORIGINS.has(origin) || req.headers["access-control-request-method"] !== "POST" ||
          String(req.headers["access-control-request-headers"] || "").split(",").filter(Boolean).some(v => !ALLOWED_HEADERS.has(v.trim().toLowerCase()))) {
          throw new AppError("CORS_FORBIDDEN", "不允许此跨域预检请求。", 403);
        }
        send(204, null, { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": `${TOKEN_HEADER}, Content-Type, Accept` }); return;
      }
      if (req.method !== "POST") throw new AppError("METHOD_NOT_ALLOWED", "分析接口仅支持 POST。", 405);
      if (origin && !ORIGINS.has(origin)) throw new AppError("CORS_FORBIDDEN", "来源不受信任。", 403);
      // A harmless RAM-invoked boot probe. No model/market configuration is read.
      // The ordinary HTTP /health endpoint serves the same minimal information.
      if ((path === "/" || path === "/invoke") && req.headers["x-fc-request-id"] && !req.headers[TOKEN_HEADER.toLowerCase()]) {
        const input = await body(req, true);
        if (Object.keys(input).length === 1 && input.action === "health") { send(200, health()); return; }
        throw new AppError("UNAUTHORIZED", "分析请求需要 X-JWT-Token。", 401);
      }
      if (path === "/invoke") throw new AppError("NOT_FOUND", "接口不存在。", 404);
      if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === TOKEN_HEADER.toLowerCase()).length !== 1) {
        throw new AppError("UNAUTHORIZED", "请提供唯一的 X-JWT-Token。", 401);
      }
      const sub = authorize(req.headers[TOKEN_HEADER.toLowerCase()] as string | undefined, Math.floor(now() / 1000));
      const input = await body(req);
      if (Object.keys(input).some(k => !["symbol", "style"].includes(k)) || typeof input.symbol !== "string" ||
        (input.style !== undefined && !["trend", "reversal", "neutral"].includes(String(input.style)))) {
        throw new AppError("INVALID_REQUEST", "只接受 symbol 和可选 style（trend/reversal/neutral）。", 400);
      }
      config ||= loadConfig(env);
      if (!config.symbols.includes(input.symbol)) throw new AppError("SYMBOL_NOT_ALLOWED", "交易对不在 SIGNAL_ALLOWED_SYMBOLS 中。", 400);
      if (active) throw new AppError("BUSY", "实例正在分析，请稍后重新获取行情。", 429, 5);
      const previous = cooldowns.get(sub);
      if (previous !== undefined && now() - previous < config.cooldownMs) throw new AppError("COOLDOWN", "请稍后重新获取行情。", 429, Math.ceil((config.cooldownMs - now() + previous) / 1000));
      active = true; acquired = true;
      if (cooldowns.size >= 64) cooldowns.delete(cooldowns.keys().next().value!);
      cooldowns.set(sub, now());
      market ||= config.mode === "websocket" ? new WebSocketMarketDataProvider(config) : new RestMarketDataProvider(config);
      req.on("aborted", disconnected); res.on("close", disconnected);
      timer = setTimeout(() => abort.abort(), config.requestTimeoutMs); timer.unref();
      const result = await analyze(config, market, input.symbol, (input.style || "trend") as Style, abort.signal, model, now);
      send(200, { requestId, ...result });
      logger.info(JSON.stringify({ event: "analysis_completed", requestId, analysisId: result.analysisId, symbol: input.symbol, status: result.status, totalMs: result.timing.totalMs }));
    } catch (error) {
      const safe = abort.signal.aborted ? new AppError("REQUEST_TIMEOUT", "分析已取消或超时，请重新获取行情。", 504) : publicError(error);
      send(safe.status, { requestId, error: { code: safe.code, message: safe.message } }, safe.retryAfter ? { "Retry-After": String(safe.retryAfter) } : {});
      logger.error(JSON.stringify({ event: "analysis_failed", requestId, code: safe.code }));
    } finally {
      clearTimeout(timer); req.off("aborted", disconnected); res.off("close", disconnected);
      if (acquired) active = false;
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 0;
  server.timeout = 0;
  server.maxHeadersCount = 64;
  server.on("close", () => market?.close());
  return server;
}
export function startServer() {
  const port = Number(process.env.PORT || "9000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
  // Only an explicitly enabled continuous worker starts background subscriptions.
  // Ordinary FC startup is lightweight and does not require model secrets for health.
  const worker = process.env.MARKET_DATA_MODE === "websocket"
    ? new WebSocketMarketDataProvider(loadConfig(process.env)) : undefined;
  const server = makeServer({ provider: worker });
  server.listen(port, "0.0.0.0", () => console.info(JSON.stringify({ event: "server_started", port, codeVersion: SOURCE_COMMIT })));
  const shutdown = () => {
    server.close(); server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  return server;
}
