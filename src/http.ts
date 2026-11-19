import { AppError } from "./errors.js";

async function parseBounded<T>(response: Response, limit: number, code: string, parse: (body: string) => T): Promise<T> {
  const size = response.headers.get("content-length");
  if (size && Number(size) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(code, "上游响应超过大小限制。", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError(code, "上游返回空响应。", 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new AppError(code, "上游响应超过大小限制。", 502);
      chunks.push(value);
    }
    return parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof AppError) throw error;
    throw new AppError(code, "上游响应格式无效或读取中断。", 502, undefined, undefined, { cause: error });
  } finally { reader.releaseLock(); }
}

export function boundedJson(response: Response, limit: number, code: string): Promise<unknown> {
  return parseBounded(response, limit, code, JSON.parse);
}

export function boundedJsonLines(response: Response, limit: number, code: string): Promise<unknown[]> {
  return parseBounded(response, limit, code, body => body.trim() ? body.trim().split("\n").map(line => JSON.parse(line)) : []);
}

export async function limited<T>(tasks: (() => Promise<T>)[], concurrency = 2): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length && failure === undefined) {
      const i = next++;
      try { results[i] = await tasks[i]!(); }
      catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
  return results;
}
