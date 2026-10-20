"""Unit tests for the data-quality scorer (deterministic, no DB required).

Covers the pure scoring/status helpers in services.data_quality: rate-to-score
units, grade mapping, per-dimension status thresholds, weighted score and the
duplicate-rate (redundant-row) semantics that drive the Uniqueness dimension.
Run with:  python -m unittest tests.test_data_quality
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.data_quality import (  # noqa: E402
    _dim_detail,
    _grade,
    _pct,
    _posrate,
    _rate_status,
    _score_dimensions,
    DEFAULT_CONFIG,
)


class RateStatusTest(unittest.TestCase):
    def test_healthy_below_warn(self):
        self.assertEqual(_rate_status(0.5, 2.0, 4.0), "healthy")

    def test_warning_at_or_above_warn(self):
        self.assertEqual(_rate_status(2.0, 2.0, 4.0), "warning")

    def test_critical_at_or_above_crit(self):
        self.assertEqual(_rate_status(4.0, 2.0, 4.0), "critical")

    def test_not_measured(self):
        self.assertEqual(_rate_status(None, 2.0, 4.0), "not_measured")


class DimDetailTest(unittest.TestCase):
    def test_rate_is_percent_not_fraction(self):
        # rate is already a percent (0-100); score == 100 - rate
        detail = _dim_detail("Uniqueness", 50.6, 0.15, 1000, 506, "dup", warn=2.0, crit=4.0)
        self.assertEqual(detail["score"], 49.4)
        self.assertEqual(detail["status"], "critical")

    def test_zero_rate_is_healthy_and_full_score(self):
        detail = _dim_detail("Validity", 0.0, 0.2, 500, 0, "ok", warn=2.0, crit=4.0)
        self.assertEqual(detail["score"], 100.0)
        self.assertEqual(detail["status"], "healthy")

    def test_none_rate_not_measured(self):
        detail = _dim_detail("Volume", None, 0.05, 0, 0, "none", warn=2.0, crit=4.0)
        self.assertIsNone(detail["score"])
        self.assertEqual(detail["status"], "not_measured")


class GradeTest(unittest.TestCase):
    def test_grades(self):
        self.assertEqual(_grade(None), "Not measured")
        self.assertEqual(_grade(96.0), "Excellent")
        self.assertEqual(_grade(85.0), "Good")
        self.assertEqual(_grade(70.0), "Needs Attention")
        self.assertEqual(_grade(40.0), "Critical")


class PercentTest(unittest.TestCase):
    def test_pct(self):
        self.assertEqual(_pct(50, 100), 50.0)
        self.assertAlmostEqual(_pct(1, 3), 33.3333, places=3)
        self.assertIsNone(_pct(1, 0))
        self.assertIsNone(_pct(0, 0))

    def test_posrate(self):
        self.assertEqual(_posrate(0, 100), 100.0)
        self.assertEqual(_posrate(25, 100), 75.0)
        self.assertEqual(_posrate(0, 0), 100.0)


class ScoreDimensionsTest(unittest.TestCase):
    def _metrics(self, duplicates=0, total=1000):
        return {
            "totals": {"totalTicks": total, "attemptedSaves": total},
            "errors": {
                "missing": 0, "duplicates": duplicates, "outOfOrder": 0,
                "timestampErrors": 0, "invalidLtp": 0, "invalidVolume": 0,
                "schemaErrors": 0, "saveFailures": 0,
            },
            "rates": {
                "duplicateRate": _pct(duplicates, total),
                "outOfOrderRate": 0.0, "timestampErrorRate": 0.0,
                "ltpErrorRate": 0.0, "volumeErrorRate": 0.0,
                "schemaErrorRate": 0.0, "saveFailureRate": 0.0,
            },
            "pipeline": {"received": total, "written": total, "writeErrors": 0},
            "websocket": {},
            "freshness": {
                "latestTick": None, "ageSeconds": None,
                "dbLatestTick": None,
            },
        }

    def test_pristine_score_is_excellent(self):
        score = _score_dimensions(self._metrics(duplicates=0, total=1000), DEFAULT_CONFIG)
        self.assertEqual(score["score"], 100.0)
        self.assertEqual(score["grade"], "Excellent")
        self.assertEqual(score["unmeasured"], [])

    def test_duplicate_rate_drags_uniqueness(self):
        # 50% duplicate rate -> Uniqueness score 50, weighted impact ~7.5 pts.
        score = _score_dimensions(self._metrics(duplicates=500, total=1000), DEFAULT_CONFIG)
        self.assertEqual(score["dimensions"]["Uniqueness"]["score"], 50.0)
        # (0.15 * 50) replaces (0.15 * 100) -> 92.5
        self.assertEqual(score["score"], 92.5)
        self.assertEqual(score["grade"], "Good")

    def test_dimension_weights_preserved(self):
        weights = DEFAULT_CONFIG["weights"]
        score = _score_dimensions(self._metrics(duplicates=0, total=1000), DEFAULT_CONFIG)
        self.assertEqual(score["weights"], weights)

    def test_each_dimension_exposes_detail_fields(self):
        score = _score_dimensions(self._metrics(duplicates=500, total=1000), DEFAULT_CONFIG)
        for detail in score["dimensions"].values():
            for key in ("score", "weight", "status", "affected_records",
                        "explanation", "last_calculated_at"):
                self.assertIn(key, detail)


if __name__ == "__main__":
    unittest.main()
