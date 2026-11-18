export interface ModelFailureDetails {
  upstreamStatus: number;
  upstreamCode?: string;
  upstreamRequestId?: string;
}

export interface ModelOutputDetails {
  outputReason: "response_envelope" | "truncated" | "finish_reason" | "empty_content" | "content_too_large" | "invalid_json" | "schema" | "unsupported_metric" | "price_relationship" | "price_scale";
  outputField?: string;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "function_call" | "unknown";
  outputChars?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryAfter?: number, public upstream?: ModelFailureDetails | ModelOutputDetails) {
    super(message);
  }
}
export function publicError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务内部错误，请使用 requestId 检查函数日志。", 500);
}
