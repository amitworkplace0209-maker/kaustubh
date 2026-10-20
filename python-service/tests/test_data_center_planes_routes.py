"""Route-wiring test for the six Data Center plane endpoints.

Exercises the REAL FastAPI app (real router, real path params, real response
models) via TestClient so a missing ``@router.get`` or a bad path fails here
rather than as a 404 in the browser.

Run:  python -m pytest tests/test_data_center_planes_routes.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

PLANE_PATHS = [
    "/api/system/data-center/database",
    "/api/system/data-center/engines",
    "/api/system/data-center/topology",
    "/api/system/data-center/db-writer",
    "/api/system/data-center/ownership",
    "/api/system/data-center/retention",
]


class PlaneRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from api.data_center import router

        # A bare app with just this router: no service bootstrap, no DB, no broker.
        app = FastAPI()
        app.include_router(router)
        cls.client = TestClient(app)

    def test_every_plane_path_is_registered(self):
        for path in PLANE_PATHS:
            with self.subTest(path=path):
                with mock.patch(
                    "api.data_center._get_or_build",
                    new=_ok_stub,
                ):
                    res = self.client.get(path)
                self.assertEqual(res.status_code, 200, f"{path} is not wired")
                body = res.json()
                self.assertTrue(body["ok"], f"{path} returned not-ok: {body}")

    def test_unknown_plane_path_is_404_not_a_silent_success(self):
        self.assertEqual(self.client.get("/api/system/data-center/nope").status_code, 404)

    def test_retention_limit_is_honoured_through_the_real_route(self):
        seen = []

        async def _capture(key, ttl, builder, *args):
            seen.append((key, args))
            return {"plane": "retention", "ttlIndexes": []}

        with mock.patch("api.data_center._get_or_build", new=_capture):
            res = self.client.get("/api/system/data-center/retention?limit=7")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(seen[0][1], (7,))
        self.assertIn("limit=7", seen[0][0])

    def test_plane_failure_returns_503_with_a_reason(self):
        """A raising plane must surface as 503 + reason, not an unhandled 500.

        The *builder* is replaced (not ``_get_or_build``) so the real
        single-flight/error path in ``_get_or_build`` is the thing under test.
        """
        from services import data_center_planes

        async def _boom():
            raise RuntimeError("mongo down")

        planes = dict(data_center_planes.PLANES)
        planes["ownership"] = _boom
        with mock.patch.dict(data_center_planes.__dict__, {"PLANES": planes}):
            res = self.client.get("/api/system/data-center/ownership")
        self.assertEqual(res.status_code, 503)
        self.assertFalse(res.json()["ok"])
        self.assertIsNotNone(res.json()["error"])

    def test_no_plane_payload_contains_a_uri_or_secret(self):
        for path in PLANE_PATHS:
            with self.subTest(path=path):
                with mock.patch("api.data_center._get_or_build", new=_ok_stub):
                    text = self.client.get(path).text.lower()
                for banned in ("mongodb+srv://", "mongodb://", "password", '"uri"', "apikey", "secret"):
                    self.assertNotIn(banned, text, f"{path} leaked {banned}")


async def _ok_stub(key, ttl, builder, *args):
    return {"plane": "stub", "available": True, "source": "test", "generatedAt": None}


if __name__ == "__main__":
    unittest.main()
