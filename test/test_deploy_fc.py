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

    def test_deploy_retries_read_only_health_when_a_worker_is_still_on_the_old_version(self):
        client = FakeClient(health_commit="a" * 40)
        with patch.object(client, "update_function_with_options", wraps=client.update_function_with_options) as update:
            result = module.deploy(client, self.target, b"zip", sleep=lambda _: setattr(client, "health_commit", "development"))
        self.assertEqual(result["codeVersion"], "development")
        update.assert_called_once()

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
        step = next(step for step in workflow["jobs"]["deploy"]["steps"] if step.get("id") == "deploy")
        self.assertEqual(set(step["env"]), {"ALIYUN_FC_ACCESS_KEY_ID", "ALIYUN_FC_ACCESS_KEY_SECRET"})
        self.assertIn("steps.current.outputs.deploy", step["if"])

    def test_deploy_does_not_query_or_change_trigger_authentication(self):
        client = FakeClient()
        with patch.object(client, "list_triggers", side_effect=AssertionError("Read trigger policy"), create=True), \
             patch.object(client, "list_custom_domains", side_effect=AssertionError("Read domain policy"), create=True):
            self.assertEqual(module.deploy(client, self.target, b"zip", sleep=lambda _: None)["health"], "ok")

    def test_scanner_timer_preserves_message_and_enabled_state(self):
        for enabled in (True, False):
            old = {"cronExpression": "5 */15 * * * *", "payload": "", "enable": enabled}
            updated = {**old, "cronExpression": "5 * * * * *"}
            before, after = [
                SimpleNamespace(body=SimpleNamespace(trigger_type="timer", trigger_config=json.dumps(config)))
                for config in (old, updated)
            ]
            client = SimpleNamespace()
            with patch.object(client, "get_trigger", side_effect=[before, after], create=True) as get, \
                 patch.object(client, "update_trigger", create=True) as update:
                status = module.update_scanner_schedule(client, self.target)
                self.assertEqual(status, "verified" if enabled else "trigger_disabled")
                self.assertEqual(get.call_count, 2)
                update.assert_called_once()
                name, trigger, request = update.call_args.args
                self.assertEqual((name, trigger), ("binance-market-signal", "binance-market-scanner"))
                self.assertEqual(request.body.to_map(), {"triggerConfig": json.dumps(updated)})

    def test_scanner_timer_read_denial_is_reported_without_writing(self):
        client = SimpleNamespace()
        with patch.object(client, "get_trigger", side_effect=PermissionError, create=True), \
             patch.object(client, "update_trigger", create=True) as update:
            self.assertEqual(module.update_scanner_schedule(client, self.target), "unverified_PermissionError")
            update.assert_not_called()


if __name__ == "__main__":
    unittest.main()
