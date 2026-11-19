import { createHash, createHmac } from "node:crypto";
import type { OrderConfig } from "./order-auth.js";
import { AppError } from "./errors.js";
import { boundedJson } from "./http.js";

export interface OrderStore {
  read(path: string): Promise<unknown>;
}

export function makeOrderStore(config: OrderConfig, now: () => number, fetchImpl = fetch): OrderStore {
  async function request(path: string) {
    const date = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const scope = `${date.slice(0, 8)}/${config.region}/oss/aliyun_v4_request`;
    const payload = "UNSIGNED-PAYLOAD";
    const headers: Record<string, string> = { "x-oss-date": date, "x-oss-content-sha256": payload };
    const resource = `/${config.prefix}/${path}`;
    const canonicalHeaders = Object.keys(headers).sort().map(name => `${name}:${headers[name]}\n`).join("");
    const canonical = ["GET", `/${config.bucket}${resource}`, "", canonicalHeaders, "", payload].join("\n");
    const toSign = ["OSS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    let key: string | Buffer = `aliyun_v4${config.ossSecret}`;
    for (const part of scope.split("/")) key = createHmac("sha256", key).update(part).digest();
    headers.authorization = `OSS4-HMAC-SHA256 Credential=${config.ossKey}/${scope},Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
    try {
      return await fetchImpl(`https://${config.ossHost}${resource}`, {
        method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(3500),
      });
    } catch (cause) {
      throw new AppError("ORDER_STORAGE_UNAVAILABLE", "订单存储连接失败。", 503, undefined, undefined, { cause });
    }
  }
  function unavailable(response: Response) {
    const status = response.status;
    const requestId = response.headers.get("x-oss-request-id") || "";
    return new AppError("ORDER_STORAGE_UNAVAILABLE", "订单存储操作失败，请使用请求编号查看函数日志。", 503, undefined, { upstreamStatus: status, ...(/^[a-zA-Z0-9-]{8,100}$/.test(requestId) ? { upstreamRequestId: requestId } : {}) });
  }
  return {
    async read(path) {
      const response = await request(path);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404 && response.headers.get("x-oss-request-id")) return null;
        throw unavailable(response);
      }
      return boundedJson(response, 8192, "ORDER_STORAGE_UNAVAILABLE");
    },
  };
}
