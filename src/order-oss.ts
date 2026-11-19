import { createHash, createHmac } from "node:crypto";
import type { OrderConfig } from "./order-auth.js";
import { AppError } from "./errors.js";
import { boundedJson } from "./http.js";

export interface OrderStore {
  assertAtomicWrites(): Promise<void>;
  create(path: string, value: unknown): Promise<boolean>;
  write(path: string, value: unknown): Promise<void>;
  read(path: string): Promise<unknown>;
  removeLock(path: string): Promise<void>;
}

export function makeOrderStore(config: OrderConfig, now: () => number, fetchImpl = fetch): OrderStore {
  async function request(method: string, path = "", value?: unknown, query = "", overwrite = false) {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const date = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const scope = `${date.slice(0, 8)}/${config.region}/oss/aliyun_v4_request`;
    const payload = "UNSIGNED-PAYLOAD";
    const headers: Record<string, string> = { "x-oss-date": date, "x-oss-content-sha256": payload };
    if (method === "PUT") {
      headers["content-type"] = "application/json";
      headers["content-md5"] = createHash("md5").update(body!).digest("base64");
      if (!overwrite) headers["x-oss-forbid-overwrite"] = "true";
      headers["x-oss-server-side-encryption"] = "AES256";
    }
    const resource = path ? `/${config.prefix}/${path}` : "/";
    const canonicalHeaders = Object.keys(headers).sort().map(name => `${name}:${headers[name]}\n`).join("");
    const canonical = [method, `/${config.bucket}${resource}`, query, canonicalHeaders, "", payload].join("\n");
    const toSign = ["OSS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    let key: string | Buffer = `aliyun_v4${config.ossSecret}`;
    for (const part of scope.split("/")) key = createHmac("sha256", key).update(part).digest();
    headers.authorization = `OSS4-HMAC-SHA256 Credential=${config.ossKey}/${scope},Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
    try {
      return await fetchImpl(`https://${config.ossHost}${resource}${query ? `?${query}` : ""}`, {
        method, body, headers, redirect: "error", signal: AbortSignal.timeout(3500),
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
    async assertAtomicWrites() {
      const response = await request("GET", "", undefined, "versioning");
      if (!response.ok) { await response.body?.cancel(); throw unavailable(response); }
      const xml = await response.text();
      if (!/^(?:<\?xml[^>]*\?>\s*)?<VersioningConfiguration(?:\s[^>]*?)?\s*(?:\/>|>\s*<\/VersioningConfiguration>)\s*$/.test(xml.trim())) {
        throw new AppError("ORDER_STORAGE_VERSIONING", "下单记录桶必须从未启用 OSS 版本控制，才能保证防覆盖写入。", 503);
      }
    },
    async create(path, value) {
      const response = await request("PUT", path, value);
      await response.body?.cancel().catch(() => {});
      if (response.status === 409) return false;
      if (!response.ok) throw unavailable(response);
      return true;
    },
    async write(path, value) {
      const response = await request("PUT", path, value, "", true);
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw unavailable(response);
    },
    async read(path) {
      const response = await request("GET", path);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404 && response.headers.get("x-oss-request-id")) return null;
        throw unavailable(response);
      }
      return boundedJson(response, 8192, "ORDER_STORAGE_UNAVAILABLE");
    },
    async removeLock(path) {
      const response = await request("DELETE", path);
      await response.body?.cancel().catch(() => {});
      if (response.status !== 204) throw unavailable(response);
    },
  };
}
