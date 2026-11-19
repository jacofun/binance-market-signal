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
        if not isinstance(result, dict):
            raise ValueError()
    except (TypeError, ValueError):
        result = {}
    service_ready = result.get("status") == "ok" and result.get("service") == "binance-market-signal"
    node_major = result.get("nodeMajor")
    actual_commit = result.get("codeVersion")
    if response.status_code != 200 or not service_ready or node_major != 24 or actual_commit != expected_commit:
        known_codes = {"UNAUTHORIZED", "NOT_FOUND", "UNSUPPORTED_MEDIA_TYPE", "CUSTOM_DOMAIN_REQUIRED", "CORS_FORBIDDEN"}
        error = result.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        diagnostics = {"event": "fc_health_probe_mismatch", "httpStatus": response.status_code, "serviceReady": service_ready,
                       "nodeMajor": node_major if type(node_major) is int else None,
                       "actualCommit": actual_commit if isinstance(actual_commit, str) and re.fullmatch(r"[0-9a-f]{40}", actual_commit) else None,
                       "errorCode": code if isinstance(code, str) and code in known_codes else None}
        print(json.dumps(diagnostics), flush=True)
        return None
    return {"health": "ok", "nodeMajor": 24, "codeVersion": expected_commit}


def deploy(client, target, package, *, sleep=time.sleep, now=time.monotonic):
    name = target["functionName"]
    current, custom = preflight(client, target)
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
            expected_commit = os.environ.get("GITHUB_SHA", "development")
            result = {"functionName": name, "region": target["region"], "runtime": deployed.runtime,
                      "timeout": deployed.timeout, "codeChecksum": checksum,
                      "zipSha256": hashlib.sha256(package).hexdigest(), "sourceCommit": expected_commit}
            # Readback can be current while a warm worker still serves the old
            # version. Retry only the read-only probe and never re-upload here.
            for attempt in range(5):
                health = smoke(client, target, expected_commit)
                if health is not None:
                    return {**result, **health}
                if attempt < 4:
                    sleep(5)
            raise DeployError("Cold-start health/version probe failed; inspect fc_health_probe_mismatch and FC startup logs.")
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
