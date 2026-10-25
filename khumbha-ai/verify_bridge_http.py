"""Live HTTP verification for the Khumbha local AI bridge.

Starts a mock OpenAI-compatible provider and the real FastAPI bridge as a
subprocess, then exercises the browser-facing routes exactly as the frontend
would. No external model, GPU or internet connection is required.

Run from this directory:

    ..\\.venv\\Scripts\\python.exe verify_bridge_http.py

Exit code 0 means every check passed.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOKEN = "verify-secret-token"
ORIGIN = "https://khumbha.example.com"

captured: list[dict] = []


class MockProvider(BaseHTTPRequestHandler):
    """Minimal real loopback OpenAI-compatible model server."""

    def log_message(self, *args):
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib naming
        if self.path == "/v1/models":
            self._json(200, {"data": [{"id": "mock-verify-model", "owned_by": "verification"}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - stdlib naming
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode())
        captured.append(payload)
        self._json(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "What the data shows\n"
                                "The supplied `last` field is present.\n\n"
                                "Risk / uncertainty\n"
                                "Missing fields are not available.\n\n"
                                "Verify next\n"
                                "Confirm the source timestamp."
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 120, "completion_tokens": 40, "total_tokens": 160},
            },
        )


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_port(port: int, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"port {port} did not open")


def request(port: int, method: str, path: str, body: dict | None = None, headers: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)

    def parse(raw: bytes):
        text = raw.decode(errors="replace")
        if not text:
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, parse(response.read()), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, parse(exc.read()), dict(exc.headers)


def start_bridge(port: int, config: Path, *, token: str) -> subprocess.Popen:
    env = os.environ.copy()
    env.update(
        {
            "AI_PORT": str(port),
            "AI_HOST": "127.0.0.1",
            "AI_PROVIDER_CONFIG": str(config),
            "AI_BRIDGE_TOKEN": token,
            "AI_CORS_ORIGINS": ORIGIN,
        }
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    wait_port(port)
    return proc


def stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        results.append((name, bool(condition), detail))
        print(f"{'PASS' if condition else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))

    mock = ThreadingHTTPServer(("127.0.0.1", 0), MockProvider)
    mock_port = int(mock.server_address[1])
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    bridge_port = _free_port()

    with tempfile.TemporaryDirectory(prefix="khumbha-verify-") as tempdir:
        # --- Phase 1: no token, configured mock provider -------------------
        config = Path(tempdir) / "local-ai.json"
        proc = start_bridge(bridge_port, config, token="")
        try:
            status, health, _ = request(bridge_port, "GET", "/health")
            check("health returns 200", status == 200, str(status))
            check("health reports local AI bridge", health.get("localAi", {}).get("bridge") is True)
            check("health bridge version", health.get("bridgeVersion") == "1.1.0", health.get("bridgeVersion", ""))

            status, providers, _ = request(bridge_port, "GET", "/api/providers?probe=false")
            check("providers list returns 200", status == 200, str(status))
            ids = [p["id"] for p in providers.get("providers", [])]
            check("four provider cards", ids == ["ollama", "lmstudio", "llamacpp", "custom"], ",".join(ids))
            check("defaults present", providers.get("defaults", {}).get("provider") == "ollama")

            status, updated, _ = request(
                bridge_port,
                "PUT",
                "/api/providers/custom",
                {"baseUrl": f"http://127.0.0.1:{mock_port}/v1", "enabled": True, "model": "mock-verify-model"},
            )
            check("custom provider saved", status == 200 and updated.get("provider", {}).get("enabled") is True, str(status))
            check("custom provider reachable", updated.get("provider", {}).get("reachable") is True)
            models = [m["id"] for m in updated.get("provider", {}).get("models", [])]
            check("mock model discovered", models == ["mock-verify-model"], ",".join(models))

            status, defaults, _ = request(
                bridge_port,
                "PUT",
                "/api/ai/defaults",
                {"provider": "custom", "model": "mock-verify-model", "temperature": 0.2, "maxTokens": 900},
            )
            check(
                "analysis defaults saved",
                status == 200 and defaults.get("defaults", {}).get("provider") == "custom",
                str(status),
            )

            status, models_body, _ = request(bridge_port, "GET", "/api/ai/models")
            flat = [(m["provider"], m["id"]) for m in models_body.get("models", [])]
            check("ai/models flattens provider models", ("custom", "mock-verify-model") in flat, str(flat))

            context = {
                "symbol": "RELIANCE",
                "exchange": "NSE",
                "last": 2941.5,
                "changePct": 0.82,
                "volume": 5123441,
                "missingField": None,
            }
            status, analyze, _ = request(
                bridge_port, "POST", "/api/ai/analyze", {"kind": "market_watch_symbol", "context": context}
            )
            data = analyze.get("data", {})
            check("analyze returns 200", status == 200, f"{status} {analyze}")
            check("analyze provider/model", data.get("provider") == "custom" and data.get("model") == "mock-verify-model")
            check("analyze returns grounded fields", data.get("groundedFields") == sorted(context.keys()))
            check("analyze carries disclaimer", "not investment advice" in data.get("disclaimer", ""))
            check("analyze reports latency", isinstance(data.get("latencyMs"), (int, float)) and data["latencyMs"] >= 0)
            check("mock provider received chat call", len(captured) == 1, str(len(captured)))
            if captured:
                sent = captured[0]
                check("request keeps stream disabled", sent.get("stream") is False)
                check("request model matched", sent.get("model") == "mock-verify-model")
                system = sent["messages"][0]
                user = sent["messages"][1]
                check("system prompt forbids advice", "NOT a financial adviser" in system["content"])
                check("system prompt requires grounding", "Use ONLY the JSON context" in system["content"])
                check("user message carries whitelisted context", '"last": 2941.5' in user["content"])
                check("user message marks strings untrusted", "untrusted values" in user["content"])

            status, _, _ = request(bridge_port, "POST", "/api/ai/analyze", {"kind": "not_a_kind", "context": {"a": 1}})
            check("unknown analysis kind rejected", status == 400, str(status))

            status, _, _ = request(bridge_port, "POST", "/api/ai/analyze", {"kind": "generic", "context": {}})
            check("empty context rejected", status == 400, str(status))

            status, _, headers = request(
                bridge_port,
                "OPTIONS",
                "/api/ai/analyze",
                headers={
                    "Origin": ORIGIN,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type,x-khumbha-ai-token",
                    "Access-Control-Request-Private-Network": "true",
                },
            )
            check(
                "CORS preflight allows VM origin",
                status == 200 and headers.get("access-control-allow-origin") == ORIGIN,
                str(status),
            )
            check(
                "preflight allows token header",
                "x-khumbha-ai-token" in headers.get("access-control-allow-headers", "").lower(),
                headers.get("access-control-allow-headers", ""),
            )
            check(
                "preflight allows private network",
                headers.get("access-control-allow-private-network") == "true",
            )

            stored = config.read_text(encoding="utf-8") if config.exists() else ""
            check("provider config persisted to disk", f"127.0.0.1:{mock_port}/v1" in stored)
            check("prompt text not persisted", "Use ONLY the JSON context" not in stored and "RELIANCE" not in stored)
        finally:
            stop(proc)

        # --- Phase 2: token gate --------------------------------------------
        proc = start_bridge(bridge_port, config, token=TOKEN)
        try:
            status, _, _ = request(bridge_port, "GET", "/health")
            check("health stays public with token gate", status == 200, str(status))

            status, _, _ = request(bridge_port, "GET", "/api/ai/status")
            check("token gate rejects missing token", status == 401, str(status))

            status, _, _ = request(bridge_port, "GET", "/api/ai/status", headers={"X-Khumbha-AI-Token": "wrong"})
            check("token gate rejects wrong token", status == 401, str(status))

            status, body, _ = request(bridge_port, "GET", "/api/ai/status", headers={"X-Khumbha-AI-Token": TOKEN})
            check("token gate accepts correct token", status == 200, str(status))
            check("status exposes provider summary", body.get("summary", {}).get("bridge") is True)

            status, analyze, _ = request(
                bridge_port,
                "POST",
                "/api/ai/analyze",
                {"kind": "suggestion_series", "context": {"points": [1, 2, 3], "last": 3}},
                headers={"X-Khumbha-AI-Token": TOKEN},
            )
            check(
                "authorized analyze succeeds",
                status == 200 and analyze.get("data", {}).get("kind") == "suggestion_series",
                str(status),
            )
        finally:
            stop(proc)

        # --- Phase 3: honest unreachable state ------------------------------
        empty_config = Path(tempdir) / "empty.json"
        proc = start_bridge(bridge_port, empty_config, token="")
        try:
            status, updated, _ = request(
                bridge_port,
                "PUT",
                "/api/providers/custom",
                {"baseUrl": "http://127.0.0.1:9/v1", "enabled": True},
            )
            check(
                "unreachable provider reported honestly",
                status == 200 and updated["provider"]["reachable"] is False and bool(updated["provider"]["error"]),
                str(updated.get("provider", {}).get("error")),
            )
            request(bridge_port, "PUT", "/api/ai/defaults", {"provider": "custom", "model": "mock-verify-model"})
            status, analyze, _ = request(bridge_port, "POST", "/api/ai/analyze", {"kind": "generic", "context": {"a": 1}})
            check(
                "analyze fails clearly when provider down",
                status == 502 and "failed" in analyze.get("detail", "").lower(),
                str(status),
            )
        finally:
            stop(proc)

    mock.shutdown()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
