export interface ModelFailureDetails {
  upstreamStatus: number;
  upstreamCode?: string;
  upstreamRequestId?: string;
}

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryAfter?: number, public upstream?: ModelFailureDetails) {
    super(message);
  }
}
export function publicError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务内部错误，请使用 requestId 检查函数日志。", 500);
}
