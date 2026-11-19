"""Deploy the existing custom-runtime service without exposing or replacing its environment."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import zipfile

import yaml
from alibabacloud_fc20230330.client import Client
from alibabacloud_fc20230330 import models
from alibabacloud_tea_openapi.models import Config
from alibabacloud_tea_util.models import RuntimeOptions


class DeployError(Exception):
    pass


def target_from_yaml(path):
    document = yaml.safe_load(Path(path).read_text())
    try:
        resources = document["resources"]
        if len(resources) != 1:
            raise ValueError()
        resource = next(iter(resources.values()))
        if resource["component"] != "fc3":
            raise ValueError()
        props = resource["props"]
        if not re.fullmatch(r"[a-z0-9-]+", props["region"]):
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", props["functionName"]):
            raise ValueError()
        if props["runtime"] != "custom.debian12" or props["customRuntimeConfig"]["port"] != 9000:
            raise ValueError()
        if props["timeout"] != 120 or props["cpu"] != 0.35 or props["memorySize"] != 512 or props["diskSize"] != 10240:
            raise ValueError()
        return props
    except (KeyError, TypeError, ValueError, AttributeError):
        raise DeployError("s.yaml deployment target is invalid.") from None


def load_zip(path):
    data = Path(path).read_bytes()
    # Keep the Base64 request comfortably inside the direct-upload limit.
    if not 0 < len(data) <= 20 * 1024 * 1024:
        raise DeployError("ZIP must be between 1 byte and 20 MiB for direct upload.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            required = {"bootstrap", "server.js", "index.js", "package.json", "build/server.js", "build/auth.js", "build/model.js", "build/version.js"}
            if not required.issubset(names) or len(names) != len(set(names)):
                raise DeployError("ZIP layout or dependencies are invalid.")
            if any(name.startswith("/") or ".." in Path(name).parts or
                   any(part.startswith(".env") or part in {".git", ".github", "node_modules"} for part in Path(name).parts)
                   for name in names):
                raise DeployError("ZIP contains a forbidden path or configuration file.")
    except zipfile.BadZipFile:
        raise DeployError("Deployment package is not a ZIP file.") from None
    return data


def crc64(data):
    # Reflected ECMA-182, with all-one init/xorout (same as Go crc64.ECMA).
    polynomial = 0xC96C5795D7870F42
    table = []
    for byte in range(256):
        value = byte
        for _ in range(8):
            value = (value >> 1) ^ (polynomial if value & 1 else 0)
        table.append(value)
    result = 0xFFFFFFFFFFFFFFFF
    for byte in data:
        result = table[(result ^ byte) & 0xFF] ^ (result >> 8)
    return str(result ^ 0xFFFFFFFFFFFFFFFF)


PRESERVED_FIELDS = (
    "environment_variables", "role", "cpu", "memory_size", "disk_size", "internet_access",
    "vpc_config", "nas_config", "oss_mount_config", "log_config", "resource_group_id",
    "instance_concurrency", "instance_isolation_mode", "session_affinity", "layers",
    "custom_dns", "instance_lifecycle_config", "disable_ondemand", "disable_inject_credentials",
)


def value_of(value):
    if hasattr(value, "to_map"):
        return value.to_map()
    if isinstance(value, list):
        return [value_of(item) for item in value]
    return value


def snapshot(function):
    return {key: value_of(getattr(function, key, None)) for key in PRESERVED_FIELDS}


def _object(value):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError()
    return {key.lower(): item for key, item in value.items()}


def _jwt_policy(auth_type, auth_config):
    """Inspect policy in memory. Never print the JWKS or returned configuration."""
    try:
        if not isinstance(auth_type, str) or auth_type.lower() != "jwt":
            raise ValueError()
        policy = _object(auth_config)
        if set(policy) - {"jwks", "tokenlookup", "claimpassby", "whitelist", "blacklist", "matchmode", "issuer", "issuers", "audience", "audiences"}:
            raise ValueError()
        jwks = _object(policy.get("jwks"))
        keys = jwks.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= 5:
            raise ValueError()
        for key in keys:
            if (not isinstance(key, dict) or key.get("kty") != "RSA" or key.get("alg") != "RS256"
                    or key.get("use") != "sig" or any(name in key for name in ("d", "p", "q", "dp", "dq", "qi", "oth", "k"))):
                raise ValueError()
            n = key.get("n", "")
            if not isinstance(n, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", n):
                raise ValueError()
            if int.from_bytes(base64.urlsafe_b64decode(n + "=" * (-len(n) % 4)), "big").bit_length() < 2048:
                raise ValueError()
        lookup = policy.get("tokenlookup")
        if isinstance(lookup, str):
            parts = lookup.split(":", 2)
            if len(parts) != 3 or "," in lookup or parts[0].lower() != "header" or parts[1].lower() != "x-jwt-token" or parts[2].strip() != "Bearer":
                raise ValueError()
        else:
            lookup = _object(lookup)
            if (set(lookup) != {"readposition", "parametername", "prefix"}
                    or lookup.get("readposition", "").lower() != "header" or lookup.get("parametername", "").lower() != "x-jwt-token"
                    or lookup.get("prefix", "").strip() != "Bearer"):
                raise ValueError()
        # All business aliases must be protected; only exact health exceptions are safe.
        if policy.get("blacklist"):
            raise ValueError()
        whitelist = policy.get("whitelist") or []
        if not isinstance(whitelist, list):
            raise ValueError()
        if any(path not in ("/health", "/trade/api/signal/health") for path in whitelist):
            raise ValueError()
        mode = policy.get("matchmode", "all")
        if not isinstance(mode, str) or mode.lower() not in ("all", "matchall", "match_all", "whitelist"):
            raise ValueError()
        if "x-jwt-token" in str(policy.get("claimpassby", "")).lower():
            raise ValueError()
        return policy
    except (ValueError, TypeError, AttributeError, KeyError):
        try:
            fields = sorted(_object(auth_config))
        except (ValueError, TypeError, AttributeError):
            fields = []
        raise DeployError("FC ingress must enforce RS256 JWT from X-JWT-Token for all business paths; policy fields: " + ", ".join(fields)) from None


def audit_native_jwt(client, target):
    policies = []
    token = None
    seen = set()
    for _ in range(20):
        page = client.list_triggers(target["functionName"], models.ListTriggersRequest(limit=100, next_token=token)).body
        for trigger in page.triggers or []:
            if trigger.trigger_type != "http":
                continue
            trigger = client.get_trigger(target["functionName"], trigger.trigger_name).body
            config = _object(trigger.trigger_config)
            if config.get("authtype") == "function":
                # The Internet switch only disables the public default URL.
                # A signed HTTP trigger must not accept business POSTs on any URL.
                methods = config.get("methods")
                if (not isinstance(methods, list) or not methods or
                        any(not isinstance(method, str) or method.upper() not in ("GET", "HEAD", "OPTIONS") for method in methods)):
                    raise DeployError("FC RAM-signed HTTP trigger must allow only GET, HEAD or OPTIONS, or use native JWT for POST. "
                                      "Check trigger '" + trigger.trigger_name + "'. InvokeFunction events are separate.")
                policies.append({"type": "ram-trigger", "name": trigger.trigger_name,
                                 "policy": {"authType": "function", "methods": sorted(method.upper() for method in methods)}})
                continue
            try:
                policy = _jwt_policy(config.get("authtype"), config.get("authconfig"))
            except DeployError:
                print(json.dumps({"event": "native_jwt_policy_unconfirmed", "source": "httpTrigger",
                                  "authType": config.get("authtype"), "fields": sorted(config),
                                  "authConfigType": type(config.get("authconfig")).__name__}), flush=True)
                raise
            policies.append({"type": "trigger", "name": trigger.trigger_name, "policy": policy})
        token = page.next_token
        if not token:
            break
        if token in seen:
            raise DeployError("FC trigger pagination did not complete.")
        seen.add(token)
    else:
        raise DeployError("FC trigger pagination exceeded its bound.")
    trigger_count = len(policies)
    token = None
    seen = set()
    for _ in range(20):
        page = client.list_custom_domains(models.ListCustomDomainsRequest(limit=100, next_token=token)).body
        for domain in page.custom_domains or []:
            if domain.route_config is None:
                domain = client.get_custom_domain(domain.domain_name).body
            routes = (domain.route_config.routes if domain.route_config else []) or []
            if not any(route.function_name == target["functionName"] for route in routes):
                continue
            auth = domain.auth_config
            policy = _jwt_policy(auth.auth_type if auth else None, auth.auth_info if auth else None)
            policies.append({"type": "domain", "name": domain.domain_name, "policy": policy})
        token = page.next_token
        if not token:
            break
        if token in seen:
            raise DeployError("FC custom-domain pagination did not complete.")
        seen.add(token)
    else:
        raise DeployError("FC custom-domain pagination exceeded its bound.")
    if not policies:
        raise DeployError("No protected HTTP ingress was found for the function.")
    jwt_ready = any(policy["type"] != "ram-trigger" for policy in policies)
    # A new region can be staged behind RAM authentication before its JWT
    # custom domain is attached. Never relax an anonymous ingress to do this.
    print(json.dumps({"event": "native_jwt_verified", "httpTriggers": trigger_count,
                      "ramProtectedTriggers": sum(policy["type"] == "ram-trigger" for policy in policies),
                      "customDomains": len(policies) - trigger_count, "jwtIngressReady": jwt_ready}), flush=True)
    if not jwt_ready:
        print("Deployment is staged behind RAM authentication. Configure a JWT-protected custom domain before switching CDN traffic.", flush=True)
    return hashlib.sha256(json.dumps(policies, sort_keys=True).encode()).hexdigest()


def preflight(client, target):
    current = client.get_function(target["functionName"], models.GetFunctionRequest()).body
    if current.runtime != target["runtime"]:
        raise DeployError("Existing function must use custom.debian12; stopped before writing.")
    if (abs(float(current.cpu or 0) - 0.35) > 0.00001 or current.memory_size != 512 or current.disk_size != 10240):
        raise DeployError("Expected existing resources: 0.35 vCPU, 512 MB memory, 10240 MB disk; stopped before writing.")
    if str((current.environment_variables or {}).get("PORT", "9000")) != "9000":
        raise DeployError("Existing PORT environment variable must be 9000; stopped before writing.")
    if (current.environment_variables or {}).get("MARKET_DATA_MODE", "rest") != "rest":
        raise DeployError("FC deployment expects MARKET_DATA_MODE=rest; deploy continuous collection on a resident host.")
    custom = copy.deepcopy(current.custom_runtime_config) or models.CustomRuntimeConfig()
    if custom.port not in (None, 9000):
        raise DeployError("Existing custom runtime must listen on port 9000; stopped before writing.")
    # Keep the interpreter selected by the console's Node.js 24 layer/template.
    # Never execute the former application command, only retain a node binary.
    node_binary = None
    for token in (custom.command or []) + (custom.args or []):
        match = re.search(r"(?:^|\s)(/[A-Za-z0-9_./-]+/node)(?=\s|$)", token)
        if match:
            node_binary = match.group(1)
            break
    custom.command = ["/bin/sh", "/code/bootstrap"] + ([node_binary] if node_binary else [])
    custom.args = []
    custom.port = 9000
    return current, custom


def smoke(client, target, expected_commit):
    response = client.invoke_function_with_options(
        target["functionName"], models.InvokeFunctionRequest(body=io.BytesIO(b'{"action":"health"}')),
        # Let the SDK sign and set its own content type; an extra mixed-case
        # Content-Type can conflict with the FC gateway's canonical signature.
        models.InvokeFunctionHeaders(x_fc_invocation_type="Sync"),
        RuntimeOptions(connect_timeout=10000, read_timeout=60000, autoretry=False),
    )
    raw = response.body.read(4097) if hasattr(response.body, "read") else response.body
    if isinstance(raw, str):
        raw = raw.encode()
    try:
        if not isinstance(raw, bytes) or len(raw) > 4096:
            raise ValueError()
        result = json.loads(raw)
        if (response.status_code != 200 or result.get("status") != "ok" or result.get("service") != "binance-market-signal"
                or result.get("nodeMajor") != 24 or result.get("codeVersion") != expected_commit):
            raise ValueError()
    except (TypeError, ValueError, AttributeError):
        raise DeployError("Cold-start health/version probe failed; inspect FC startup logs and Node.js 24 layer/PATH.") from None
    return {"health": "ok", "nodeMajor": 24, "codeVersion": expected_commit}


def deploy(client, target, package, *, sleep=time.sleep, now=time.monotonic):
    name = target["functionName"]
    current, custom = preflight(client, target)
    ingress_before = audit_native_jwt(client, target)
    before = snapshot(current)
    checksum = crc64(package)
    print(json.dumps({"event": "fc_preflight", "runtime": current.runtime,
                      "cpu": current.cpu, "memoryMB": current.memory_size, "diskMB": current.disk_size,
                      "port": 9000, "expectedCodeChecksum": checksum}), flush=True)
    body = models.UpdateFunctionInput(
        code=models.InputCodeLocation(zip_file=base64.b64encode(package).decode("ascii"), checksum=checksum),
        timeout=target["timeout"], custom_runtime_config=custom,
    )
    client.update_function_with_options(name, models.UpdateFunctionRequest(body=body), {},
        RuntimeOptions(connect_timeout=10000, read_timeout=120000, autoretry=False))
    deadline = now() + 180
    while now() < deadline:
        deployed = client.get_function(name, models.GetFunctionRequest()).body
        if deployed.state == "Failed" or deployed.last_update_status == "Failed":
            raise DeployError("FC reports a failed update; inspect the FC console.")
        if (deployed.state in (None, "", "Active") and deployed.last_update_status in (None, "", "Successful")
                and str(deployed.code_checksum) == checksum):
            if (deployed.runtime != target["runtime"] or deployed.timeout != target["timeout"]
                    or value_of(deployed.custom_runtime_config) != value_of(custom)):
                raise DeployError("Deployed runtime/startup/timeout verification failed.")
            after = snapshot(deployed)
            changed = [name for name in PRESERVED_FIELDS if before[name] != after[name]]
            if changed:
                # Field names are safe to log; environment/configuration values are not.
                raise DeployError("FC configuration changed during deployment (fields: " + ", ".join(changed) + "); inspect the console.")
            if audit_native_jwt(client, target) != ingress_before:
                raise DeployError("FC JWT ingress policy changed during deployment; inspect the console.")
            expected_commit = os.environ.get("GITHUB_SHA", "development")
            result = {"functionName": name, "region": target["region"], "runtime": deployed.runtime,
                      "timeout": deployed.timeout, "codeChecksum": checksum,
                      "zipSha256": hashlib.sha256(package).hexdigest(), "sourceCommit": expected_commit}
            result.update(smoke(client, target, expected_commit))
            return result
        sleep(5)
    raise DeployError("FC deployment readback timed out; inspect the FC console before retrying.")


def main():
    root = Path(__file__).resolve().parents[1]
    target = target_from_yaml(root / "s.yaml")
    credentials = [os.environ.get(key, "").strip() for key in ("ALIYUN_FC_ACCESS_KEY_ID", "ALIYUN_FC_ACCESS_KEY_SECRET")]
    if not all(credentials):
        raise DeployError("Configure Repository secrets ALIYUN_FC_ACCESS_KEY_ID and ALIYUN_FC_ACCESS_KEY_SECRET.")
    config = Config(access_key_id=credentials[0], access_key_secret=credentials[1],
                    endpoint=f"fcv3.{target['region']}.aliyuncs.com", connect_timeout=10000, read_timeout=120000)
    client = Client(config)
    if "--preflight" in sys.argv:
        preflight(client, target)
        audit_native_jwt(client, target)
        print("Existing FC custom runtime, port and resource specifications verified.")
        return 0
    package = load_zip(root / target["code"])
    print(f"Deploying {target['functionName']} in {target['region']}; preserving environment variables, role, layers and resources.")
    result = deploy(client, target, package)
    (root / "dist/deploy-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write("## FC deployment verified\n\n")
            for key, value in result.items():
                output.write(f"- {key}: `{value}`\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DeployError as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Alibaba SDK exceptions can contain request bodies, signed URLs or envs.
        code = getattr(error, "code", "")
        code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", code) else type(error).__name__
        print(f"Deployment failed ({code}); check FC permissions and GitHub Actions network access.", file=sys.stderr)
        sys.exit(1)
