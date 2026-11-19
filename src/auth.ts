import { AppError } from "./errors.js";

export const TOKEN_HEADER = "X-JWT-Token";
const denied = () => new AppError("UNAUTHORIZED", "交易凭证无效或已过期，请重新操作。", 401);

// FC's shared JWT ingress enforces signature, issuer and audience. Runtime
// metadata headers are not authentication evidence and are not required here.
// CI audits every public ingress before deploying this FC-only authorizer.
export function gatewayClaims(authorization: string | undefined, nowSeconds: number):
  Record<string, unknown> & { sub: string; exp: number } {
  try {
    if (!authorization || authorization.length > 8192 || !/^Bearer [^ ]+$/i.test(authorization)) throw denied();
    const parts = authorization.slice(7).split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw denied();
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw denied();
    const c = claims as Record<string, unknown>;
    if (typeof c.sub !== "string" || !c.sub || c.sub.length > 128 ||
      typeof c.exp !== "number" || !Number.isSafeInteger(c.exp) || c.exp <= nowSeconds) throw denied();
    return { ...c, sub: c.sub, exp: c.exp };
  } catch { throw denied(); }
}
