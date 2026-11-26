import { AppError } from "./errors.js";

export type Env = Record<string, string | undefined>;
function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("INVALID_CONFIGURATION", `${name} 配置无效。`, 503);
  }
  return parsed;
}
export function loadConfig(env: Env) {
  const key = env.DASHSCOPE_API_KEY?.trim();
  const model = env.DASHSCOPE_MODEL?.trim() || "qwen-plus";
  if (!key || /\s/.test(key) || !/^[A-Za-z0-9_./-]{1,128}$/.test(model)) {
    throw new AppError("MODEL_NOT_CONFIGURED", "请配置 DASHSCOPE_API_KEY 和有效的 DASHSCOPE_MODEL。", 503);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1");
    const trusted = new Set(["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com", "cn-hongkong.dashscope.aliyuncs.com"]);
    if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !(trusted.has(endpoint.hostname) || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|cn-hongkong|us-east-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(endpoint.hostname)) ||
      endpoint.pathname.replace(/\/$/, "") !== "/compatible-mode/v1") throw new Error();
    endpoint.pathname = "/compatible-mode/v1/chat/completions";
  } catch { throw new AppError("INVALID_CONFIGURATION", "DASHSCOPE_BASE_URL 必须为百炼 HTTPS 兼容接口的 /compatible-mode/v1 地址。", 503); }
  const symbols = (env.SIGNAL_ALLOWED_SYMBOLS || "BTCUSDT").split(",").map(v => v.trim());
  if (!symbols.length || symbols.length > 4 || new Set(symbols).size !== symbols.length || symbols.some(s => !/^[A-Z0-9]{3,24}USDT$/.test(s))) {
    throw new AppError("INVALID_CONFIGURATION", "SIGNAL_ALLOWED_SYMBOLS 必须为最多四个不同的 USDT 合约交易对。", 503);
  }
  const mode = env.MARKET_DATA_MODE?.trim() || "rest";
  if (mode !== "rest" && mode !== "websocket") throw new AppError("INVALID_CONFIGURATION", "MARKET_DATA_MODE 只支持 rest/websocket。", 503);
  // Long-running collection needs an explicitly provisioned, continuously running host.
  if (mode === "websocket" && env.CONTINUOUS_WORKER !== "true") {
    throw new AppError("INVALID_CONFIGURATION", "WebSocket 模式须在常驻服务中显式配置 CONTINUOUS_WORKER=true；FC 默认使用 rest。", 503);
  }
  const responseFormat = env.DASHSCOPE_RESPONSE_FORMAT?.trim() || "json_object";
  const enableThinking = env.DASHSCOPE_ENABLE_THINKING?.trim() || "false";
  if (!["json_object", "json_schema"].includes(responseFormat) || !["false", "omit"].includes(enableThinking)) {
    throw new AppError("INVALID_CONFIGURATION", "DASHSCOPE_RESPONSE_FORMAT 只支持 json_object/json_schema，DASHSCOPE_ENABLE_THINKING 只支持 false/omit。", 503);
  }
  return {
    apiKey: key, model, endpoint: endpoint.href, symbols, mode,
    binanceTimeoutMs: integer(env, "BINANCE_TIMEOUT_MS", 8000, 1000, 15000),
    modelTimeoutMs: integer(env, "DASHSCOPE_TIMEOUT_MS", 45000, 1000, 90000),
    requestTimeoutMs: integer(env, "SIGNAL_REQUEST_TIMEOUT_MS", 65000, 5000, 110000),
    maxTokens: integer(env, "DASHSCOPE_MAX_TOKENS", model === "kimi-k3.1-pro" ? 4096 : 2000, 512, 4096),
    maxPriceAgeMs: integer(env, "SIGNAL_MAX_PRICE_AGE_MS", 5000, 1000, 15000),
    maxAnalysisAgeMs: integer(env, "SIGNAL_MAX_ANALYSIS_AGE_MS", 60000, 5000, 110000),
    maxPriceDriftBps: integer(env, "SIGNAL_MAX_PRICE_DRIFT_BPS", 30, 1, 500),
    cooldownMs: integer(env, "SIGNAL_COOLDOWN_SECONDS", 10, 0, 300) * 1000,
    responseFormat, enableThinking, useM1Trigger: env.USE_M1_TRIGGER?.trim() === "true",
  };
}
export type Config = ReturnType<typeof loadConfig>;
