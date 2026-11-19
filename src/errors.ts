export interface ModelFailureDetails {
  upstreamStatus: number;
  upstreamCode?: string;
  upstreamRequestId?: string;
}

export interface ModelOutputDetails {
  outputReason: "response_envelope" | "truncated" | "finish_reason" | "empty_content" | "content_too_large" | "invalid_json" | "schema" | "unsupported_metric" | "missing_volume_price_evidence" | "price_relationship" | "price_scale" | "unsupported_target" | "unsupported_zone" | "target_obstacle" | "price_precision";
  outputField?: string;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "function_call" | "unknown";
  outputChars?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface ZoneDetails {
  id: string;
  status: string;
  lower: number;
  upper: number;
  effectiveKind: string;
}

export interface ValidationDetails {
  reason: "zone_not_found" | "zone_broken" | "zone_wrong_kind" | "entry_out_of_bounds" |
    "stop_wrong_side" | "stop_too_far" | "target_out_of_bounds" | "target_skips_obstacle" |
    "price_out_of_scale" | "price_off_tick_grid";
  field?: string;
  requestedZoneId?: string;
  zoneReference?: "missing" | "malformed" | "formatted";
  zone?: ZoneDetails;
  blockingZone?: ZoneDetails;
  zoneCount?: number;
  entry?: { min: number; max: number };
  price?: number;
  expectedKind?: "support" | "resistance";
  stopDistance?: number;
  hourlyAtr?: number;
  markPrice?: number;
  direction?: "long" | "short";
  snapshotAsOf?: number;
  tickSize?: number;
}

interface ErrorOptionsForLogs extends ErrorOptions {
  validation?: ValidationDetails;
  marketEndpoint?: string;
  marketHttpStatus?: number;
}

export class AppError extends Error {
  validation?: ValidationDetails;
  marketEndpoint?: string;
  marketHttpStatus?: number;

  constructor(public code: string, message: string, public status = 400, public retryAfter?: number,
    public upstream?: ModelFailureDetails | ModelOutputDetails, options?: ErrorOptionsForLogs) {
    super(message, options);
    this.name = "AppError";
    this.validation = options?.validation;
    this.marketEndpoint = options?.marketEndpoint;
    this.marketHttpStatus = options?.marketHttpStatus;
  }
}

const nativeErrorNames = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "AggregateError", "AbortError", "TimeoutError"]);
const nativeErrorCodes = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_CONTENT_LENGTH_MISMATCH", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "ABORT_ERR",
]);

export function exceptionChain(error: unknown) {
  const chain: { name: string; code?: string; frames?: string[] }[] = [];
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error) && chain.length < 4) {
    seen.add(error);
    const rawCode = (error as NodeJS.ErrnoException).code;
    const code = error instanceof AppError ? error.code : rawCode && nativeErrorCodes.has(rawCode) ? rawCode : undefined;
    // Skip the message and keep only source positions from known service modules.
    // Native errors and JSON parser errors can embed upstream data in their text.
    const frames = (typeof error.stack === "string" ? error.stack : "").split("\n").slice(1, 20).flatMap(line => {
      if (!/^\s+at /.test(line)) return [];
      const match = /\/build\/((?:analysis|auth|config|errors|features|http|market|model|order-auth|order-binance|order-oss|order-rules|orders|price-zones|research|server|websocket-market)\.js:\d{1,7}:\d{1,5})\)?$/.exec(line);
      return match ? [match[1]!] : [];
    }).slice(0, 4);
    chain.push({
      name: error instanceof AppError ? "AppError" : nativeErrorNames.has(error.name) ? error.name : "Error",
      ...(code ? { code } : {}), ...(frames.length ? { frames } : {}),
    });
    error = error.cause;
  }
  return chain.length ? chain : [{ name: "NonErrorThrown" }];
}

export function publicError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务内部错误，请使用 requestId 检查函数日志。", 500);
}
