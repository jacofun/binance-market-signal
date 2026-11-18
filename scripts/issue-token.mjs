// For trusted local testing, never deploy a signing key with the signal function.
import { createPrivateKey, randomUUID, sign } from "node:crypto";
const key = createPrivateKey((process.env.SIGNAL_PRIVATE_KEY || "").replace(/\\n/g, "\n"));
if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error("RSA >= 2048 is required");
const now = Math.floor(Date.now() / 1000);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = encode({ alg: "RS256", typ: "JWT", kid: process.env.SIGNAL_KEY_ID || "trade-sync-v1" });
const payload = encode({ iss: process.env.SIGNAL_JWT_ISSUER || "https://www.yanxiao.me", aud: process.env.SIGNAL_JWT_AUDIENCE || "binance-market-signal",
  scope: "market:analyze", sub: "owner", iat: now, exp: now + 120, jti: randomUUID() });
const data = `${header}.${payload}`;
process.stdout.write(`${data}.${sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}\n`);
