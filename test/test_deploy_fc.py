import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import tempfile
import zipfile

from alibabacloud_fc20230330 import models
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deploy_fc", ROOT / "scripts/deploy_fc.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeClient:
    def __init__(self, *, runtime="custom.debian12", drift=False, failed=False, health_commit="development", node=24, policy=None, domain_policy=None):
        self.runtime = runtime
        self.drift = drift
        self.failed = failed
        self.health_commit = health_commit
        self.node = node
        self.request = None
        self.policy = policy if policy is not None else native_config()
        self.domain_policy = domain_policy

    def list_triggers(self, name, request):
        return SimpleNamespace(body=models.ListTriggersOutput(triggers=[models.Trigger(trigger_type="http", trigger_name="defaultTrigger", trigger_config=json.dumps(self.policy))]))

    def list_custom_domains(self, request):
        domains = []
        if self.domain_policy is not None:
            domains = [models.CustomDomain(domain_name="example.test", route_config=models.RouteConfig(routes=[models.PathConfig(function_name="binance-market-signal", path="/*")]),
                auth_config=models.AuthConfig(auth_type=self.domain_policy["authType"], auth_info=json.dumps(self.domain_policy["authConfig"])))]
        return SimpleNamespace(body=models.ListCustomDomainOutput(custom_domains=domains))

    def get_trigger(self, name, trigger_name):
        return SimpleNamespace(body=models.Trigger(trigger_type="http", trigger_name=trigger_name, trigger_config=json.dumps(self.policy)))

    def get_function(self, name, request):
        custom = copy.deepcopy(self.request.body.custom_runtime_config) if self.request else models.CustomRuntimeConfig(
            command=["/opt/nodejs24/bin/node"], args=["index.js"], port=9000)
        return SimpleNamespace(body=models.Function(
            runtime=self.runtime, cpu=0.35, memory_size=512, disk_size=10240, timeout=120 if self.request else 60,
            custom_runtime_config=custom, layers=["existing-node24-layer"], role="preserved-role", internet_access=True,
            environment_variables={} if self.drift and self.request else {"DASHSCOPE_API_KEY": "private-value", "PATH": "/opt/nodejs24/bin:/usr/bin"},
            code_checksum=self.request.body.code.checksum if self.request else "old", code_size=200,
            state="Failed" if self.failed and self.request else "Active", last_update_status="Successful"))

    def update_function_with_options(self, name, request, headers, runtime):
        self.request = request
        assert runtime.autoretry is False
        return SimpleNamespace()

    def invoke_function_with_options(self, name, request, headers, runtime):
        assert json.loads(request.body.read()) == {"action": "health"}
        assert runtime.autoretry is False
        assert not headers.common_headers
        return models.InvokeFunctionResponse(status_code=200, body=io.BytesIO(json.dumps({
            "status": "ok", "service": "binance-market-signal", "nodeMajor": self.node, "codeVersion": self.health_commit}).encode()))


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.target = module.target_from_yaml(ROOT / "s.yaml")
        self.environment = patch.dict(os.environ, {"GITHUB_SHA": "development"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_crc64(self):
        self.assertEqual(module.crc64(b"123456789"), str(0x995DC9BBDF1939FA))

    def test_only_code_startup_timeout_change_and_layer_node_binary_is_preserved(self):
        client = FakeClient()
        result = module.deploy(client, self.target, b"zip", sleep=lambda _: None)
        payload = client.request.body.to_map()
        self.assertEqual(set(payload), {"code", "customRuntimeConfig", "timeout"})
        self.assertEqual(base64.b64decode(payload["code"]["zipFile"]), b"zip")
        self.assertEqual(payload["customRuntimeConfig"]["command"], ["/bin/sh", "/code/bootstrap", "/opt/nodejs24/bin/node"])
        self.assertEqual(result["health"], "ok")
        self.assertNotIn("private-value", str(result))

    def test_wrong_runtime_stops_before_writing(self):
        client = FakeClient(runtime="nodejs20")
        with self.assertRaisesRegex(module.DeployError, "before writing"):
            module.deploy(client, self.target, b"zip")
        self.assertIsNone(client.request)

    def test_environment_drift_or_failed_deployment_is_not_success(self):
        for client in [FakeClient(drift=True), FakeClient(failed=True)]:
            with self.assertRaises(module.DeployError):
                module.deploy(client, self.target, b"zip", sleep=lambda _: None)

    def test_runtime_and_source_commit_are_verified_by_real_health_response(self):
        for client in [FakeClient(node=20), FakeClient(health_commit="old")]:
            with self.assertRaisesRegex(module.DeployError, "health/version"):
                module.deploy(client, self.target, b"zip", sleep=lambda _: None)

    def test_package_rejects_secrets_and_runtime_dependencies(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.zip"
            def write(extra):
                with zipfile.ZipFile(path, "w") as archive:
                    for name in ["bootstrap", "server.js", "index.js", "package.json", "build/server.js", "build/auth.js", "build/model.js", "build/version.js"] + extra:
                        archive.writestr(name, "test")
            write([])
            self.assertTrue(module.load_zip(path))
            for names in [[".env"], ["node_modules/dependency.js"], ["../private.key"]]:
                write(names)
                with self.assertRaises(module.DeployError):
                    module.load_zip(path)

    def test_workflow_deploys_main_only_with_existing_secret_names(self):
        workflow = yaml.load((ROOT / ".github/workflows/deploy-fc.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow["on"]["push"]["branches"], ["main"])
        self.assertEqual(workflow["concurrency"]["cancel-in-progress"], "false")
        step = workflow["jobs"]["deploy"]["steps"][-1]
        self.assertEqual(set(step["env"]), {"ALIYUN_FC_ACCESS_KEY_ID", "ALIYUN_FC_ACCESS_KEY_SECRET"})
        self.assertIn("steps.current.outputs.deploy", step["if"])

    def test_native_jwt_policy_is_audited_without_logging_keys(self):
        self.assertTrue(module.audit_native_jwt(FakeClient(), self.target))
        legacy = native_config()
        legacy["authConfig"]["tokenLookup"] = "header:X-JWT-Token:Bearer "
        legacy["authConfig"]["whitelist"] = ["/health"]
        self.assertTrue(module.audit_native_jwt(FakeClient(policy=legacy), self.target))

    def test_anonymous_or_bypass_policy_stops_before_writing(self):
        cases = []
        anonymous = native_config(); anonymous["authType"] = "anonymous"; cases.append(anonymous)
        for change in [{"whitelist": ["/analyze"]}, {"blacklist": ["/analyze"]}, {"matchMode": "blacklist"},
                       {"tokenLookup": "header:X-JWT-Token:Bearer,cookie:jwt"}, {"futureUnknownBypass": True},
                       {"claimPassBy": "header:sub:X-JWT-Token"}]:
            value = native_config(); value["authConfig"].update(change); cases.append(value)
        for policy in cases:
            client = FakeClient(policy=policy)
            with self.assertRaises(module.DeployError) as error:
                module.deploy(client, self.target, b"zip")
            self.assertIsNone(client.request)
            self.assertNotIn("public-modulus", str(error.exception))

    def test_matching_custom_domains_must_also_require_jwt(self):
        domain = native_config(); domain["authType"] = "anonymous"
        with self.assertRaises(module.DeployError):
            module.audit_native_jwt(FakeClient(domain_policy=domain), self.target)
        self.assertTrue(module.audit_native_jwt(FakeClient(domain_policy=native_config()), self.target))

    def test_ram_signed_default_url_with_jwt_custom_domain_is_protected(self):
        signed_trigger = {"authType": "function", "methods": ["POST"]}
        self.assertTrue(module.audit_native_jwt(FakeClient(policy=signed_trigger, domain_policy=native_config()), self.target))
        with self.assertRaises(module.DeployError):
            module.audit_native_jwt(FakeClient(policy=signed_trigger), self.target)


def native_config():
    modulus = base64.urlsafe_b64encode(bytes([128]) + bytes([1]) * 255).decode().rstrip("=")
    return {"authType": "jwt", "authConfig": {"jwks": {"keys": [{"kty": "RSA", "alg": "RS256", "use": "sig", "e": "AQAB", "n": modulus}]},
        "tokenLookup": {"readPosition": "header", "parameterName": "X-JWT-Token", "prefix": "Bearer "}}}


if __name__ == "__main__":
    unittest.main()
