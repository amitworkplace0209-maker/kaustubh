"""Tests for the local AI provider bridge.

Run from this directory:

    ..\\.venv\\Scripts\\python.exe -m unittest -v test_local_ai

The provider integration test uses a real loopback HTTP server that speaks the
OpenAI-compatible protocol. No external model, GPU or internet connection is
required.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import local_ai

_REQUESTS: list[dict] = []


class _MockProviderHandler(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible model server used by the integration test."""

    def log_message(self, *args):  # noqa: D401 - silence the test server
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib naming
        if self.path == "/v1/models":
            self._json(200, {"data": [{"id": "mock-model", "owned_by": "test"}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - stdlib naming
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        _REQUESTS.append(payload)
        self._json(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "What the data shows\n"
                                "The supplied LTP is present.\n\n"
                                "Risk / uncertainty\n"
                                "Missing fields are not available.\n\n"
                                "Verify next\n"
                                "Confirm the live feed state."
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 42, "completion_tokens": 30, "total_tokens": 72},
            },
        )


_SERVER: ThreadingHTTPServer | None = None
_PORT: int | None = None
_CONFIG_DIR: str | None = None
_main = None


def setUpModule():  # noqa: N802 - unittest hook
    global _SERVER, _PORT, _CONFIG_DIR, _main
    _SERVER = ThreadingHTTPServer(("127.0.0.1", 0), _MockProviderHandler)
    _PORT = _SERVER.server_address[1]
    thread = threading.Thread(target=_SERVER.serve_forever, daemon=True)
    thread.start()

    # Point main.py's registry at a throwaway config before importing it.
    _CONFIG_DIR = tempfile.mkdtemp(prefix="khumbha-ai-test-")
    os.environ["AI_PROVIDER_CONFIG"] = os.path.join(_CONFIG_DIR, "local-ai.json")
    import main  # noqa: PLC0415 - deliberately after the env is set

    _main = main


def tearDownModule():  # noqa: N802 - unittest hook
    if _SERVER is not None:
        _SERVER.shutdown()
        _SERVER.server_close()
    if _CONFIG_DIR:
        shutil.rmtree(_CONFIG_DIR, ignore_errors=True)
    os.environ.pop("AI_PROVIDER_CONFIG", None)


class UrlValidationTests(unittest.TestCase):
    def test_accepts_loopback_and_lan(self):
        self.assertEqual(local_ai.normalize_base_url("http://127.0.0.1:11434/"), "http://127.0.0.1:11434")
        self.assertEqual(local_ai.normalize_base_url(" http://192.168.1.5:8001/// "), "http://192.168.1.5:8001")

    def test_rejects_unsafe_values(self):
        for value in ["", "127.0.0.1:11434", "ftp://127.0.0.1", "http://user:pass@127.0.0.1", "javascript:x"]:
            with self.assertRaises(ValueError, msg=value):
                local_ai.normalize_base_url(value)

    def test_rejects_metadata_host(self):
        with self.assertRaises(ValueError):
            local_ai.normalize_base_url("http://169.254.169.254/latest/meta-data")


class ModelNormalizationTests(unittest.TestCase):
    def test_ollama_shape(self):
        models = local_ai.normalize_models(
            "ollama",
            {
                "models": [
                    {
                        "name": "llama3.2:3b",
                        "model": "llama3.2:3b",
                        "size": 2_000_000_000,
                        "modified_at": "2026-01-01T00:00:00Z",
                        "details": {"family": "llama", "parameter_size": "3B", "quantization_level": "Q4_K_M"},
                    }
                ]
            },
        )
        self.assertEqual(models[0]["id"], "llama3.2:3b")
        self.assertEqual(models[0]["family"], "llama")
        self.assertEqual(models[0]["parameterSize"], "3B")
        self.assertEqual(models[0]["quantization"], "Q4_K_M")

    def test_openai_shape(self):
        models = local_ai.normalize_models("openai", {"data": [{"id": "qwen2.5-7b-instruct"}]})
        self.assertEqual([m["id"] for m in models], ["qwen2.5-7b-instruct"])

    def test_empty_shapes_do_not_crash(self):
        self.assertEqual(local_ai.normalize_models("ollama", {}), [])
        self.assertEqual(local_ai.normalize_models("openai", {"data": "nope"}), [])


class PromptTests(unittest.TestCase):
    def test_analysis_prompt_contains_guardrails_and_context(self):
        messages = local_ai.build_analysis_messages(
            "market_watch_symbol",
            {"symbol": "RELIANCE", "record": {"ltp": 1425.5}},
            question="Explain the move",
        )
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("Never invent", messages[0]["content"])
        self.assertIn("Do not recommend", messages[0]["content"])
        user = messages[1]["content"]
        self.assertIn("market_watch_symbol", user)
        self.assertIn("RELIANCE", user)
        self.assertIn("Explain the move", user)

    def test_invalid_kind_rejected(self):
        with self.assertRaises(ValueError):
            local_ai.build_analysis_messages("trading_signal", {"a": 1})

    def test_oversized_context_rejected_instead_of_truncated(self):
        with self.assertRaises(ValueError):
            local_ai.build_analysis_messages("generic", {"blob": "x" * (local_ai.MAX_CONTEXT_CHARS + 1)})

    def test_message_validation(self):
        with self.assertRaises(ValueError):
            local_ai.validate_messages([])
        with self.assertRaises(ValueError):
            local_ai.validate_messages([{"role": "tool", "content": "x"}])
        with self.assertRaises(ValueError):
            local_ai.validate_messages([{"role": "user", "content": ""}])
        cleaned = local_ai.validate_messages([{"role": "user", "content": "hi", "extra": "drop"}])
        self.assertEqual(cleaned, [{"role": "user", "content": "hi"}])


class RegistryConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "local-ai.json"
        self.registry = local_ai.ProviderRegistry(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_defaults_exist_and_are_disabled_honestly(self):
        snapshot = self.registry.snapshot(probe=False)
        ids = {provider["id"] for provider in snapshot["providers"]}
        self.assertEqual(ids, {"ollama", "lmstudio", "llamacpp", "custom"})
        custom = next(p for p in snapshot["providers"] if p["id"] == "custom")
        self.assertFalse(custom["enabled"])
        self.assertFalse(custom["reachable"])
        self.assertIsNone(custom["error"])

    def test_provider_update_persists(self):
        self.registry.update_provider(
            "custom",
            {"baseUrl": "http://127.0.0.1:9999/v1", "enabled": True, "model": "my-model"},
        )
        reloaded = local_ai.ProviderRegistry(self.path)
        provider = reloaded.provider("custom")
        self.assertEqual(provider["base_url"], "http://127.0.0.1:9999/v1")
        self.assertTrue(provider["enabled"])
        self.assertEqual(provider["model"], "my-model")

    def test_defaults_update_validates_values(self):
        defaults = self.registry.update_defaults({"temperature": 9, "maxTokens": 99999})
        self.assertEqual(defaults["temperature"], 2.0)
        self.assertEqual(defaults["max_tokens"], 8192)

    def test_unknown_provider_is_rejected(self):
        with self.assertRaises(KeyError):
            self.registry.update_provider("missing", {"enabled": True})

    def test_summary_does_not_count_a_disabled_provider(self):
        self.registry._cache["ollama"] = {
            "ts": time.time(),
            "result": {"reachable": True, "models": [], "error": None, "checkedAt": "x"},
        }
        self.registry.update_provider("ollama", {"enabled": False})
        self.assertEqual(self.registry.summary()["providersReachable"], 0)


class ProviderIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.registry = local_ai.ProviderRegistry(Path(self.temp.name) / "local-ai.json")
        self.registry.update_provider(
            "custom",
            {
                "baseUrl": f"http://127.0.0.1:{_PORT}/v1",
                "enabled": True,
                "model": "mock-model",
            },
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_probe_discovers_real_models(self):
        result = self.registry.probe("custom")
        self.assertTrue(result["reachable"], result)
        self.assertEqual([m["id"] for m in result["models"]], ["mock-model"])

    def test_chat_returns_real_provider_text(self):
        result = self.registry.chat([{"role": "user", "content": "hello"}], provider_id="custom")
        self.assertEqual(result["provider"], "custom")
        self.assertEqual(result["model"], "mock-model")
        self.assertIn("What the data shows", result["content"])
        self.assertEqual(result["usage"]["totalTokens"], 72)

    def test_analyze_adds_grounding_and_disclaimer(self):
        result = self.registry.analyze(
            "market_watch_symbol",
            {"symbol": "RELIANCE", "record": {"ltp": 1425.5}},
            provider_id="custom",
        )
        self.assertEqual(result["kind"], "market_watch_symbol")
        self.assertEqual(result["groundedFields"], ["record", "symbol"])
        self.assertIn("not investment advice", result["disclaimer"])
        self.assertGreater(result["contextChars"], 0)
        self.assertTrue(_REQUESTS, "the mock provider must have received a request")
        sent = _REQUESTS[-1]
        self.assertEqual(sent["model"], "mock-model")
        self.assertIn("Never invent", sent["messages"][0]["content"])

    def test_unreachable_provider_stays_unreachable(self):
        self.registry.update_provider(
            "custom",
            {"baseUrl": "http://127.0.0.1:1/v1", "enabled": True, "model": "mock-model"},
        )
        result = self.registry.probe("custom", timeout=0.4)
        self.assertFalse(result["reachable"])
        self.assertTrue(result["error"])

    def test_snapshot_probe_refreshes_a_stale_cache(self):
        for provider_id in ("ollama", "lmstudio", "llamacpp"):
            self.registry.update_provider(provider_id, {"enabled": False})

        first = self.registry.snapshot(probe=True)
        custom = next(p for p in first["providers"] if p["id"] == "custom")
        self.assertTrue(custom["reachable"], custom)

        # Age the cached entry past the TTL; a real `probe=true` must refresh
        # instead of serving that entry forever.
        self.registry._cache["custom"]["ts"] = time.time() - (local_ai.PROBE_TTL_SEC + 1)
        second = self.registry.snapshot(probe=True)
        custom = next(p for p in second["providers"] if p["id"] == "custom")
        self.assertTrue(custom["reachable"], custom)
        self.assertFalse(custom["cached"], custom)


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient  # noqa: PLC0415

        cls.client = TestClient(_main.app)

    def test_health_reports_bridge(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], "khumbha-ai-runtime")
        self.assertTrue(body["localAi"]["bridge"])

    def test_provider_registry_route(self):
        response = self.client.get("/api/providers?probe=false")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["bridge"])
        self.assertIsInstance(body["providers"], list)
        self.assertIn("defaults", body)

    def test_status_route(self):
        response = self.client.get("/api/ai/status")
        self.assertEqual(response.status_code, 200)
        self.assertIn("summary", response.json())

    def test_invalid_analysis_kind_is_400(self):
        response = self.client.post(
            "/api/ai/analyze",
            json={"kind": "not-real", "context": {"a": 1}},
        )
        self.assertEqual(response.status_code, 400)

    def test_cors_preflight_for_loopback_origin(self):
        response = self.client.options(
            "/api/ai/analyze",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertIn(response.status_code, (200, 204))
        self.assertEqual(response.headers.get("access-control-allow-origin"), "http://localhost:3000")
        self.assertEqual(response.headers.get("access-control-allow-private-network"), "true")


if __name__ == "__main__":
    unittest.main(verbosity=2)
