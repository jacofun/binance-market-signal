import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { AppError } from "./errors.js";
import type { Env } from "./config.js";

export const TOKEN_HEADER = "X-JWT-Token";
export interface GatewayContext { controlPath?: string; functionName?: string; requestId?: string }
const denied = () => new AppError("UNAUTHORIZED", "分析凭证无效或已过期。", 401);
function parse(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw denied();
  const decoded = Buffer.from(part, "base64url");
  if (decoded.toString("base64url") !== part) throw denied();
  const value: unknown = JSON.parse(decoded.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  return value as Record<string, unknown>;
}
export function makeAuthorizer(env: Env) {
  let keys: Map<string, KeyObject> | undefined;
  function getKeys() {
    if (keys) return keys;
    try {
      const jwks = JSON.parse(env.SIGNAL_JWT_JWKS || "");
      if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 5) throw new Error();
      const result = new Map<string, KeyObject>();
      for (const jwk of jwks.keys) {
        if (jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig" || !/^[A-Za-z0-9_-]{1,80}$/.test(jwk.kid) ||
          result.has(jwk.kid) || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(n => n in jwk)) throw new Error();
        const key = createPublicKey({ key: jwk, format: "jwk" });
        if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
        result.set(jwk.kid, key);
      }
      keys = result;
      return result;
    } catch { throw new AppError("JWT_NOT_CONFIGURED", "请配置只含公钥的 SIGNAL_JWT_JWKS。", 503); }
  }
  return (authorization: string | undefined, nowSeconds = Math.floor(Date.now() / 1000), gateway: GatewayContext = {}): string => {
    const mode = env.SIGNAL_AUTH_MODE?.trim() || "fc-jwt";
    if (mode !== "fc-jwt" && mode !== "local-jwks") throw new AppError("INVALID_AUTH_CONFIGURATION", "SIGNAL_AUTH_MODE 只支持 fc-jwt/local-jwks。", 503);
    // In fc-jwt mode signature verification belongs to the FC ingress, not to
    // these headers. CI audits every HTTP trigger and matching custom domain.
    // Platform context rejects accidental direct invocation; it is not a signature.
    if (mode === "fc-jwt" && (gateway.controlPath !== "/http-invoke" || gateway.functionName !== "binance-market-signal" ||
      typeof gateway.requestId !== "string" || !gateway.requestId || gateway.requestId.length > 256)) {
      throw new AppError("GATEWAY_REQUIRED", "分析接口须经启用 JWT 认证的 FC HTTP 入口调用。", 401);
    }
    const trustedKeys = mode === "local-jwks" ? getKeys() : undefined;
    try {
      if (!authorization || authorization.length > 8192 || !/^Bearer [^ ]+$/i.test(authorization)) throw denied();
      const parts = authorization.slice(7).split(".");
      if (parts.length !== 3) throw denied();
      const [h, p, s] = parts as [string, string, string];
      const header = parse(h);
      if (header.alg !== "RS256" || header.typ !== "JWT" || ["crit", "jku", "jwk", "x5u"].some(k => k in header)) throw denied();
      if (!/^[A-Za-z0-9_-]+$/.test(s) || Buffer.from(s, "base64url").toString("base64url") !== s || Buffer.from(s, "base64url").length < 256) throw denied();
      if (trustedKeys) {
        const key = trustedKeys.get(String(header.kid));
        if (!key || !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) throw denied();
      }
      const c = parse(p);
      if (c.iss !== (env.SIGNAL_JWT_ISSUER?.trim() || "https://www.yanxiao.me") ||
        c.aud !== (env.SIGNAL_JWT_AUDIENCE?.trim() || "binance-market-signal") || c.scope !== "market:analyze" ||
        typeof c.sub !== "string" || !c.sub || c.sub.length > 128 || typeof c.jti !== "string" || !c.jti || c.jti.length > 128 ||
        typeof c.iat !== "number" || typeof c.exp !== "number" || !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) ||
        c.exp <= nowSeconds || c.iat > nowSeconds + 5 || c.exp <= c.iat || c.exp - c.iat > 120 ||
        (c.nbf !== undefined && (typeof c.nbf !== "number" || !Number.isSafeInteger(c.nbf) || c.nbf > nowSeconds))) throw denied();
      return c.sub;
    } catch { throw denied(); }
  };
}
