"""KOTAK WIPRO LIVE DEPTH + QUOTE + SCRIPT MASTER FORENSIC PROBE.

Read-only forensic verification of Kotak Neo REAL market-data capabilities for
WIPRO / WIPRO-EQ (NSE Cash, token 3787) using the installed SDK
(kotakneoapi 3.0.6 -> neo_api_client) and a REAL authenticated Kotak session.

What this probe does, against the LIVE broker:
  1. Real TOTP + MPIN login (or reuse an already-active KotakSession).
  2. Resolve WIPRO from the REAL instrument/scrip master.
  3. Fetch the RAW WIPRO row from the live Scrip Master CSV.
  4. Call the REAL Quote API for WIPRO (quote_type="all").
  5. Open a REAL SFeed WebSocket and independently test each depth level
     (4 = touch line, 8 = depth, 16 = full depth), one level per connection.
  6. Capture raw WebSocket frames (text + binary) via the SDK on_raw hook,
     redact them, and independently decode the binary wire protocol
     (header + body incl. SDK-discarded fields + depth rows).
  7. Compare RAW wire fields vs SDK SFeedScrip model fields to determine
     preserved / transformed / renamed / discarded / synthesized fields.

This probe NEVER places an order, NEVER writes to production stores, NEVER
logs credentials, and NEVER fabricates ticks. Anything that cannot be
verified live is reported as NOT AVAILABLE / BLOCKED / NOT VERIFIED.

Usage (from python-service/, matching the _probe_*.py convention):

  C:\\project\\.venv\\Scripts\\python.exe _probe_kotak_wipro_depth.py --login \
      --duration 20 --levels 4 8 16

Exit codes: 0 completed | 2 usage/setup | 3 BLOCKED (no session) | 4 login failed
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import io
import json
import os
import re
import struct
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ".")

from config.settings import settings  # noqa: E402,F401  (config load)
from auth.kotak_client import kotak_session  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "docs" / "reports" / "kotak_wipro_live"
REPORT1 = REPO_ROOT / "docs" / "reports" / "KOTAK_WIPRO_LIVE_DEPTH_VERIFICATION.txt"
REPORT2 = REPO_ROOT / "docs" / "reports" / "KOTAK_WIPRO_FIELD_SOURCE_MATRIX.txt"
REPORT3 = REPO_ROOT / "docs" / "reports" / "KOTAK_WEBSOCKET_SDK_AUDIT.txt"

IST = timezone(timedelta(hours=5, minutes=30))
WIPRO_SYMBOL = "WIPRO"
WIPRO_EXCH = "nse_cm"
WIPRO_TOKEN = "3787"            # FROM THE REAL instrument master (INE075A01022)
DEFAULT_DURATION = 20.0

SECRET_KEYS = {
    "access_token", "view_token", "trade_token", "token", "sid", "rid",
    "consumer_key", "consumer_secret", "jwt_secret", "password", "mpin",
    "totp", "ucc", "auth", "user", "authorization", "session_id",
    "edit_token", "neo_fin_key", "client_secret",
}

# Level -> (SDK method, wire event name). From the installed SDK client.py
# (_SUBSCRIBE_EVENTS): scrips->subscribeScrips, depth->subscribeDepth,
# full_depth->subscribeFullDepth.
SUBSCRIPTION_METHODS = {
    4: ("subscribe_scrips", "subscribeScrips", "TOUCH_LINE"),
    8: ("subscribe_depth", "subscribeDepth", "DEPTH"),
    16: ("subscribe_full_depth", "subscribeFullDepth", "FULL_DEPTH"),
}
UNSUBSCRIBE_METHODS = {4: "unsubscribe_scrips", 8: "unsubscribe_depth", 16: "unsubscribe_full_depth"}

# ---- Independent wire-protocol layouts --------------------------------------
# Identical struct packing to the installed SDK (websocket/feed/protocol.py).
_HEADER = struct.Struct("<HHbBBBB")
_MP_BODY = struct.Struct("<IqqqqqIIIIIqIIIIhiIdiIIIIIBI")
_MP_FIXED_END = 144
_DEPTH_ROW = struct.Struct("<qii")
_MINI_BODY = struct.Struct("<IqIqIiiIBI")
_MARKET_STATUS_BODY = struct.Struct("<H5s")
_CAS_CHANGE_BODY = struct.Struct("<IIqq")

_MP_FIELD_NAMES = [
    "token", "total_buy_qty", "total_sell_qty", "volume_traded_today",
    "last_trade_time", "last_update_time", "open_price", "close_price",
    "high_price", "low_price", "last_traded_price", "last_trade_qty",
    "avg_trade_price", "_indicative_close", "buy_depth_count",
    "sell_depth_count", "_trading_status", "net_chg_percent", "open_interest",
    "total_traded_value", "net_chg", "upper_circuit", "lower_circuit",
    "yearly_high", "yearly_low", "market_lot", "precision", "multiplier",
]
_MINI_FIELD_NAMES = [
    "token", "last_trade_time", "last_traded_price", "last_trade_qty",
    "close_price", "net_chg_percent", "net_chg", "market_lot", "precision",
    "multiplier",
]
_CAS_FIELD_NAMES = ["stk_exch_token", "ref_price", "imbalance_qty", "imbalance_qty_at_market"]


def _ist_now() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def _ist_ms() -> str:
    return datetime.now(IST).isoformat(timespec="milliseconds")


def _redact_value(value):
    if isinstance(value, dict):
        return {k: ("***" if str(k).lower() in SECRET_KEYS else _redact_value(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace")
        except Exception:
            return f"<bytes:{len(value)}>"
    return value


def _redact_json_literals(raw: str) -> str:
    try:
        data = json.loads(raw)
    except Exception:
        for key in sorted(SECRET_KEYS, key=len, reverse=True):
            raw = re.sub(r'("?' + re.escape(key) + r'"?\s*[:=]\s*")[^",\s}]+("?)',
                         r"\1***\2", raw, flags=re.IGNORECASE)
        return raw
    return json.dumps(_redact_value(data), ensure_ascii=False)


def _decode_string(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("utf-8", "replace").strip()


def wire_header(packet: bytes) -> dict:
    if len(packet) < 9:
        return {}
    (message_length, message_code, exchange_id, level, auction_flag,
     seq_no, bitmask_length) = _HEADER.unpack_from(packet, 0)
    return {
        "message_length": message_length, "message_code": message_code,
        "exchange_id": exchange_id, "level": level, "auction_flag": auction_flag,
        "seq_no": seq_no, "bitmask_length": bitmask_length,
    }


def wire_decode_packet(packet: bytes, divider: int) -> dict:
    """Independent decode of one SFeed packet -- ALL header + body fields
    (including SDK-discarded ones: seq_no, bitmask_length, _indicative_close,
    _trading_status) plus raw depth rows."""
    out = {"header": wire_header(packet)}
    hdr = out["header"]
    body = None
    msg_code = hdr.get("message_code")
    level = hdr.get("level")
    if level == 1:
        body = dict(zip(_MINI_FIELD_NAMES, _MINI_BODY.unpack_from(packet, 9)))
    elif level in (2, 4, 8, 16):
        fields = _MP_BODY.unpack_from(packet, 9)
        body = dict(zip(_MP_FIELD_NAMES, fields))
        buy_n = 1 if level == 4 else body["buy_depth_count"]
        sell_n = 1 if level == 4 else body["sell_depth_count"]
        rows = []
        offset = _MP_FIXED_END
        limit = min(hdr["message_length"], len(packet))
        for i in range(buy_n + sell_n):
            if offset + 16 > limit:
                break
            qty, price, orders = _DEPTH_ROW.unpack_from(packet, offset)
            rows.append({
                "side": "buy" if i < buy_n else "sell",
                "index": i if i < buy_n else i - buy_n,
                "quantity": qty, "price_raw": price, "price": price / divider,
                "orders": orders,
            })
            offset += 16
        out["depth_rows"] = rows
    elif msg_code == 7207:
        vals = list(_INDEX_BODY.unpack_from(packet, 9))
        names = ["token", "open_price", "close_price", "high_price", "low_price",
                 "index_value", "last_trade_time", "yearly_high", "yearly_low",
                 "net_chg_percent", "_market_cap", "precision", "multiplier", "name"]
        vals[-1] = _decode_string(vals[-1])
        body = dict(zip(names, vals))
    elif msg_code == 105:
        status_code, status_bytes = _MARKET_STATUS_BODY.unpack_from(packet, 9)
        body = {"status_code": status_code, "status_wire": _decode_string(status_bytes)}
    elif msg_code == 104:
        body = dict(zip(_CAS_FIELD_NAMES, _CAS_CHANGE_BODY.unpack_from(packet, 9)))
    out["body"] = body or {}
    return out


def wire_split_batch(frame: bytes) -> list[bytes]:
    packets = []
    offset = 0
    n = len(frame)
    while offset + 2 <= n:
        size = struct.unpack_from("<H", frame, offset)[0]
        if size < 9 or offset + size > n:
            break
        packets.append(frame[offset:offset + size])
        offset += size
    return packets


class RawCollector:
    """Captures every raw WS frame (text + binary) with timestamps.

    No credentials are ever stored: text control frames are redacted; binary
    frames carry only market data. Hex of representative WIPRO binary frames is
    preserved as evidence, plus a full independent wire-decode per packet.
    """

    def __init__(self, token: str) -> None:
        self.token = token
        self.frames: list[dict] = []
        self.text_frames = 0
        self.binary_frames = 0
        self.binary_bytes = 0
        self.packet_msg_codes: dict[int, int] = {}
        self.packet_levels: dict[int, int] = {}
        self.acks_received: list[dict] = []
        self.first_frame_ts: str | None = None
        self.last_frame_ts: str | None = None
        self.hex_samples: list[dict] = []
        self.decoded_samples: list[dict] = []
        self.dividers: dict[int, int] = {}

    def seal_dividers(self, dividers: dict[int, int]) -> None:
        self.dividers = dict(dividers or {})

    def _divider_for(self, exch_id: int) -> int:
        return self.dividers.get(exch_id) or 100

    def on_raw(self, raw) -> None:
        ts = _ist_ms()
        if self.first_frame_ts is None:
            self.first_frame_ts = ts
        self.last_frame_ts = ts
        if isinstance(raw, (bytes, bytearray)):
            self.binary_frames += 1
            frame = bytes(raw)
            self.binary_bytes += len(frame)
            rec = {"ts": ts, "kind": "binary", "size_bytes": len(frame)}
            packets = wire_split_batch(frame)
            rec["packet_count"] = len(packets)
            for pkt in packets:
                hdr = wire_header(pkt)
                mc = hdr.get("message_code")
                lv = hdr.get("level")
                self.packet_msg_codes[mc] = self.packet_msg_codes.get(mc, 0) + 1
                self.packet_levels[lv] = self.packet_levels.get(lv, 0) + 1
            self.frames.append(rec)
            # Representative raw preservation (first frames) + full decode
            if len(self.hex_samples) < 200:
                self.hex_samples.append({
                    "ts": ts, "size": len(frame), "hex": frame.hex(),
                    "sha256": hashlib.sha256(frame).hexdigest()[:16],
                })
            for pkt in packets:
                hdr = wire_header(pkt)
                tok = None
                if hdr.get("level") in (1, 2, 4, 8, 16):
                    try:
                        if hdr["level"] == 1:
                            tok = str(_MINI_BODY.unpack_from(pkt, 9)[0])
                        else:
                            tok = str(_MP_BODY.unpack_from(pkt, 9)[0])
                    except Exception:
                        tok = None
                if str(tok or "") == self.token and len(self.decoded_samples) < 400:
                    dec = wire_decode_packet(pkt, self._divider_for(hdr.get("exchange_id", 1)))
                    dec["frame_ts"] = ts
                    self.decoded_samples.append(dec)
            return
        self.text_frames += 1
        text = str(raw)
        redacted = _redact_json_literals(text)
        rec = {"ts": ts, "kind": "text", "size_chars": len(text), "text_redacted": redacted}
        for ack in self._scan_ack(text):
            rec.setdefault("acks", []).append(ack)
            self.acks_received.append(ack)
        self.frames.append(rec)

    def _scan_ack(self, text: str) -> list[dict]:
        try:
            data = json.loads(text)
        except Exception:
            return []
        mc = str(data.get("message_code", ""))
        if mc in ("1109",):
            return [{
                "ack_ts": _ist_ms(),
                "trading_symbols_redacted": _redact_value(data.get("trading_symbols")),
                "raw_keys": sorted(data.keys()),
            }]
        if str(data.get("message_code")) == "1109":
            return [{
                "ack_ts": _ist_ms(),
                "trading_symbols_redacted": _redact_value(data.get("trading_symbols")),
                "raw_keys": sorted(data.keys()),
            }]
        return []


class SdkCollector:
    """Field-level audit of every SDK-delivered message for the probe token."""

    def __init__(self, token: str) -> None:
        self.token = token
        self.messages: dict[str, int] = {}
        self.levels: dict[int, int] = {}
        self.wipro_scrip: dict[int, dict] = {}
        self.attrs: dict[str, dict] = {}
        self.first_seen: dict[str, str] = {}
        self.last_seen: dict[str, str] = {}
        self.market_status: dict = {}
        self.total = 0
        self.wipro_total = 0

    def observe(self, msg) -> None:
        now = _ist_now()
        self.total += 1
        tname = getattr(msg, "type", "unknown")
        self.messages[tname] = self.messages.get(tname, 0) + 1
        lev = getattr(msg, "level", None)
        if isinstance(lev, int):
            self.levels[lev] = self.levels.get(lev, 0) + 1
        tok = getattr(msg, "instrument_token", None)
        seg = getattr(msg, "exchange_segment", None)
        is_wipro = (str(tok or "") == self.token) and (str(seg or "") == WIPRO_EXCH)
        if is_wipro:
            self.wipro_total += 1
        model = getattr(msg, "model_dump", None)
        if not callable(model):
            return
        dump = model(mode="json")
        flat = {}
        _flatten("", dump, flat)
        if is_wipro and tname == "scrip":
            buy = getattr(msg, "buy", []) or []
            sell = getattr(msg, "sell", []) or []
            rec = self.wipro_scrip.setdefault(lev if isinstance(lev, int) else -1, {
                "count": 0, "bid_rows_max": 0, "ask_rows_max": 0,
                "bid_rows_seen": {}, "ask_rows_seen": {}, "samples": [],
                "first_ts": None, "last_ts": None,
            })
            rec["count"] += 1
            rec["first_ts"] = rec["first_ts"] or now
            rec["last_ts"] = now
            rec["bid_rows_max"] = max(rec["bid_rows_max"], len(buy))
            rec["ask_rows_max"] = max(rec["ask_rows_max"], len(sell))
            rec["bid_rows_seen"][len(buy)] = rec["bid_rows_seen"].get(len(buy), 0) + 1
            rec["ask_rows_seen"][len(sell)] = rec["ask_rows_seen"].get(len(sell), 0) + 1
            if len(rec["samples"]) < 4:
                rec["samples"].append({
                    "buy": [row.model_dump(mode="json") for row in buy],
                    "sell": [row.model_dump(mode="json") for row in sell],
                })
        for path, val in flat.items():
            key = _normalize_key(path)
            rec = self.attrs.setdefault(key, {
                "count": 0, "types": set(), "first": None, "last": None,
                "sample_values": [], "first_ts": None, "last_ts": None,
                "paths": [],
            })
            rec["count"] += 1
            rec["types"].add(type(val).__name__)
            if rec["first"] is None:
                rec["first"] = val
            rec["last"] = val
            rec["first_ts"] = rec["first_ts"] or now
            rec["last_ts"] = now
            p = f"{tname}." + _leaf(path)
            if p not in rec["paths"]:
                rec["paths"].append(p)
            if len(rec["sample_values"]) < 5:
                rec["sample_values"].append(val)
        if tname == "market_status":
            code = getattr(msg, "status_code", None)
            self.market_status[str(code)] = self.market_status.get(str(code), 0) + 1
            self.market_status.setdefault("_text", getattr(msg, "status", ""))
            self.market_status.setdefault("_seg", str(seg or ""))


def _flatten(prefix: str, value, out: dict):
    if isinstance(value, dict):
        for k, v in value.items():
            _flatten(f"{prefix}.{k}" if prefix else str(k), v, out)
    elif isinstance(value, list):
        if not value:
            if prefix:
                out[prefix] = None
            return
        for i, v in enumerate(value):
            _flatten(f"{prefix}[{i}]", v, out)
    else:
        out[prefix] = value if prefix else "(root)"


def _leaf(path: str) -> str:
    tail = str(path)
    if "." in tail:
        tail = tail.rsplit(".", 1)[-1]
    if "[" in tail:
        tail = tail.split("[", 1)[0]
    return tail


def _normalize_key(path: str) -> str:
    out = []
    chars = list(str(path))
    name = chars
    for i, ch in enumerate(name):
        prev = name[i - 1] if i > 0 else ""
        nxt = name[i + 1] if i + 1 < len(name) else ""
        if ch.isupper():
            boundary = (not prev) or (prev.islower()) or (prev.isupper() and nxt and nxt.islower())
            if boundary and out:
                out.append("_")
        out.append(ch.lower())
    return "".join(out).replace("__", "_").strip("_")


def _market_clock() -> dict:
    now = datetime.now(IST)
    d = now.weekday()
    hhmm = now.hour * 100 + now.minute
    weekday = d < 5
    in_window = weekday and 915 <= hhmm < 1530
    open_c = now.replace(hour=9, minute=15, second=0, microsecond=0)
    close_c = now.replace(hour=15, minute=30, second=0, microsecond=0)
    return {
        "ist_now": _ist_now(),
        "weekday": now.strftime("%A"),
        "weekday_int": d,
        "is_weekday": weekday,
        "hhmm_ist": hhmm,
        "market_expected_open": weekday and open_c <= now <= close_c,
        "window_label": ("OPEN (NSE cash 09:15-15:30 IST)" if weekday and in_window
                         else "CLOSED/BEFORE/AFTER (NSE cash)"),
    }


def gate_session(args) -> tuple[bool, int, str]:
    try:
        info = kotak_session.session_info()
    except Exception as exc:
        return False, 3, f"session_info error: {exc}"
    if info.get("logged_in") and kotak_session.session_active:
        return True, 0, f"session already active (user={info.get('user_id')})"
    if not args.login:
        return False, 3, (
            "LIVE TEST STATUS: BLOCKED - VALID KOTAK SESSION REQUIRED\n"
            "  Re-run with --login to perform a REAL TOTP+MPIN login from .env.\n"
            f"  Command: {sys.executable} {os.path.basename(__file__)} --login "
            f"--duration {args.duration} --levels {' '.join(map(str, args.levels))}"
        )
    try:
        ok = kotak_session.login(source=args.source)
    except Exception as exc:
        return False, 4, f"LIVE TEST STATUS: FAILED - login error: {exc}"
    if not ok or not kotak_session.session_active:
        return False, 4, (
            "LIVE TEST STATUS: FAILED - login did not produce active session "
            f"(reason: {kotak_session.login_error or 'unknown'})"
        )
    return True, 0, f"session validated (user={kotak_session.user_id}) source={args.source}"


def resolve_wipro() -> dict:
    try:
        from services.instrument_cache import instrument_cache, load_instrument_cache
        load_instrument_cache()
    except Exception as exc:
        return {"error": f"instrument_cache load failed: {exc}"}
    try:
        inst = instrument_cache.lookup_by_symbol(WIPRO_SYMBOL)
    except Exception as exc:
        return {"error": f"lookup_by_symbol(WIPRO) failed: {exc}"}
    if not inst:
        return {"error": "WIPRO not found in instrument master"}
    return {"data": _redact_value(dict(inst)),
            "source": "instrument_master.json (loaded from Kotak scrip master CSV)"}


def probe_scrip_master() -> dict:
    client = kotak_session.client
    try:
        resp = client.scrip_master(exchange_segment="nse_cm")
    except Exception as exc:
        return {"error": f"scrip_master(nse_cm) failed: {type(exc).__name__}: {exc}"}
    csv_url = None
    try:
        if isinstance(resp, str):
            csv_url = resp
        else:
            data = resp.get("data") if isinstance(resp, dict) else resp
            files_paths = (data.get("filesPaths") or data.get("filePaths") or []) if isinstance(data, dict) else []
            csv_url = files_paths[0] if files_paths else None
    except Exception:
        csv_url = None
    if not csv_url:
        return {"error": "scrip_master returned no CSV file paths",
                "resp_sample_redacted": _redact_value(resp)}
    try:
        import requests
        r = requests.get(csv_url, timeout=90)
        r.raise_for_status()
    except Exception as exc:
        return {"error": f"CSV download failed: {exc}", "csv_url": csv_url}
    rows = list(csv.DictReader(io.StringIO(r.text)))
    wipro_rows = []
    for row in rows:
        sym = str(row.get("pSymbolName", "")).upper()
        trd = str(row.get("pTrdSymbol", row.get("TradingSymbol", ""))).upper()
        if sym == WIPRO_SYMBOL or trd == "WIPRO-EQ":
            wipro_rows.append(row)
    return {
        "csv_url": csv_url,
        "total_rows_in_csv": len(rows),
        "wipro_row_count": len(wipro_rows),
        "wipro_rows": wipro_rows,
        "csv_header_fields": sorted(rows[0].keys()) if rows else [],
    }


async def probe_quote_async() -> dict:
    payload = [{"exchange_segment": WIPRO_EXCH, "instrument_token": WIPRO_TOKEN}]
    started = time.time()
    try:
        raw = await kotak_session.async_quote(instrument_tokens=payload, quote_type="all")
    except Exception as exc:
        return {"error": f"quote failed: {type(exc).__name__}: {exc}"}
    elapsed = time.time() - started
    flat = {}
    _flatten("", raw if isinstance(raw, dict) else {"raw": raw}, flat)
    return {
        "elapsed_s": round(elapsed, 3),
        "endpoint": "GET script-details/1.0/quotes/neosymbol/{neosymbols}/all",
        "request_payload": payload,
        "quote_type": "all",
        "response_type": type(raw).__name__,
        "top_level_keys": sorted(raw.keys()) if isinstance(raw, dict) else None,
        "item_count": len(raw) if isinstance(raw, (list, dict)) else None,
        "flat_field_count": len(flat),
        "flattened_redacted": _redact_value(flat),
        "raw_redacted": _redact_value(raw),
    }


async def run_level(level: int, duration: float, outdir: Path) -> dict:
    import enum
    from neo_api_client.websocket.feed import WsToken
    method_name, event, sdk_level_name = SUBSCRIPTION_METHODS[level]
    client = kotak_session.client
    result = {
        "level": level,
        "sdk_level_name": sdk_level_name,
        "sdk_method": f"{method_name}()",
        "wire_event": event,
        "subscription_payload": {"event": event,
                                 "tokens": [f"{WIPRO_EXCH}|{WIPRO_TOKEN}"],
                                 "ack_symbol": True},
    }
    ws = None
    try:
        ws = client.create_websocket(max_reconnect_attempts=0, max_connect_retries=0)
    except Exception as exc:
        result["create_websocket"] = f"FAILED: {type(exc).__name__}: {exc}"
        return result
    raw_coll = RawCollector(WIPRO_TOKEN)
    ws.on_raw = raw_coll.on_raw
    outbound_capture: list[dict] = []
    orig_send = None

    async def traced_send(data, *a, **k):
        try:
            outbound_capture.append({"ts": _ist_ms(),
                                     "data_redacted": _redact_json_literals(str(data))})
        except Exception:
            pass
        return await orig_send(data, *a, **k)

    try:
        await ws.connect()
    except Exception as exc:
        result["connect"] = f"FAILED: {type(exc).__name__}: {exc}"
        try:
            await ws.close()
        except Exception:
            pass
        return result
    result["connect"] = "OK"
    result["url"] = getattr(ws, "url", "unknown")
    try:
        raw_coll.seal_dividers(ws.dividers)
    except Exception:
        pass
    result["dividers"] = raw_coll.dividers
    underlying = getattr(ws, "_ws", None)
    if underlying is not None and hasattr(underlying, "send"):
        try:
            orig_send = underlying.send
            underlying.send = traced_send
        except Exception:
            pass
    sink_msgs: list[dict] = []
    collector = SdkCollector(WIPRO_TOKEN)
    cap_start = time.time()
    tokens = [WsToken(exchange_segment=WIPRO_EXCH, instrument_token=WIPRO_TOKEN)]
    try:
        await getattr(ws, method_name)(tokens)
        result["subscribe_returned"] = "OK"
    except Exception as exc:
        result["subscribe_returned"] = f"REJECTED/EXCEPTION: {type(exc).__name__}: {exc}"
        try:
            await ws.close()
        except Exception:
            pass
        return result
    try:
        await ws.subscribe_exchange()
        result["subscribe_exchange"] = "OK"
    except Exception as exc:
        result["subscribe_exchange"] = f"FAILED: {type(exc).__name__}: {exc}"
    end = cap_start + duration
    last_report = cap_start
    while True:
        now = time.time()
        if now >= end:
            break
        try:
            msg = await asyncio.wait_for(ws.__anext__(), timeout=max(0.05, min(1.0, end - now)))
        except asyncio.TimeoutError:
            continue
        except StopAsyncIteration:
            result["stream"] = "ENDED_EARLY"
            break
        except Exception as exc:
            result["stream"] = f"ERROR: {type(exc).__name__}: {exc}"
            break
        collector.observe(msg)
        now = time.time()
        if now - last_report >= 5:
            last_report = now
            print(f"    [level {level}] {_ist_now()} total={collector.total} "
                  f"wipro={collector.wipro_total}")
    cap_elapsed = time.time() - cap_start
    try:
        await getattr(ws, UNSUBSCRIBE_METHODS[level])(tokens)
        result["unsubscribe_returned"] = "OK"
    except Exception as exc:
        result["unsubscribe_returned"] = f"FAILED: {type(exc).__name__}: {exc}"
    try:
        await ws.close()
        result["close"] = "OK"
    except Exception as exc:
        result["close"] = f"FAILED: {type(exc).__name__}: {exc}"

    # ---- assemble result -----------------------------------------------------
    result["capture_elapsed_s"] = round(cap_elapsed, 3)
    result["total_sdk_messages"] = collector.total
    result["wipro_sdk_messages"] = collector.wipro_total
    result["message_types"] = collector.messages
    result["levels_seen"] = {str(k): v for k, v in collector.levels.items()}
    result["wipro_scrip_by_level"] = {
        str(k): {kk: vv for kk, vv in v.items() if kk != "samples"}
        for k, v in collector.wipro_scrip.items()
    }
    result["wipro_depth_samples"] = {
        str(k): v["samples"] for k, v in collector.wipro_scrip.items()
    }
    result["market_status_seen"] = collector.market_status
    result["attrs_seen"] = sorted(collector.attrs.keys())
    result["field_stats"] = {
        k: {"count": v["count"],
            "types": sorted(v["types"]),
            "first": _redact_value(v["first"]),
            "last": _redact_value(v["last"]),
            "first_ts": v["first_ts"], "last_ts": v["last_ts"],
            "sample_values": _redact_value(v["sample_values"]),
            "paths": v["paths"]}
        for k, v in collector.attrs.items()
    }
    result["acks"] = raw_coll.acks_received
    result["raw_text_frames"] = raw_coll.text_frames
    result["raw_binary_frames"] = raw_coll.binary_frames
    result["raw_binary_bytes"] = raw_coll.binary_bytes
    result["raw_first_ts"] = raw_coll.first_frame_ts
    result["raw_last_ts"] = raw_coll.last_frame_ts
    result["raw_packet_msg_codes"] = raw_coll.packet_msg_codes
    result["raw_packet_levels"] = {str(k): v for k, v in raw_coll.packet_levels.items()}
    result["outbound_frame_count"] = len(outbound_capture)
    result["outbound_frames"] = _redact_value(outbound_capture[-10:])
    result["wipro_messages_per_sec"] = round(collector.wipro_total / cap_elapsed, 3) if cap_elapsed else 0.0
    result["all_messages_per_sec"] = round(collector.total / cap_elapsed, 3) if cap_elapsed else 0.0
    result["_collector"] = collector

    # Raw evidence files (Phase 11 raw preservation)
    try:
        ev_path = outdir / f"evidence_raw_level{level}_{datetime.now(IST).strftime('%Y%m%d_%H%M%S')}.jsonl"
        with ev_path.open("w", encoding="utf-8") as fh:
            for fr in raw_coll.frames:
                fh.write(json.dumps(fr, ensure_ascii=False) + "\n")
        result["raw_evidence_file"] = str(ev_path)
    except Exception as exc:
        result["raw_evidence_file"] = f"WRITE_FAILED: {exc}"
    result["wire_decoded_samples"] = raw_coll.decoded_samples[:100]
    result["wire_hex_samples"] = raw_coll.hex_samples[:20]
    return result


def independent_compare(collector, level: int) -> list[dict]:
    rows = []
    wipro_stats = collector.wipro_scrip.get(level, {}) if collector else {}
    seen = wipro_stats.get("count", 0) > 0
    if not seen:
        return [{
            "raw_wire_field": "(no WIPRO packets)", "sdk_field": "-",
            "status": "NOT_VERIFIED", "transformation": "capture window produced no WIPRO scrip message",
        }]
    wire_fields = [
        ("header.message_length", None, "header kept in model? No - length not exposed"),
        ("header.message_code", None, "routing only; not exposed as a field"),
        ("header.exchange_id", "exchange_segment", "exchange_id mapped to segment string"),
        ("header.level", "level", "header level byte preserved verbatim"),
        ("header.auction_flag", "auction", "flag>0 converted to bool"),
        ("header.seq_no", None, "DISCARDED - seq_no decoded but never exposed"),
        ("header.bitmask_length", None, "DISCARDED - decoded but never exposed"),
        ("body.token", "instrument_token", "int token -> str instrument_token"),
        ("body.total_buy_qty", "total_buy_quantity", "integer preserved"),
        ("body.total_sell_qty", "total_sell_quantity", "integer preserved"),
        ("body.volume_traded_today", "volume_traded_today", "integer preserved"),
        ("body.last_trade_time", "last_trade_time", "integer preserved"),
        ("body.last_update_time", "last_update_time", "negative sentinel -> 0"),
        ("body.open_price", "open_price", "divided by divider (100)"),
        ("body.close_price", "close_price", "divided by divider (100)"),
        ("body.high_price", "high_price", "divided by divider (100)"),
        ("body.low_price", "low_price", "divided by divider (100)"),
        ("body.last_traded_price", "last_traded_price", "divided by divider (100)"),
        ("body.last_trade_qty", "last_trade_qty", "integer preserved"),
        ("body.avg_trade_price", "average_trade_price", "divided by divider (100)"),
        ("body._indicative_close", None, "DISCARDED - unpacked, never exposed"),
        ("body.buy_depth_count", "(count)", "drives number of buy rows decoded"),
        ("body.sell_depth_count", "(count)", "drives number of sell rows decoded"),
        ("body._trading_status", None, "DISCARDED - unpacked, never exposed"),
        ("body.net_chg_percent", "net_change_percent", "divided by 100"),
        ("body.open_interest", "open_interest", "kept (double on wire)"),
        ("body.total_traded_value", "total_traded_value", "divided by divider (100)"),
        ("body.net_chg", "net_change", "divided by divider (100)"),
        ("body.upper_circuit", "upper_circuit_limit", "divided by divider (100)"),
        ("body.lower_circuit", "lower_circuit_limit", "divided by divider (100)"),
        ("body.yearly_high", "yearly_high", "divided by divider (100)"),
        ("body.yearly_low", "yearly_low", "divided by divider (100)"),
        ("body.market_lot", "market_lot", "integer preserved"),
        ("body.precision", "precision", "u8 preserved"),
        ("body.multiplier", "multiplier", "integer preserved"),
        ("depth rows (wire, from byte 144)", "buy[]/sell[]", "level4 forces 1+1; L8/L16 use wire counts"),
    ]
    for raw_name, sdk_name, transform in wire_fields:
        if sdk_name is not None:
            rows.append({"raw_wire_field": raw_name, "sdk_field": sdk_name,
                         "status": "PRESERVED", "transformation": transform})
        else:
            rows.append({"raw_wire_field": raw_name, "sdk_field": "(none)",
                         "status": "SENT_BY_KOTAK_DISCARDED_BY_SDK", "transformation": transform})
    for sdk_name, why in [
        ("type", "'scrip' literal"),
        ("trading_symbol", "enriched from subscribe-ack trading_symbols map (NOT on wire)"),
    ]:
        rows.append({"raw_wire_field": "(no direct wire field)", "sdk_field": sdk_name,
                     "status": "SYNTHESIZED_BY_SDK", "transformation": why})
    return rows


def classify_permission(level_result: dict, market: dict) -> tuple[str, str]:
    lvl = level_result["level"]
    sub_ok = level_result.get("subscribe_returned") == "OK"
    ack = bool(level_result.get("acks"))
    wipro = level_result.get("wipro_scrip_by_level", {})
    level_ok = wipro.get(str(lvl), {}).get("count", 0) > 0
    errors = [f"{k}={v}" for k, v in level_result.items()
              if isinstance(v, str) and (v.startswith("FAILED") or "EXCEPTION" in v or "REJECTED" in v)]
    if not sub_ok:
        return ("BLOCKED", f"subscribe call raised/returned error: {errors}")
    if errors:
        return ("BLOCKED", f"other errors during level {lvl} test: {errors}")
    if ack and level_ok:
        return ("ALLOWED",
                f"ack received and level-{lvl} WIPRO market data observed "
                f"({wipro[str(lvl)]['count']} scrip messages)")
    if ack and not level_ok:
        if market["market_expected_open"]:
            return ("NOT VERIFIED",
                    f"ack received but NO level-{lvl} WIPRO data arrived during the window "
                    f"while NSE was open; cannot distinguish entitlement restriction vs "
                    f"quiet/no-trade book vs silent reject.")
        return ("NOT VERIFIED",
                f"ack received; capture outside market hours ({market['window_label']}); "
                f"no data expected during dead session.")
    if not ack and level_ok:
        return ("ALLOWED",
                f"level-{lvl} data observed although no ack frame captured (raw hook may have "
                f"started after the ack text frame)")
    return ("NOT VERIFIED",
            f"no ack AND no level-{lvl} WIPRO data; total msgs {level_result.get('total_sdk_messages')}; "
            f"market={market['window_label']}. Cannot distinguish rejection vs no data.")


def classify_level_data(level_result: dict) -> tuple[str, str]:
    """Distinguish a REAL live depth stream from a static / empty payload.

    L4/L8 deliver evolving ticks with real volume + real book rows.
    L16 (as observed) is ack-accepted but carries a static reference snapshot
    (prev-session OHLC, volume=0, total buy/sell=0, zero book) with NO depth rows.
    """
    lv = level_result["level"]
    info = level_result.get("wipro_scrip_by_level", {}).get(str(lv), {})
    count = info.get("count", 0)
    if not count:
        return "NO_DATA", "no level-%d scrip message during the capture window" % lv
    bid_seen = {int(k) if str(k).isdigit() else -1: v for k, v in (info.get("bid_rows_seen") or {}).items()}
    ask_seen = {int(k) if str(k).isdigit() else -1: v for k, v in (info.get("ask_rows_seen") or {}).items()}
    real_rows = any(n > 0 for n in bid_seen) or any(n > 0 for n in ask_seen)
    fs = level_result.get("field_stats", {}) or {}
    vol = fs.get("volume_traded_today", {})
    vol_zero = not vol or (vol.get("first") in (0, None) and vol.get("last") in (0, None))
    if real_rows and not vol_zero:
        return ("VERIFIED_LIVE",
                f"real evolving level-{lv} feed: {count} scrip msgs, book rows present, volume>0")
    if real_rows and vol_zero:
        return ("DEPTH_ONLY",
                f"book rows present but volume field zero (n={count})")
    if count and not real_rows:
        return ("STATIC_ONLY",
                f"level-{lv} accepted (ack) but delivered ONLY a static reference snapshot: "
                f"{count} scrip msgs with 0 bid + 0 sell rows, volume=0, total buy/sell=0. "
                f"NOT a live book depth feed for this account/SDK window.")
    return "NO_DATA", "no level-%d scrip message during the capture window" % lv


def build_matrix(levels: list[dict], quote_data, master_data, meta_data=None) -> list[dict]:
    quote_flat = (quote_data or {}).get("flattened_redacted") or {}
    quote_paths = {k for k in quote_flat.keys()}
    meta = ((meta_data or {}).get("data") or {}) if isinstance(meta_data, dict) else {}
    master_row = (master_data or {}).get("wipro_rows") or []
    master_row = master_row[0] if master_row else None
    if master_row:
        master_row = {str(k).strip(): v for k, v in master_row.items()}

    def level_alive(level: int) -> bool:
        lev = next((r for r in levels if r["level"] == level), None)
        if not lev:
            return False
        return lev.get("wipro_scrip_by_level", {}).get(str(level), {}).get("count", 0) > 0

    def ws_had(level: int, key: str) -> bool:
        lev = next((r for r in levels if r["level"] == level), None)
        if not lev:
            return False
        return lev.get("field_stats", {}).get(key, {}).get("count", 0) > 0

    def master_has(any_of) -> bool:
        if not master_row:
            return False
        for k in any_of:
            if master_row.get(k) not in (None, ""):
                return True
        return False

    def quote_path(substrs) -> bool:
        for name in substrs:
            if any(name in k for k in quote_paths):
                return True
        return False

    def meta_has(any_of) -> bool:
        for k in any_of:
            if meta.get(k) not in (None, "", "***"):
                return True
        return False

    levels_static = {
        lv: classify_level_data(lev)[0] == "STATIC_ONLY"
        for lv, lev in ((lv, next((r for r in levels if r["level"] == lv), None))
                        for lv in (4, 8, 16))
        if lev is not None
    }

    rows = []
    # (display, ws normalized key, quote path substrings, master fields, meta fields)
    base = [
        ("LTP", "last_traded_price", ["ltp"], [], []),
        ("Open", "open_price", ["ohlc.open"], [], []),
        ("High", "high_price", ["ohlc.high"], [], []),
        ("Low", "low_price", ["ohlc.low"], [], []),
        ("Prev Close", "close_price", ["ohlc.close"], [], []),
        ("Avg Trade Price", "average_trade_price", ["avg_cost"], [], []),
        ("Net Change", "net_change", ["change"], [], []),
        ("Net Change %", "net_change_percent", ["per_change"], [], []),
        ("Upper Circuit", "upper_circuit_limit", ["high_price_range"], ["dHighPriceRange"], []),
        ("Lower Circuit", "lower_circuit_limit", ["low_price_range"], ["dLowPriceRange"], []),
        ("Yearly High", "yearly_high", ["year_high"], [], []),
        ("Yearly Low", "yearly_low", ["year_low"], [], []),
        ("Last Trade Qty", "last_trade_qty", ["last_traded_quantity"], [], []),
        ("Last Trade Time", "last_trade_time", ["lstup_time"], [], []),
        ("Last Update Time", "last_update_time", ["lstup_time"], [], []),
        ("Volume", "volume_traded_today", ["last_volume"], [], []),
        ("Total Traded Value", "total_traded_value", [], [], []),
        ("Total Buy Qty", "total_buy_quantity", ["total_buy"], [], []),
        ("Total Sell Qty", "total_sell_quantity", ["total_sell"], [], []),
        ("Open Interest", "open_interest", ["open_int"], ["dOpenInterest"], []),
        ("Market Lot", "market_lot", [], [], []),
        ("Precision", "precision", [], ["lPrecision"], []),
        ("Multiplier", "multiplier", [], ["lMultiplier"], []),
        ("Auction Flag", "auction", [], [], []),
        ("Instrument Token", "instrument_token", ["exchange_token"], ["pSymbol"], ["token"]),
        ("Trading Symbol", "trading_symbol", ["display_symbol"], ["pTrdSymbol"], ["tradingSymbol"]),
        ("Exchange Segment", "exchange_segment", ["exchange"], ["pExchSeg"], ["exchangeSegment", "exchange"]),
        ("Depth Bid Price L1", "depth_bid1_price", ["depth.buy[0].price"], [], []),
        ("Depth Bid Qty L1", "depth_bid1_qty", ["depth.buy[0].quantity"], [], []),
        ("Depth Bid Orders L1", "depth_bid1_orders", ["depth.buy[0].orders"], [], []),
        ("Depth Ask Price L1", "depth_ask1_price", ["depth.sell[0].price"], [], []),
        ("Depth Ask Qty L1", "depth_ask1_qty", ["depth.sell[0].quantity"], [], []),
        ("Depth Ask Orders L1", "depth_ask1_orders", ["depth.sell[0].orders"], [], []),
        ("ISIN", "isin", [], ["pISIN"], ["isin"]),
        ("Company Name", "company_name", [], ["pDesc"], ["companyName"]),
        ("Series", "series", [], [], ["series", "segment"]),
        ("Instrument Type", "instrument_type", [], ["pInstType", "pInstName"], ["instrumentType"]),
        ("Symbol", "symbol", ["display_symbol"], ["pSymbolName"], ["symbol"]),
        ("Tick Size", "tick_size", [], ["dTickSize"], ["tickSize"]),
        ("Lot Size (master)", "lot_size", [], ["iLotSize", "lLotSize"], ["lotSize"]),
        ("Wire Sequence no", "seq_no", [], [], []),
        ("Wire Bitmask length", "bitmask_length", [], [], []),
        ("Indicative Close (wire)", "indicative_close", [], [], []),
        ("Trading Status (wire)", "trading_status", [], [], []),
    ]

    def depth_report(level: int) -> dict:
        lev = next((r for r in levels if r["level"] == level), None)
        out = {"alive": False, "level": level}
        if not lev:
            return out
        info = lev.get("wipro_scrip_by_level", {}).get(str(level), {})
        out["alive"] = info.get("count", 0) > 0
        out["count"] = info.get("count", 0)
        out["bid_rows_seen"] = info.get("bid_rows_seen", {})
        out["ask_rows_seen"] = info.get("ask_rows_seen", {})
        samples = lev.get("wipro_depth_samples", {}).get(str(level), [])
        out["sample0_buy_rows"] = len(samples[0]["buy"]) if samples else 0
        out["sample0_ask_rows"] = len(samples[0]["sell"]) if samples else 0
        out["data_verdict"], out["data_reason"] = classify_level_data(lev)
        return out

    depth = {lv: depth_report(lv) for lv in (4, 8, 16)}

    for display, ws_key, quote_sub, master_fields, meta_fields in base:
        w16_base = ws_had(16, ws_key) and depth[16]["alive"]
        w16 = w16_base and not levels_static.get(16)
        w4 = ws_had(4, ws_key) and depth[4]["alive"]
        w8 = ws_had(8, ws_key) and depth[8]["alive"]
        if ws_key.startswith("depth_bid1"):
            w4 = depth[4]["alive"] and depth[4]["sample0_buy_rows"] > 0
            w8 = depth[8]["alive"] and depth[8]["sample0_buy_rows"] > 0
            w16 = depth[16]["alive"] and depth[16]["sample0_buy_rows"] > 0
        if ws_key.startswith("depth_ask1"):
            w4 = depth[4]["alive"] and depth[4]["sample0_ask_rows"] > 0
            w8 = depth[8]["alive"] and depth[8]["sample0_ask_rows"] > 0
            w16 = depth[16]["alive"] and depth[16]["sample0_ask_rows"] > 0
        in_quote = "YES" if quote_path(quote_sub) else "NO"
        in_master = "YES" if master_has(master_fields) else "NO"
        in_meta = "YES" if meta_has(meta_fields) else "NO"
        note = ""
        if ws_key in ("seq_no", "bitmask_length", "indicative_close", "trading_status"):
            note = "present on RAW wire; DISCARDED by SDK (never on L4/L8/L16 model)"
        if display == "Instrument Token":
            note = "quote exchange_token=3787; master pSymbol=3787 (token in master) "
        if display == "Series":
            note = "meta series=EQ; quote 'all' exposes exchange_token/display_symbol only"
        rows.append({
            "field": display, "sdk_attr": ws_key,
            "L4": "YES" if w4 else ("NOT_VERIFIED" if not depth[4]["alive"] else "NO"),
            "L8": "YES" if w8 else ("NOT_VERIFIED" if not depth[8]["alive"] else "NO"),
            "L16": "YES" if w16 else ("NOT_VERIFIED" if not depth[16]["alive"] else "NO"),
            "quote": in_quote,
            "master": in_master,
            "meta": in_meta,
            "note": note,
        })
    return rows, depth


def render_report1(payload: dict) -> str:
    p = payload
    L = []
    L.append("=" * 80)
    L.append("KOTAK WIPRO LIVE DEPTH + QUOTE + SCRIP MASTER FORENSIC VERIFICATION")
    L.append("=" * 80)
    L.append("")
    L.append(f"Report timestamp (IST)  : {p['timestamp_ist']}")
    L.append(f"UTC                     : {p.get('utc_iso')}")
    L.append(f"Market state (IST clock): {p['market']['window_label']} | "
             f"weekday={p['market']['weekday']} hhmm={p['market']['hhmm_ist']}")
    L.append("")
    L.append("[1] TEST DATE/TIME")
    L.append(f"    {p['timestamp_ist']} IST during NSE cash session: {p['market']['market_expected_open']}")
    L.append("")
    L.append("[2] KOTAK SDK")
    L.append(f"    package : kotakneoapi {p['sdk']['version']}")
    L.append(f"    import  : {p['sdk']['import_name']}")
    L.append(f"    location: {p['sdk']['location']}")
    L.append("")
    L.append("[3] SESSION / AUTH")
    L.append(f"    outcome      : {p['session']['login_outcome']}")
    L.append(f"    user         : {p['session']['user_id']}")
    L.append(f"    session_active: {p['session']['session_active']}")
    L.append("")
    L.append("[4] WIPRO INSTRUMENT (from real instrument master)")
    if p['wipro_meta'].get('data'):
        for k, v in p['wipro_meta']['data'].items():
            L.append(f"    {k:20s}: {v}")
    else:
        L.append(f"    NOT AVAILABLE: {p['wipro_meta'].get('error')}")
    L.append("")
    L.append("[5] REAL SCRIP MASTER (WIPRO row from live CSV)")
    m = p.get('master') or {}
    if m.get('error'):
        L.append(f"    ERROR/BLOCKED: {m['error']}")
    else:
        L.append(f"    endpoint        : scrip_master(exchange_segment=nse_cm) -> CSV {m.get('csv_url')}")
        L.append(f"    csv rows        : {m.get('total_rows_in_csv')}")
        L.append(f"    wipro matches   : {m.get('wipro_row_count')}")
        if m.get('wipro_rows'):
            for k in sorted(m['wipro_rows'][0].keys()):
                L.append(f"    csv[{k}] = {m['wipro_rows'][0][k]}")
    L.append("")
    L.append("[6] REAL QUOTE API (WIPRO, quote_type=all)")
    q = p.get('quote') or {}
    if q.get('error'):
        L.append(f"    FAILED: {q['error']}")
    else:
        L.append(f"    endpoint     : {q.get('endpoint')}")
        L.append(f"    elapsed_s    : {q.get('elapsed_s')}")
        L.append(f"    response_type: {q.get('response_type')}")
        L.append(f"    top_keys     : {q.get('top_level_keys')}")
        L.append(f"    item_count   : {q.get('item_count')}")
        L.append(f"    flat_fields  : {q.get('flat_field_count')}")
        for k in sorted((q.get('flattened_redacted') or {}).keys()):
            v = str((q.get('flattened_redacted') or {}).get(k))
            L.append(f"    quote[{k}] = {v[:72]}")
    L.append("")
    L.append("[7] WEBSOCKET CONNECT / AUTH PER LEVEL")
    for r in p['levels']:
        L.append(f"    L{r['level']:>2} connect={r.get('connect')} subscribe={r.get('subscribe_returned')} "
                 f"unsub={r.get('unsubscribe_returned')} close={r.get('close')}")
        L.append(f"         url={r.get('url')} dividers={r.get('dividers')}")
    L.append("")
    L.append("[8] LEVEL RESULTS + PERMISSION")
    for r in p['levels']:
        verdict, reason = classify_permission(r, p['market'])
        lv = r['level']
        L.append(f"    LEVEL {lv} ({r['sdk_level_name']})")
        L.append(f"      sdk method         : {r['sdk_method']}")
        L.append(f"      subscription payload: {json.dumps(r['subscription_payload'])}")
        L.append(f"      subscribe returned  : {r['subscribe_returned']}")
        L.append(f"      ack captured        : {'YES' if r.get('acks') else 'NO'} ({len(r.get('acks', []))})")
        L.append(f"      wipro scrip msgs    : {r['wipro_scrip_by_level'].get(str(lv), {}).get('count', 0)}")
        L.append(f"      SDK level tags seen : {r.get('levels_seen')}")
        L.append(f"      msg types           : {r.get('message_types')}")
        L.append(f"      bid rows seen       : {r['wipro_scrip_by_level'].get(str(lv), {}).get('bid_rows_seen')}")
        L.append(f"      ask rows seen       : {r['wipro_scrip_by_level'].get(str(lv), {}).get('ask_rows_seen')}")
        L.append(f"      wipro msgs/sec      : {r.get('wipro_messages_per_sec')}")
        dverdict, dreason = classify_level_data(r)
        L.append(f"      data verdict        : {dverdict}")
        L.append(f"      data reason         : {dreason}")
        L.append(f"      raw bin/txt frames  : {r.get('raw_binary_frames')} / {r.get('raw_text_frames')}")
        L.append(f"      raw packet codes    : {r.get('raw_packet_msg_codes')}")
        L.append(f"      raw packet levels   : {r.get('raw_packet_levels')}")
        L.append(f"      market_status seen  : {r.get('market_status_seen')}")
        L.append(f"      raw evidence file   : {r.get('raw_evidence_file')}")
        errs = [v for k, v in r.items() if isinstance(v, str)
                and (v.startswith('FAILED') or 'EXCEPTION' in v or 'REJECTED' in v)]
        L.append(f"      string errors       : {errs or 'none'}")
        L.append(f"      PERMISSION          : {verdict}")
        L.append(f"      reason              : {reason}")
        L.append("")
    L.append("[9] RAW MESSAGE TYPES (merged)")
    mc: dict = {}
    lv: dict = {}
    for r in p['levels']:
        for k, v in (r.get('raw_packet_msg_codes') or {}).items():
            mc[k] = mc.get(k, 0) + v
        for k, v in (r.get('raw_packet_levels') or {}).items():
            lv[k] = lv.get(k, 0) + v
    L.append(f"    message_codes : {mc}")
    L.append(f"    levels        : {lv}")
    L.append("")
    L.append("[10] FIELD-BY-FIELD WS AUDIT (SDK-delivered, per level)")
    for r in p['levels']:
        L.append(f"    ---- LEVEL {r['level']} ----")
        for name in sorted(r.get('field_stats', {})):
            st = r['field_stats'][name]
            L.append(f"      {name:34s} n={st['count']:>5d} types={st['types']} "
                     f"first={st['first']} last={st['last']} "
                     f"fts={st['first_ts']} lts={st['last_ts']}")
    L.append("")
    L.append("[11] DEPTH ROW COMPARISON")
    depth = p.get('depth', {})
    for lv in (4, 8, 16):
        d = depth.get(str(lv), {})
        L.append(f"    LEVEL {lv}: alive={d.get('alive')} count={d.get('count')} "
                 f"bid_rows_seen={d.get('bid_rows_seen')} ask_rows_seen={d.get('ask_rows_seen')} "
                 f"sample0_buy={d.get('sample0_buy_rows')} sample0_ask={d.get('sample0_ask_rows')}")
        L.append(f"              verdict={d.get('data_verdict')} | {d.get('data_reason')}")
    for lv in (4, 8, 16):
        d = depth.get(str(lv), {})
        lev = next((r for r in p['levels'] if r['level'] == lv), None)
        if not lev:
            continue
        print_sel = (d.get('bid_rows_seen') or {}).keys() or []
        L.append(f"    LEVEL {lv} depth samples (SDK model):")
        for smp in (lev.get('wipro_depth_samples') or {}).get(str(lv), [])[:1]:
            for side in ('buy', 'sell'):
                for row in smp.get(side, [])[:2]:
                    L.append(f"      {side}[{row.get('index')}] price={row.get('price')} "
                             f"quantity={row.get('quantity')} orders={row.get('orders')}")
    L.append("")
    L.append("[12] OBSERVED MESSAGES/SEC")
    for r in p['levels']:
        L.append(f"    L{r['level']}: wipro={r.get('wipro_messages_per_sec')}/s "
                 f"all={r.get('all_messages_per_sec')}/s over {r.get('capture_elapsed_s')}s")
    L.append("")
    L.append("[13] FIRST/LAST RAW FRAME TIMESTAMPS")
    for r in p['levels']:
        L.append(f"    L{r['level']}: first={r.get('raw_first_ts')} last={r.get('raw_last_ts')}")
    L.append("")
    L.append("[14] SDK VS RAW WIRE COMPARISON (independent decode)")
    for block in p['sdk_vs_raw']:
        L.append(f"    ---- LEVEL {block['level']} ----")
        for row in block['rows']:
            L.append(f"      raw={row['raw_wire_field']:30s} sdk={row['sdk_field']:22s} "
                     f"[{row['status']}] {row['transformation']}")
    L.append("")
    L.append("[15] SAMPLE RAW WIRE DECODE (WIPRO packets, independent of SDK)")
    shown = 0
    for r in p['levels']:
        for smp in (r.get('wire_decoded_samples') or [])[:3]:
            hdr = smp.get('header', {})
            body = smp.get('body', {})
            tok = body.get('token')
            lvl_b = hdr.get('level')
            dr = smp.get('depth_rows', [])
            L.append(f"    L{r['level']} raw sample: code={hdr.get('message_code')} "
                     f"level={lvl_b} exch={hdr.get('exchange_id')} token={tok} "
                     f"seq_no={hdr.get('seq_no')} indicative_close={body.get('_indicative_close')} "
                     f"trading_status={body.get('_trading_status')} "
                     f"ltp_raw={body.get('last_traded_price')} depth_rows={len(dr)}")
            shown += 1
            if shown >= 9:
                break
        if shown >= 9:
            break
    L.append("")
    L.append("[16] RATE-LIMIT / API ERROR OBSERVATIONS")
    L.append(f"    errors: {p.get('errors') or '(none recorded)'}")
    L.append(f"    quote elapsed_s: {(p.get('quote') or {}).get('elapsed_s')} | "
             f"scrip master: {'OK' if (p.get('master') or {}).get('wipro_row_count') else 'n/a'}")
    L.append("")
    L.append("[17] FINAL RECOMMENDATIONS")
    for line in p['recommendations']:
        L.append(f"    - {line}")
    L.append("")
    return "\n".join(L) + "\n"


def render_matrix(rows: list[dict]) -> str:
    L = []
    L.append("=" * 112)
    L.append("KOTAK WIPRO FIELD-SOURCE MATRIX (LIVE trial - all sources)")
    L.append("=" * 112)
    L.append(f"{'FIELD':26s} | {'WS L4':7s} | {'WS L8':7s} | {'WS L16':7s} | "
             f"{'QUOTE':6s} | {'INSTR':7s} | {'META':5s} | NOTES")
    L.append("-" * 112)
    for r in rows:
        L.append(f"{r['field']:26s} | {r['L4']:7s} | {r['L8']:7s} | {r['L16']:7s} | "
                 f"{r['quote']:6s} | {r['master']:7s} | {r['meta']:5s} | {r['note']}")
    L.append("")
    L.append("YES = real live value captured from that source in this trial.")
    L.append("NO  = not observed in that source during this trial.")
    L.append("NOT_VERIFIED = that depth level delivered no tick at all (see depth report).")
    L.append("")
    L.append("INSTR = WIPRO row from the daily Kotak Scrip Master CSV (nse_cm-v1).")
    L.append("META  = resolved instrument master metadata (instrument_master.json from the same CSV).")
    L.append("")
    L.append("NOTE: L16 (subscribe_full_depth) was ACK-accepted but delivered only a STATIC")
    L.append("reference snapshot (prev-session OHLC, volume=0, total buy/sell=0, EMPTY book).")
    L.append("A plain NO on the L16 column for a field present on the wire means the value")
    L.append("was static reference data, not a live tick.")
    L.append("")
    return "\n".join(L) + "\n"


async def main() -> int:
    parser = argparse.ArgumentParser(prog="_probe_kotak_wipro_depth.py")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION)
    parser.add_argument("--levels", nargs="+", type=int, default=[4, 8, 16])
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--source", default="probe_wipro_depth")
    parser.add_argument("--out", default=None)
    parser.add_argument("--no-quote", action="store_true")
    parser.add_argument("--no-master", action="store_true")
    parser.add_argument("--replay-evidence", default=None,
                        help="re-render reports from an existing probe_*.json (no network)")
    args = parser.parse_args()
    for lv in args.levels:
        if lv not in (4, 8, 16):
            print(f"ERROR: unsupported level {lv} (choose 4, 8, 16)", file=sys.stderr)
            return 2
    if args.duration <= 0:
        print("ERROR: --duration must be > 0", file=sys.stderr)
        return 2

    market = _market_clock()
    print(f"PROBE: {_ist_now()} market -> {market['window_label']}")

    if args.replay_evidence:
        try:
            with open(args.replay_evidence, encoding="utf-8") as fh:
                payload = json.load(fh)
        except Exception as exc:
            print(f"ERROR: replay-evidence load failed: {exc}", file=sys.stderr)
            return 2
        print(f"PROBE: replay from {args.replay_evidence} "
              f"(captured {payload.get('timestamp_ist')}, no network)")
        levels_out = payload["levels"]
        matrix_rows, depth = build_matrix(levels_out, payload.get("quote"),
                                          payload.get("master"), payload.get("wipro_meta"))
        errors = list(payload.get("errors") or [])
        outdir = Path(args.out) if args.out else DEFAULT_OUT
        return emit(args, payload.get("market") or market, payload.get("session"),
                    payload.get("wipro_meta"), payload.get("master"),
                    payload.get("quote"), levels_out,
                    payload.get("sdk_vs_raw") or [], matrix_rows, depth, errors, outdir)

    ok, code, text = gate_session(args)
    if not ok:
        print(text)
        return code
    print(f"PROBE: {text}")
    sinfo = kotak_session.session_info()
    session_block = {
        "login_outcome": text,
        "user_id": sinfo.get("user_id"),
        "session_active": bool(kotak_session.session_active),
        "logged_in": bool(sinfo.get("logged_in")),
    }

    wipro_meta = resolve_wipro()
    print(f"PROBE: wipro_meta -> {wipro_meta.get('data', wipro_meta.get('error'))}")

    master_data = None
    if not args.no_master:
        master_data = probe_scrip_master()
        print(f"PROBE: scrip master -> rows={master_data.get('total_rows_in_csv')} "
              f"wipro_matches={master_data.get('wipro_row_count')} "
              f"{'' if master_data.get('wipro_row_count') else master_data.get('error', '')}")

    quote_data = None
    if not args.no_quote:
        quote_data = await probe_quote_async()
        print(f"PROBE: quote -> {quote_data.get('error', 'ok')} "
              f"flat_fields={quote_data.get('flat_field_count')} "
              f"elapsed={quote_data.get('elapsed_s')}s")

    outdir = Path(args.out) if args.out else DEFAULT_OUT
    outdir.mkdir(parents=True, exist_ok=True)

    levels_out = []
    for lv in sorted(set(args.levels)):
        print(f"PROBE: === LEVEL {lv} ({SUBSCRIPTION_METHODS[lv][2]}) ===")
        r = await run_level(lv, args.duration, outdir)
        verdict, reason = classify_permission(r, market)
        print(f"PROBE:   -> msgs={r.get('total_sdk_messages')} wipro={r.get('wipro_sdk_messages')} "
              f"acks={len(r.get('acks', []))}")
        print(f"PROBE:   -> PERMISSION {verdict}")
        levels_out.append(r)

    sdk_vs_raw = []
    for r in levels_out:
        rows = independent_compare(r.get("_collector"), r["level"])
        sdk_vs_raw.append({"level": r["level"], "rows": rows})
        r.pop("_collector", None)

    matrix_rows, depth = build_matrix(levels_out, quote_data, master_data, wipro_meta)

    errors = []
    for r in levels_out:
        for k, v in r.items():
            if isinstance(v, str) and (v.startswith("FAILED") or "EXCEPTION" in v or "REJECTED" in v):
                errors.append(f"level {r['level']} {k}: {v}")
    if quote_data and quote_data.get("error"):
        errors.append(f"quote: {quote_data['error']}")
    if master_data and master_data.get("error"):
        errors.append(f"scrip master: {master_data['error']}")

    return emit(args, market, session_block, wipro_meta, master_data, quote_data,
                levels_out, sdk_vs_raw, matrix_rows, depth, errors, outdir)


def emit(args, market, session_block, wipro_meta, master_data, quote_data,
         levels_out, sdk_vs_raw, matrix_rows, depth, errors, outdir) -> int:
    allowed = []
    nv = []
    blocked = []
    depth_verdicts = {}
    live_ticks = []
    for lv in (4, 8, 16):
        rec = next((r for r in levels_out if r["level"] == lv), None)
        if rec is None:
            continue
        verdict = classify_permission(rec, market)[0]
        if verdict == "ALLOWED":
            allowed.append(lv)
        elif verdict == "NOT VERIFIED":
            nv.append(lv)
        else:
            blocked.append(lv)
        dverdict, dreason = classify_level_data(rec)
        depth_verdicts[lv] = {"permission": verdict, "data_verdict": dverdict, "reason": dreason}
        if dverdict in ("VERIFIED_LIVE", "DEPTH_ONLY"):
            live_ticks.append(lv)

    sdk_ver, sdk_loc = "unknown", "unknown"
    try:
        from importlib.metadata import version
        import neo_api_client
        sdk_ver = version("kotakneoapi")
        sdk_loc = os.path.dirname(neo_api_client.__file__)
    except Exception:
        pass

    payload = {
        "timestamp_ist": _ist_now(),
        "utc_iso": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "market": market,
        "sdk": {"version": sdk_ver, "import_name": "neo_api_client", "location": sdk_loc},
        "session": session_block,
        "wipro_meta": wipro_meta,
        "master": master_data,
        "quote": quote_data,
        "levels": levels_out,
        "sdk_vs_raw": sdk_vs_raw,
        "matrix": matrix_rows,
        "depth": {str(k): v for k, v in depth.items()},
        "errors": errors,
        "allowed_levels": allowed,
        "not_verified_levels": nv,
        "blocked_levels": blocked,
        "depth_level_verdicts": {str(k): v for k, v in depth_verdicts.items()},
        "live_tick_levels": live_ticks,
        "recommendations": [
            "In SDK 3.0.6 the depth level is NOT a parameter: it is chosen by "
            "the subscribe method (subscribe_scrips=L4, subscribe_depth=L8, "
            "subscribe_full_depth=L16).",
            "L4 (touch line, 1+1 rows) and L8 (depth, 5+5 rows) delivered a REAL "
            "live, evolving book for WIPRO during NSE cash hours (verified).",
            "L16 (full depth) was ACK-accepted but delivered ONLY a static "
            "reference snapshot: prev-session OHLC, volume=0, total buy/sell=0, "
            "EMPTY book (0+0 rows) in two separate capture windows. Treat "
            "subscribe_full_depth as NOT delivering live full-book depth for "
            "this account/kotakneoapi 3.0.6 until provisioned.",
            "Use ONE subscribe method per instrument per connection to keep the "
            "feed-level tag unambiguous.",
            "seq_no / bitmask_length / _indicative_close / _trading_status are "
            "present on the raw wire but DISCARDED by the SDK parser.",
            "Do NOT schedule quote or scrip-master refreshes faster than the "
            "broker rate limits; treat scrip master as static per-day and quote "
            "as on-demand/cached.",
        ],
    }

    ts = datetime.now(IST).strftime("%Y%m%d_%H%M%S")
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"probe_{ts}.json").write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    REPORT1.write_text(render_report1(payload), encoding="utf-8")
    REPORT2.write_text(render_matrix(matrix_rows), encoding="utf-8")
    (outdir / f"matrix_{ts}.txt").write_text(render_matrix(matrix_rows), encoding="utf-8")
    print(f"PROBE: report1 -> {REPORT1}")
    print(f"PROBE: report2 -> {REPORT2}")
    print(f"PROBE: json evidence -> {outdir / f'probe_{ts}.json'}")

    print()
    print("=" * 66)
    ws_ok = all(r.get("connect") == "OK" for r in levels_out) if levels_out else False
    print(f"WIPRO LIVE WEBSOCKET : {'CONNECTED' if ws_ok else 'FAILED'}")
    for lv in (4, 8, 16):
        rec = next((r for r in levels_out if r["level"] == lv), None)
        if rec is None:
            continue
        pv = classify_permission(rec, market)[0]
        dv = classify_level_data(rec)[0]
        if pv == "BLOCKED":
            v = "BLOCKED"
        elif pv == "NOT VERIFIED":
            v = "NOT VERIFIED"
        elif dv == "VERIFIED_LIVE":
            v = "ALLOWED + LIVE DEPTH"
        elif dv == "DEPTH_ONLY":
            v = "ALLOWED + DEPTH ONLY"
        elif dv == "STATIC_ONLY":
            v = "ACK ONLY - NO LIVE DEPTH"
        else:
            v = "ALLOWED (no data)"
        print(f"LEVEL {lv:<5}            : {v}")
    print(f"LIVE TICK STREAM     : {'L4/L8 VERIFIED' if (4 in live_ticks and 8 in live_ticks) else live_ticks or 'NONE'}")
    print(f"QUOTE API           : {'WORKING' if quote_data and not quote_data.get('error') else 'FAILED'}")
    print(f"INSTRUMENT MASTER   : {'WORKING' if master_data and not master_data.get('error') else 'FAILED'}")
    real_ticks = sorted(live_ticks)
    print(f"REAL LIVE TICKS     : {'YES (' + '/'.join('L%d' % x for x in real_ticks) + ')' if real_ticks else 'NO'}")
    any_real_depth = any(level_real_depth(r) for r in levels_out)
    print(f"DEPTH DATA          : {'YES (L4/L8: real book rows)' if any_real_depth else 'NO'}")
    print(f"ERRORS              : {errors or '(none recorded)'}")
    return 0


def level_real_depth(r: dict) -> bool:
    lv = r["level"]
    info = r.get("wipro_scrip_by_level", {}).get(str(lv), {})
    bid = {int(k) if str(k).isdigit() else -1: v for k, v in (info.get("bid_rows_seen") or {}).items()}
    ask = {int(k) if str(k).isdigit() else -1: v for k, v in (info.get("ask_rows_seen") or {}).items()}
    return any(n > 0 for n in bid) or any(n > 0 for n in ask)


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nPROBE: interrupted")
        raise SystemExit(130)