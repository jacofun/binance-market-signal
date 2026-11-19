import type { Env } from "./config.js";
import { AppError } from "./errors.js";

export function loadOssConfig(env: Env, domain: "ORDER" | "SCAN") {
  const setting = (name: string) => env[name]?.trim() || "";
  // Resolve each bucket/region pair together. Existing order state takes
  // priority over a legacy scanner override so an upgrade keeps order locks.
  const groups = ["OSS", "SIGNAL_ORDER_OSS", "SIGNAL_SCANNER_OSS"];
  const source = groups.find(group => setting(`${group}_BUCKET`) || setting(`${group}_REGION`)) ?? "OSS";
  const code = domain === "SCAN" ? "SCAN_STORAGE_CONFIGURATION" : "ORDER_CONFIGURATION";
  const required = (name: string, value: string, pattern: RegExp) => {
    if (!pattern.test(value)) {
      throw new AppError(code, `请检查 OSS 配置 ${name}。`, 503, undefined, undefined, { configurationField: name });
    }
    return value;
  };
  const bucket = required(`${source}_BUCKET`, setting(`${source}_BUCKET`), /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  const region = required(`${source}_REGION`, setting(`${source}_REGION`), /^[a-z]{2}(?:-[a-z0-9]+)+$/);
  const networkField = setting("OSS_NETWORK") ? "OSS_NETWORK" : `${source}_NETWORK`;
  const network = required(networkField, setting(networkField) || "public", /^(public|internal)$/);
  return {
    bucket, region, ossHost: `${bucket}.oss-${region}${network === "internal" ? "-internal" : ""}.aliyuncs.com`,
    ossKey: required("ACCESS_KEY_ID", setting("ACCESS_KEY_ID"), /^[A-Za-z0-9_-]{8,128}$/),
    ossSecret: required("ACCESS_KEY_SECRET", setting("ACCESS_KEY_SECRET"), /^[A-Za-z0-9_+/=-]{16,200}$/),
  };
}
