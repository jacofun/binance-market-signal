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
    def __init__(self, *, runtime="custom.debian12", drift=False, failed=False, health_commit="development", node=24):
        self.runtime = runtime
        self.drift = drift
        self.failed = failed
        self.health_commit = health_commit
        self.node = node
        self.request = None

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


if __name__ == "__main__":
    unittest.main()
