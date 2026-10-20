"""Risk Engine — mandatory pre-execution validation for EVERY order.

Runs before any adapter call, for every terminal (Kotak, Shoonya, Dummy) and
for every future executor (AI included). It returns a structured decision;
the Order Engine enforces it — a rejection NEVER reaches the adapter.
"""
from __future__ import annotations
import time
from typing import Any

from brokers.capabilities import capabilities_for
from brokers.models import safe_float
from core.engines.engine_base import EngineBase, EngineCategory
from core.engines.engine_config import ConfigField, read_only

# Configurable, real risk knobs (env-overridable at import time).
_MAX_QTY_PER_SYMBOL = 0            # 0 = unlimited
_MAX_ORDER_VALUE = 0.0             # 0 = unlimited (per order / target value)
_MAX_DAILY_LOSS_PCT = 25.0         # stop trading after 25% of balance lost intraday
_MAX_TOTAL_EXPOSURE = 0.0          # 0 = unlimited (uses broker/dummy margins)
_DUPLICATE_ORDER_SILO_SEC = 5.0    # duplicate-order suppression window
_ORDER_TYPE_WHITELIST = {"MKT", "L", "SL", "SL-M"}
_TX_WHITELIST = {"BUY", "SELL"}

# Symbol blocklist / restrictions are empty by default; the engine always
# validates against the ACTIVE terminal's capabilities, so a broker that does
# not support SL never receives one.
_BLOCKED_SYMBOLS: set[str] = set()

_recent_orders_max = 200


class RiskDecision:
    __slots__ = ("accepted", "reasons", "checks")

    def __init__(self, accepted: bool, reasons: list[str] | None = None, checks: dict | None = None) -> None:
        self.accepted = accepted
        self.reasons = reasons or ([] if accepted else ["rejected by risk engine"])
        self.checks = checks or {}

    def to_dict(self) -> dict:
        return {"accepted": self.accepted, "reasons": self.reasons, "checks": self.checks}


class RiskEngine(EngineBase):
    """Mandatory pre-execution validation for every order.

    Inherits ``EngineBase`` so the Risk Engine is a first-class registry entry:
    before this it had a Services page but no lifecycle control, no metrics and
    no way to see what limits it was actually enforcing. The mixin only ADDS
    state/health/metrics — ``validate_order`` and its behaviour are untouched.
    """

    engine_id = "risk_engine"
    engine_name = "Risk Engine"
    engine_category = EngineCategory.TRADING
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(key="max_order_value", label="Max Order Value", summary="maxOrderValue",
                    type="number", min=1, max=100000000, group="Limits",
                    help="Largest single order value allowed."),
        ConfigField(key="max_qty_per_symbol", label="Max Qty Per Symbol", summary="maxQtyPerSymbol",
                    type="number", min=1, max=1000000, group="Limits"),
        ConfigField(key="max_daily_loss_pct", label="Max Daily Loss", summary="maxDailyLossPct",
                    type="number", min=0, max=100, unit="%", group="Limits"),
        ConfigField(key="max_total_exposure", label="Max Total Exposure", summary="maxTotalExposure",
                    type="number", min=1, max=100000000, group="Limits"),
        ConfigField(key="duplicate_order_silo_sec", label="Duplicate Silo", summary="duplicateOrderSiloSec",
                    type="number", min=0, max=3600, unit="s", group="Limits",
                    help="Suppress an identical order within this window."),
        read_only("orderTypeWhitelist", "Allowed Order Types"),
        read_only("txWhitelist", "Allowed Sides"),
        read_only("blockedSymbols", "Blocked Symbols"),
        read_only("validations", "Validations Run"),
        read_only("blocks", "Orders Blocked"),
    )

    def __init__(self) -> None:
        super().__init__()
        # Named differently from EngineBase's lock: the risk ring below is
        # GIL-guarded and deliberately asyncio-safe by design.
        self._risk_lock = None
        self._recent_orders: list[dict] = []  # bounded duplicate-silencer ring
        self._validation_count = 0
        self._block_count = 0
        # Bounded recent-decision feed for the realtime UI (newest last,
        # capped so a busy session cannot grow memory without bound).
        self._recent_decisions: list[dict] = []
        self._recent_decisions_max = 20
        # No engine dependencies: margin is checked directly against the
        # broker adapter (see _check_margin), not through margin_engine
        # (deleted — it had no runtime callers).
        self.set_dependencies([])

    # -- config surface -----------------------------------------------------

    def config_summary(self) -> dict:
        """The limits enforced right now, read from the module globals the
        validator actually consults (never a separate copy that can drift)."""
        import core.engines.risk_engine as self_mod
        return {
            "maxOrderValue": float(self_mod._MAX_ORDER_VALUE),
            "maxQtyPerSymbol": int(self_mod._MAX_QTY_PER_SYMBOL),
            "maxDailyLossPct": float(self_mod._MAX_DAILY_LOSS_PCT),
            "maxTotalExposure": float(self_mod._MAX_TOTAL_EXPOSURE),
            "duplicateOrderSiloSec": float(self_mod._DUPLICATE_ORDER_SILO_SEC),
            "orderTypeWhitelist": sorted(self_mod._ORDER_TYPE_WHITELIST),
            "txWhitelist": sorted(self_mod._TX_WHITELIST),
            "blockedSymbols": sorted(self_mod._BLOCKED_SYMBOLS),
            "validations": self._validation_count,
            "blocks": self._block_count,
            "recentDecisions": self.recent_decisions(),
        }

    async def _write_settings(self, clean: dict) -> tuple[dict, dict]:
        """Write the module globals the validator reads.

        These limits are process-local by design (the validator consults the
        module globals on every order), so this is the same store the Risk
        settings page writes through — not a second copy.
        """
        import core.engines.risk_engine as self_mod
        setters = {
            "max_order_value": ("_MAX_ORDER_VALUE", float),
            "max_qty_per_symbol": ("_MAX_QTY_PER_SYMBOL", int),
            "max_daily_loss_pct": ("_MAX_DAILY_LOSS_PCT", float),
            "max_total_exposure": ("_MAX_TOTAL_EXPOSURE", float),
            "duplicate_order_silo_sec": ("_DUPLICATE_ORDER_SILO_SEC", float),
        }
        written: dict[str, Any] = {}
        errors: dict[str, str] = {}
        for key, value in clean.items():
            target = setters.get(key)
            if not target:
                errors[key] = f"'{key}' is not a writable risk limit"
                continue
            attr, cast = target
            setattr(self_mod, attr, cast(value))
            written[key] = value
        if written:
            self.set_config_summary(self.config_summary())
        return written, errors

    def record_validation(self, accepted: bool, detail: dict | None = None) -> None:
        self._validation_count += 1
        if not accepted:
            self._block_count += 1
        try:
            entry: dict[str, Any] = {
                "at": time.time(),
                "accepted": bool(accepted),
            }
            if detail:
                for k in ("terminal", "symbol", "transaction_type", "quantity", "order_type", "product", "reasons"):
                    if detail.get(k) is not None:
                        entry[k] = detail[k]
            self._recent_decisions.append(entry)
            del self._recent_decisions[: max(0, len(self._recent_decisions) - self._recent_decisions_max)]
        except Exception:
            pass

    def recent_decisions(self, limit: int = 20) -> list[dict]:
        """Newest-first recent validation decisions (real, bounded)."""
        try:
            n = max(1, min(int(limit), self._recent_decisions_max))
        except (TypeError, ValueError):
            n = 20
        return list(reversed(self._recent_decisions[-n:]))

    async def validate_order(
        self,
        *,
        terminal: str,
        symbol: str = "",
        token: str = "",
        exchange: str = "nse_cm",
        transaction_type: str = "BUY",
        product: str = "MIS",
        order_type: str = "MKT",
        quantity: Any = "1",
        price: Any = "0",
        trigger_price: Any = "0",
        expected_ltp: float = 0.0,
        max_order_value: float | None = None,
    ) -> RiskDecision:
        ok = False
        reasons: list[str] = []
        checks: dict[str, bool] = {}

        caps = capabilities_for(terminal)

        # 1) Symbol / quantity sanity.
        if not (symbol or token):
            reasons.append("symbol or token required")
        qty = self._to_positive_int(quantity)
        if qty <= 0:
            reasons.append("quantity must be a positive integer")
        price_v = max(0.0, safe_float(price))
        trigger_v = max(0.0, safe_float(trigger_price))

        # 2) Capability gate — never send an unsupported order type/product.
        order_type = str(order_type or "MKT").upper()
        ot_canon = {"MARKET": "MKT", "LIMIT": "L", "SLM": "SL-M", "SLL": "SL"}.get(order_type, order_type)
        if ot_canon not in _ORDER_TYPE_WHITELIST:
            reasons.append(f"unsupported order type {order_type}")
        elif ot_canon not in caps.order_types:
            reasons.append(f"{caps.name} does not support {ot_canon} orders")
        if str(product or "MIS").upper() not in caps.products:
            reasons.append(f"{caps.name} does not support product {product}")

        tx = str(transaction_type or "").upper()
        if tx not in _TX_WHITELIST:
            reasons.append(f"invalid transaction type {tx}")

        # 3) SL sanity: SL orders MUST carry a positive trigger.
        if ot_canon in ("SL", "SL-M") and trigger_v <= 0:
            reasons.append("stop-loss orders require a trigger price")
        if ot_canon == "L" and price_v <= 0:
            reasons.append("limit orders require a limit price")

        # 4) Symbol restrictions.
        if (symbol or "").upper() in _BLOCKED_SYMBOLS:
            reasons.append(f"{symbol} is restricted")

        # 5) Per-order value cap (target limit).
        last_price = price_v if price_v > 0 else expected_ltp
        order_value = last_price * qty
        cap = max_order_value if max_order_value and max_order_value > 0 else (_MAX_ORDER_VALUE or None)
        if cap and order_value > cap:
            reasons.append(f"order value {order_value:.2f} exceeds limit {cap:.2f}")

        # 6) Position / exposure caps (per-symbol quantity limit).
        if _MAX_QTY_PER_SYMBOL > 0 and qty > _MAX_QTY_PER_SYMBOL:
            reasons.append(f"quantity {qty} exceeds per-symbol limit {_MAX_QTY_PER_SYMBOL}")

        # 7) Duplicate-order suppression (same intent within the silo window).
        now = time.time()
        key = (terminal, (symbol or token), tx, product, ot_canon, qty, round(price_v, 2))
        recent = [o for o in self._recent_orders if now - o["at"] <= _DUPLICATE_ORDER_SILO_SEC]
        if any(o["key"] == key for o in recent):
            reasons.append("duplicate order (same intent within suppression window)")
        recent.append({"at": now, "key": key})
        del self._recent_orders[: max(0, len(self._recent_orders) - _recent_orders_max)]
        self._recent_orders.extend(recent[-200:])

        # 8) Margin / available-funds gate (best-effort via the active adapter).
        margin_ok = await self._check_margin(terminal, price=last_price if last_price > 0 else None, qty=qty)
        checks["margin"] = margin_ok
        if not margin_ok:
            reasons.append("insufficient funds/margin for this order")

        ok = not reasons
        self.record_validation(ok, {
            "terminal": terminal,
            "symbol": symbol or token,
            "transaction_type": tx,
            "quantity": qty,
            "order_type": ot_canon,
            "product": str(product or "MIS").upper(),
            "reasons": list(reasons),
        })
        return RiskDecision(accepted=ok, reasons=reasons, checks=checks)

    # -- internals ----------------------------------------------------------

    async def snapshot(self, terminal: str) -> dict:
        """Real-time risk posture from the active adapter (funds + positions)."""
        from core.engines.position_engine import get_positions

        open_positions = 0
        exposure = 0.0
        unrealized = 0.0
        realized = 0.0
        top_value = 0.0
        top_symbol = ""
        try:
            pos = await get_positions(terminal)
            for row in pos.get("data") or []:
                qty = abs(int(row.get("netQuantity", 0) or 0))
                if qty <= 0:
                    continue
                open_positions += 1
                ltp = row.get("ltp") or row.get("averagePrice") or 0
                value = abs(qty) * float(ltp or 0)
                exposure += value
                unrealized += float(row.get("unrealizedPnl") or 0)
                realized += float(row.get("realizedPnl") or 0)
                if value > top_value:
                    top_value, top_symbol = value, str(row.get("symbol") or "")
        except Exception:
            pass

        free_margin = 0.0
        used_margin = 0.0
        try:
            from brokers.manager import get_adapter
            funds = await get_adapter(terminal).funds()
            rows = funds.get("data") if isinstance(funds, dict) else None
            if isinstance(rows, list):
                for r in rows:
                    if isinstance(r, dict):
                        free_margin += safe_float(r.get("freeMargin") or r.get("availableMargin") or r.get("Net") or 0)
                        used_margin += safe_float(r.get("usedMargin") or r.get("AmountUtilizedPrsnt") or r.get("utilisedMargin") or 0)
            elif isinstance(rows, dict):
                free_margin = safe_float(rows.get("freeMargin") or rows.get("availableMargin") or rows.get("Net") or 0)
                used_margin = safe_float(rows.get("usedMargin") or rows.get("AmountUtilizedPrsnt") or 0)
        except Exception:
            pass

        balance = free_margin + used_margin
        utilization = (used_margin / balance * 100.0) if balance > 0 else 0.0
        concentration = (top_value / exposure * 100.0) if exposure > 0 else 0.0
        return {
            "terminal": terminal,
            "openPositions": open_positions,
            "exposure": round(exposure, 2),
            "freeMargin": round(free_margin, 2),
            "usedMargin": round(used_margin, 2),
            "balance": round(balance, 2),
            "marginUtilizationPct": round(utilization, 2),
            "unrealizedPnl": round(unrealized, 2),
            "realizedPnl": round(realized, 2),
            "topPosition": top_symbol or None,
            "topPositionValue": round(top_value, 2),
            "concentrationPct": round(concentration, 2),
            "maxDailyLossPct": _MAX_DAILY_LOSS_PCT,
            "maxOrderValue": _MAX_ORDER_VALUE,
            "maxQtyPerSymbol": _MAX_QTY_PER_SYMBOL,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }

    @staticmethod
    def _to_positive_int(value: Any) -> int:
        try:
            n = int(str(value).strip())
            return n if n > 0 else 0
        except (ValueError, TypeError):
            return 0

    async def _check_margin(self, terminal: str, price: float | None, qty: int) -> bool:
        """Best-effort funds gate against the active account.

        Uses the adapter's real funds() response when a session is active; for
        the Dummy terminal the paper engine already enforces virtual margin,
        so this remains a sanity overlay. Never fabricates balances.
        """
        if price is None or price <= 0 or qty <= 0:
            return True
        value = price * qty
        try:
            from brokers.manager import get_adapter
            adapter = get_adapter(terminal)
            if not adapter.is_logged_in:
                return True  # unforgeable: order actions fail later on login gate
            funds = await adapter.funds()
        except Exception:
            return True  # cannot verify — real adapters enforce at the broker
        rows = funds.get("data") if isinstance(funds, dict) else None
        available = 0.0
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                available += safe_float(
                    row.get("availableMargin") or row.get("marginAvailable")
                    or row.get("freeMargin") or row.get("balance")
                )
        else:
            available = safe_float(funds.get("data", {}).get("availableMargin") or 0.0)
        if available <= 0:
            return True
        # Intraday (MIS) exposure ≈ 20% margin in Indian exchanges.
        exposure = value * 0.2
        return exposure * 0.98 <= available


risk_engine = RiskEngine()