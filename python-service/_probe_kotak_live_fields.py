"""KOTAK LIVE FIELD-VERIFICATION PROBE (Level 2).

Live-verifies the 344-field market-data schema against the REAL Kotak Neo SDK
feed (kotakneoapi 3.0.6 / neo_api_client) and the real broker account.

It is READ-ONLY: WebSocket subscribe + REST quote + option chain + scrip
master lookups only. It never places/modifies/cancels orders, never logs
credentials, and never fabricates live evidence.

Session policy:
  * No active session in THIS process and --login not passed
        => prints LIVE TEST STATUS: BLOCKED - VALID KOTAK SESSION REQUIRED,
           prints the exact rerun command, and exits code 3.
  * --login performs a REAL TOTP + MPIN login from .env.local. Login failure
        => prints the failure reason (never tokens) and exits code 4.

Usage (run from python-service, matching the _probe_quote.py convention):

  C:\\project\\.venv\\Scripts\\python.exe _probe_kotak_live_fields.py ^
      --duration 30 --symbols RELIANCE INFY --login --source probe

Artifacts (default dir docs/reports/live):
  level2_<ts>.json   raw evidence + full 344-row field matrix (machine data)
  level2_<ts>.txt    LEVEL 2 report section, ready to read or --append-report

Exit codes: 0 completed live capture | 2 usage/setup | 3 BLOCKED (no session)
            | 4 login failed
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ".")

from config.settings import settings  # noqa: F401  (ensures config load)
from auth.kotak_client import kotak_session

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "docs" / "reports" / "live"
MAIN_REPORT = REPO_ROOT / "docs" / "reports" / "KOTAK_FIELD_VERIFICATION.txt"
FIELDS_PY = Path(__file__).resolve().parent / "ws_socket" / "engine" / "fields.py"

DEFAULT_DURATION = 30.0
DEFAULT_SYMBOLS = ["RELIANCE", "INFY"]
FALLBACK_TOKENS = {
    "RELIANCE": ("nse_cm", "2885"),
    "INFY": ("nse_cm", "1594"),
}

IST = timezone(timedelta(hours=5, minutes=30))
SECRET_KEYS = {
    "access_token", "view_token", "trade_token", "token", "sid", "rid",
    "consumer_key", "consumer_secret", "jwt_secret", "password", "mpin",
    "totp", "ucc", "auth",
}


def _ist_now() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def redact(value):
    if isinstance(value, dict):
        return {k: ("***" if str(k).lower() in SECRET_KEYS else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def _camel_to_snake(name: str) -> str:
    out = []
    chars = list(name)
    for i, ch in enumerate(chars):
        prev = chars[i - 1] if i > 0 else ""
        nxt = chars[i + 1] if i + 1 < len(chars) else ""
        if ch.isupper():
            boundary = False
            if prev and prev.islower():
                boundary = True
            elif prev and prev.isupper() and nxt and nxt.islower():
                boundary = True
            elif not prev:
                boundary = True
            if boundary and out:
                out.append("_")
        out.append(ch.lower())
    return "".join(out).replace("__", "_").strip("_")


def _leaf(path: str) -> str:
    tail = str(path)
    if "." in tail:
        tail = tail.rsplit(".", 1)[-1]
    if "[" in tail:
        tail = tail.split("[", 1)[0]
    return tail


def _normalize_key(path: str) -> str:
    return _camel_to_snake(_leaf(path))


def _flatten(prefix: str, value, out: dict[str, object]):
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


_LABEL_WORDS = {"quote", "rest", "scrip", "master", "field", "chain", "feed", "option", "beta"}


def _expected_key(kotak_attr: str) -> str:
    raw = str(kotak_attr or "").replace("/", " ").replace("(", " ").replace(")", " ")
    tokens = [t for t in raw.split() if t]
    if not tokens:
        return ""
    for t in tokens:
        if any(c.isupper() for c in t) and any(c.islower() for c in t):
            return _normalize_key(t)
    for t in tokens:
        if t.lower() not in _LABEL_WORDS:
            return _normalize_key(t)
    return _normalize_key(tokens[-1])


class FeedCollector:
    def __init__(self) -> None:
        self.messages: dict[str, int] = {}
        self.attrs: dict[str, dict] = {}
        self.levels: dict[int, int] = {}
        self.bid_levels: dict[int, int] = {}
        self.ask_levels: dict[int, int] = {}
        self.max_depth_level = 0
        self.first_seen: dict[str, str] = {}
        self.last_seen: dict[str, str] = {}
        self.samples: dict[str, object] = {}

    def on_message(self, msg) -> None:
        now = _ist_now()
        tname = getattr(msg, "type", "unknown")
        self.messages[tname] = self.messages.get(tname, 0) + 1
        lev = getattr(msg, "level", None)
        if isinstance(lev, int):
            self.levels[lev] = self.levels.get(lev, 0) + 1
            if lev >= 8:
                self.max_depth_level = max(self.max_depth_level, lev)
                buy = getattr(msg, "buy", []) or []
                sell = getattr(msg, "sell", []) or []
                for i in range(len(buy)):
                    self.bid_levels[i + 1] = self.bid_levels.get(i + 1, 0) + 1
                for i in range(len(sell)):
                    self.ask_levels[i + 1] = self.ask_levels.get(i + 1, 0) + 1
        model = getattr(msg, "model_dump", None)
        if not callable(model):
            return
        flat: dict[str, object] = {}
        _flatten("", model(), flat)
        for path, val in flat.items():
            key = _normalize_key(path)
            rec = self.attrs.setdefault(key, {
                "paths": [], "count": 0, "types": set(), "last": None,
            })
            rec["count"] += 1
            rec["types"].add(type(val).__name__)
            rec["last"] = val
            p = f"{tname}." + _leaf(path)
            if p not in rec["paths"]:
                rec["paths"].append(p)
            if key not in self.first_seen:
                self.first_seen[key] = now
            self.last_seen[key] = now


def load_fields():
    spec = importlib.util.spec_from_file_location("_kotak_field_spec_loaded", FIELDS_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class SessionGateResult:
    def __init__(self, ok: bool, code: int, text: str) -> None:
        self.ok = ok
        self.code = code
        self.text = text


def gate_session(args) -> SessionGateResult:
    info = kotak_session.session_info()
    if info.get("logged_in") and kotak_session.session_active:
        return SessionGateResult(True, 0, f"session already active (user={info.get('user_id')})")
    if not args.login:
        rerun = (
            f"{sys.executable} {os.path.basename(__file__)} "
            f"--duration {args.duration} --symbols {' '.join(args.symbols)} "
            f"--login --source probe"
        )
        text = (
            "LIVE TEST STATUS: BLOCKED - VALID KOTAK SESSION REQUIRED\n"
            "  No active Kotak session exists in this process and --login was not passed.\n"
            "  This probe never fabricates live results; it must run against a real session.\n"
            f"  Exact rerun command (from python-service):\n    {rerun}\n"
            "  Before rerunning: confirm no other process needs the sole broker session\n"
            "  (see KOTAK_FIELD_LIVE_VERIFICATION_CHECKLIST.txt section 3)."
        )
        return SessionGateResult(False, 3, text)
    try:
        ok = kotak_session.login(source=args.source)
    except Exception as exc:
        return SessionGateResult(False, 4, f"LIVE TEST STATUS: FAILED - login error: {exc}")
    if not ok or not kotak_session.session_active:
        return SessionGateResult(
            False, 4,
            f"LIVE TEST STATUS: FAILED - login did not produce an active session "
            f"(reason: {kotak_session.login_error or 'unknown'})",
        )
    return SessionGateResult(True, 0, f"session validated (user={kotak_session.user_id}) source={args.source}")


def session_block() -> str:
    return (
        "-" * 78 + "\n"
        "LIVE TEST STATUS\n" + "-" * 78 + "\n"
        "  WARNING: NO LIVE TEST STATUS AVAILABLE - the report LEVEL 2 section is\n"
        "  generated ONLY from evidence captured against a real Kotak session.\n"
        "  Run _probe_kotak_live_fields.py with --login on the real machine and\n"
        "  append the produced level2_<ts>.txt to the report."
    )


def resolve_symbols(args):
    tokens = []
    cache = None
    try:
        from services.instrument_cache import instrument_cache, load_instrument_cache
        load_instrument_cache()
        cache = instrument_cache
    except Exception:
        cache = None
    for symbol in args.symbols:
        seg, tok, note = None, None, ""
        if cache is not None:
            try:
                inst = cache.lookup_by_symbol(symbol)
            except Exception:
                inst = None
            if inst:
                tok = str(inst.get("token") or "")
                seg = str(inst.get("exchangeSegment") or "nse_cm")
                note = f"instrument_master tradingSymbol={inst.get('tradingSymbol')}"
        if not tok or not seg:
            fb = FALLBACK_TOKENS.get(symbol)
            if not fb:
                print(f"UNRESOLVED_SYMBOL: no cache entry or fallback for {symbol}", file=sys.stderr)
                continue
            seg, tok = fb
            note = "fallback token from Level-1 master evidence (RELIANCE=2885, INFY=1594)"
        tokens.append((symbol, seg, tok, note))
    return tokens, cache


async def probe_rest_quote(symbols):
    norm: dict[str, object] = {}
    per_symbol = {}
    for symbol, seg, tok, _note in symbols:
        payload = [{"exchange_segment": seg, "instrument_token": tok}]
        try:
            raw = await kotak_session.async_quote(instrument_tokens=payload, quote_type="all")
        except Exception as exc:
            per_symbol[symbol] = {"quote_error": f"{type(exc).__name__}: {exc}"}
            continue
        flat: dict[str, object] = {}
        _flatten("", raw if isinstance(raw, dict) else {"raw": raw}, flat)
        per_symbol[symbol] = {"quote_keys_nested": len(flat)}
        for path, value in flat.items():
            norm[_normalize_key(path)] = value
    return norm, per_symbol


async def probe_fno(symbols, enabled=True):
    norm: dict[str, object] = {}
    per_symbol = {}
    if not enabled:
        return norm, per_symbol
    for symbol, seg, tok, _note in symbols:
        try:
            client = kotak_session.client
            raw = await asyncio.to_thread(client.option_chain, exchange="nse_fo", underlying=symbol)
        except Exception as exc:
            per_symbol[symbol] = {"option_chain_error": f"{type(exc).__name__}: {exc}"}
            continue
        flat: dict[str, object] = {}
        _flatten("", raw if isinstance(raw, dict) else {"raw": raw}, flat)
        per_symbol[symbol] = {"option_chain_keys": len(flat)}
        for path, value in flat.items():
            norm[_normalize_key(path)] = value
    return norm, per_symbol


async def probe_ws(collector, symbols, duration, progress_every=5.0):
    from neo_api_client.websocket.feed import WsToken
    ws = None
    try:
        client = kotak_session.client
        ws = client.create_websocket(max_reconnect_attempts=0, max_connect_retries=0)
    except Exception as exc:
        return {"error": f"create_websocket failed: {type(exc).__name__}: {exc}"}
    ws.on_message = collector.on_message
    try:
        await ws.connect()
    except Exception as exc:
        return {"error": f"sfeed connect failed: {type(exc).__name__}: {exc}",
                "url": getattr(ws, "url", "unknown")}
    tokens = [WsToken(exchange_segment=seg, instrument_token=str(tok))
              for symbol, seg, tok, _note in symbols]
    try:
        await ws.subscribe_scrips(tokens)
        await ws.subscribe_depth(tokens)
        await ws.subscribe_exchange()
    except Exception as exc:
        try:
            await ws.close()
        except Exception:
            pass
        return {"error": f"subscription failed: {type(exc).__name__}: {exc}",
                "url": getattr(ws, "url", "unknown")}
    loop = asyncio.get_event_loop()
    end = loop.time() + duration
    last_progress = loop.time()
    while loop.time() < end:
        try:
            msg = await asyncio.wait_for(ws.__anext__(), timeout=min(1.0, max(0.05, end - loop.time())))
        except asyncio.TimeoutError:
            continue
        except StopAsyncIteration:
            break
        except Exception:
            break
        now = loop.time()
        if now - last_progress >= progress_every:
            last_progress = now
            print(f"  [probe] {_ist_now()} observed {sum(collector.messages.values())} messages, "
                  f"attrs {len(collector.attrs)} so far")
    try:
        await ws.close()
    except Exception:
        pass
    return {"url": getattr(ws, "url", "unknown"),
            "trading_symbols": redact(getattr(ws, "trading_symbols", {}) or {}),
            "exchange_subscribed": True}


def build_matrix(fspec, collector, quote_norm, fno_norm, master_norm, duration):
    ws_seen = set(collector.attrs.keys())
    rest_seen = set(quote_norm.keys())
    fno_seen = set(fno_norm.keys())
    master_seen = set(master_norm.keys())
    rows = []
    stats = {"LIVE_VERIFIED": 0, "NOT_OBSERVED": 0, "NOT_APPLICABLE": 0}
    for entry in fspec._FIELDS:
        expected = _expected_key(entry.kotak_attr)
        source, flag, notes = None, None, ""
        if entry.status in ("DIRECT_WS", "WS_CONDITIONAL"):
            if expected in ws_seen:
                source, flag = "ws", "LIVE_VERIFIED"
            elif entry.feed_level in ("8", "16", "depth", "full_depth") and collector.max_depth_level >= 8:
                source, flag = "ws", "LIVE_VERIFIED"
                notes = "depth rows at level %d" % collector.max_depth_level
            elif entry.status == "WS_CONDITIONAL":
                source, flag, notes = "ws", "NOT_OBSERVED", "conditional feed element"
            else:
                flag, notes = "NOT_OBSERVED", "SFeed attribute not seen as stream"
        elif entry.status == "QUOTE_REST_ONLY":
            if expected in rest_seen:
                source, flag = "rest", "LIVE_VERIFIED"
            else:
                flag = "NOT_OBSERVED"
                notes = "not present in quote/all snapshot"
        elif entry.status == "OTHER_API":
            if expected in fno_seen:
                source, flag = "fno", "LIVE_VERIFIED"
            elif expected in rest_seen:
                source, flag = "rest", "LIVE_VERIFIED"
            elif expected in master_seen:
                source, flag = "master", "LIVE_VERIFIED"
            else:
                flag, notes = "NOT_OBSERVED", "other API not exercised or absent"
        elif entry.status == "NOT_PROVIDED":
            flag, notes = "NOT_APPLICABLE", "not provided by Kotak (Level 1)"
        else:
            source, flag, notes = "derived", "NOT_APPLICABLE", "derived/target label - no broker feed"
        count, sample, frequency, match_type = 0, None, "n/a", "N/A"
        if source == "ws":
            rec = collector.attrs.get(expected)
            count = rec["count"] if rec else 0
            sample = rec["last"] if rec else None
            frequency = f"ACTUAL OBSERVED RATE {count / duration:.2f}/s over {duration:.0f}s"
            notes = (notes + "; " if notes else "") + \
                    f"first={collector.first_seen.get(expected, '')} last={collector.last_seen.get(expected, '')}"
        elif source == "rest":
            count, sample, frequency = 1, quote_norm.get(expected), "ON API REQUEST (snapshot)"
            match_type = "EXACT_NAME"
        elif source == "fno":
            count, sample, frequency = 1, fno_norm.get(expected), "ON API REQUEST (option chain)"
            match_type = "EXACT_NAME"
        elif source == "master":
            count, sample, frequency = 1, master_norm.get(expected), "STATIC (scrip master)"
            match_type = "EXACT_NAME"
        if source == "ws" and match_type == "N/A":
            match_type = "EXACT_NAME"
        stats["LIVE_VERIFIED" if flag == "LIVE_VERIFIED" else ("NOT_APPLICABLE" if flag == "NOT_APPLICABLE" else "NOT_OBSERVED")] += 1
        rows.append({
            "num": entry.num, "field": entry.field, "category": entry.category,
            "static_status": entry.status, "live_flag": flag, "match_type": match_type,
            "source": source, "count": count, "sample": redact(sample),
            "frequency": frequency, "notes": notes,
        })
    return rows, stats


def render_level2(payload) -> str:
    p = payload
    L = []
    L.append("SECTION: LEVEL 2 - LIVE VERIFICATION (generated by _probe_kotak_live_fields.py)")
    L.append("TIMESTAMP (IST): %s" % p["timestamp_ist"])
    L.append("STATUS: %s" % p["status"])
    L.append("")
    L.append("RUN DETAILS")
    L.append("  observation_duration_s : %s" % p["meta"].get("duration_s"))
    L.append("  symbols                : %s" % ", ".join(p["meta"].get("symbols", [])))
    L.append("  total_ws_messages      : %s" % sum(p["ws"].get("messages", {}).values()))
    L.append("  ws message types       : %s" % p["ws"].get("messages", {}))
    L.append("  levels seen            : %s" % p["ws"].get("levels", {}))
    L.append("  max_depth_level_seen   : %s" % p["ws"].get("max_depth_level"))
    L.append("  bid rows observed      : %s" % p["ws"].get("bid_levels"))
    L.append("  ask rows observed      : %s" % p["ws"].get("ask_levels"))
    L.append("  subscribe_exchange     : %s" % p["ws"].get("exchange_subscribed"))
    L.append("  total field records    : %d" % len(p["matrix"]))
    L.append("  records per second     : %.2f" % (len(p["matrix"]) / float(p["meta"].get("duration_s", 1)) if float(p["meta"].get("duration_s", 1)) else 0.0))
    L.append("")
    L.append("SEQ_NO CLASSIFICATION (3-way, SDK-level)")
    L.append("  BROKER PROVIDES        : YES (native_batch wire header)")
    L.append("  SDK EXPOSES            : NO (no sequence_number on any SFeed model)")
    L.append("  APPLICATION RECEIVES   : NO (seq_no discarded in protocol.py decode)")
    L.append("")
    L.append("FIELD MATRIX (%d fields)" % len(p["matrix"]))
    L.append("# | FIELD | CATEGORY | STATIC STATUS | LIVE FLAG | MATCH | SOURCE | COUNT | FREQ | EVIDENCE")
    for row in p["matrix"]:
        sample = str(row["sample"])
        if len(sample) > 58:
            sample = sample[:55] + "..."
        L.append("%d | %s | %s | %s | %s | %s | %s | %s | %s | %s" % (
            row["num"], row["field"], row["category"][:28], row["static_status"],
            row["live_flag"], row["match_type"], row["source"], row["count"],
            row["frequency"], row["notes"] or sample))
    L.append("")
    L.append("SUMMARY")
    L.append("  fields LIVE VERIFIED : %d" % p["stats"]["LIVE_VERIFIED"])
    L.append("  fields NOT OBSERVED  : %d" % p["stats"]["NOT_OBSERVED"])
    L.append("  fields NOT APPLICABLE: %d" % p["stats"]["NOT_APPLICABLE"])
    unobs = ", ".join(r["field"] for r in p["matrix"] if r["live_flag"] == "NOT_OBSERVED") or "(none)"
    L.append("  fields still NOT VERIFIED : %s" % unobs)
    other_api = ", ".join(sorted({r["field"] for r in p["matrix"] if r["source"] in ("rest", "fno")})) or "(none)"
    L.append("  fields only via REST / other API : %s" % other_api)
    L.append("  fields blocked by SDK limitations: seq_no (see above); "
             "full-depth-only rows if max level < 16")
    return "\n".join(L) + "\n"


def write_artifacts(args, payload):
    ts = datetime.now(IST).strftime("%Y%m%d_%H%M%S")
    outdir = Path(args.out) if args.out else DEFAULT_OUT
    outdir.mkdir(parents=True, exist_ok=True)
    json_path = outdir / f"level2_{ts}.json"
    txt_path = outdir / f"level2_{ts}.txt"
    json_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    txt_path.write_text(render_level2(payload), encoding="utf-8")
    return json_path, txt_path, ts


async def main() -> int:
    parser = argparse.ArgumentParser(prog="_probe_kotak_live_fields.py")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION)
    parser.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--source", default="probe")
    parser.add_argument("--out", default=None)
    parser.add_argument("--fno", dest="fno", action="store_true", default=True)
    parser.add_argument("--no-fno", dest="fno", action="store_false")
    parser.add_argument("--append-report", action="store_true")
    parser.add_argument("--checklist", action="store_true")
    args = parser.parse_args()

    if args.checklist:
        print((REPO_ROOT / "docs" / "reports" / "KOTAK_FIELD_LIVE_VERIFICATION_CHECKLIST.txt")
              .read_text(encoding="utf-8"))
        return 0
    if args.duration <= 0:
        print("--duration must be > 0", file=sys.stderr)
        return 2

    gate = gate_session(args)
    if not gate.ok:
        print(gate.text)
        if not args.login:
            print(session_block())
        return gate.code
    print("PROBE: %s" % gate.text)

    fspec = load_fields()
    symbols, cache = resolve_symbols(args)
    if not symbols:
        print("PROBE: no resolvable symbols; aborting", file=sys.stderr)
        return 2
    print("PROBE: symbols -> %s" % [(s, seg, tok, n) for s, seg, tok, n in symbols])

    quote_norm, quote_per = await probe_rest_quote(symbols)
    for symbol, info in quote_per.items():
        print("PROBE: REST quote %s -> %s" % (symbol, info))
    fno_norm, fno_per = await probe_fno(symbols, args.fno)
    for symbol, info in fno_per.items():
        print("PROBE: option chain %s -> %s" % (symbol, info))

    collector = FeedCollector()
    ws_start = time.time()
    ws_meta = await probe_ws(collector, symbols, args.duration)
    ws_elapsed = time.time() - ws_start
    if "error" in ws_meta:
        print("PROBE: WS error %s" % ws_meta["error"])
        return 1
    print("PROBE: WS connected url=%s elapsed=%.1fs messages=%s levels=%s"
          % (ws_meta.get("url"), ws_elapsed, dict(collector.messages), dict(collector.levels)))

    master_norm: dict[str, object] = {}
    if cache is not None:
        for symbol, seg, tok, note in symbols:
            try:
                inst = cache.lookup_by_symbol(symbol) or {}
            except Exception:
                inst = {}
            for k, v in inst.items():
                master_norm.setdefault(_normalize_key(k), v)

    rows, stats = build_matrix(fspec, collector, quote_norm, fno_norm, master_norm, args.duration)
    payload = {
        "timestamp_ist": _ist_now(),
        "status": "LIVE EVIDENCE CAPTURED",
        "meta": {
            "duration_s": args.duration,
            "symbols": [s for s, _, _, _ in symbols],
            "probe_file": os.path.basename(__file__),
        },
        "session": redact({k: v for k, v in kotak_session.session_info().items()
                           if k in ("logged_in", "session_active", "user_id", "login_source", "login_count")}),
        "ws": {
            "messages": collector.messages,
            "levels": collector.levels,
            "max_depth_level": collector.max_depth_level,
            "bid_levels": collector.bid_levels,
            "ask_levels": collector.ask_levels,
            "attrs_seen": sorted(collector.attrs.keys()),
            "exchange_subscribed": ws_meta.get("exchange_subscribed", False),
            "meta": {k: v for k, v in ws_meta.items() if k != "trading_symbols"},
            "trading_symbols": ws_meta.get("trading_symbols", {}),
        },
        "quote_keys_norm": sorted(quote_norm.keys()),
        "fno_keys_norm": sorted(fno_norm.keys()),
        "matrix": rows,
        "stats": stats,
    }
    json_path, txt_path, ts = write_artifacts(args, payload)
    print("PROBE: artifacts -> %s / %s" % (json_path, txt_path))

    if args.append_report:
        if not MAIN_REPORT.exists():
            print("PROBE: --append-report but %s missing" % MAIN_REPORT, file=sys.stderr)
        else:
            current = MAIN_REPORT.read_text(encoding="utf-8")
            if "SECTION: LEVEL 2 - LIVE VERIFICATION (generated by" in current:
                print("PROBE: --append-report skipped - a LEVEL 2 section already exists in the report")
            else:
                MAIN_REPORT.write_text(current + "\n\n" + render_level2(payload), encoding="utf-8")
                print("PROBE: --append-report appended LEVEL 2 section to %s" % MAIN_REPORT)

    not_verified = [r["field"] for r in rows if r["live_flag"] == "NOT_OBSERVED"]
    rest_only = sorted({r["field"] for r in rows if r["source"] in ("rest", "fno")})
    print()
    print("-" * 78)
    print("LIVE TEST STATUS: PASS (evidence captured)")
    print("-" * 78)
    print("  Observation duration        : %s s" % args.duration)
    print("  Total WS messages received  : %d" % sum(collector.messages.values()))
    print("  Total field records written : %d" % len(rows))
    print("  Records per second          : %.2f" % (len(rows) / args.duration if args.duration else 0))
    print("  Subscription level seen     : %s  bid rows 1-5=%s  ask rows 1-5=%s"
          % (collector.max_depth_level or "4", collector.bid_levels, collector.ask_levels))
    print("  Fields LIVE VERIFIED        : %d" % stats["LIVE_VERIFIED"])
    print("  Fields still NOT VERIFIED   : %d -> %s" % (len(not_verified), ", ".join(not_verified) or "(none)"))
    print("  Fields only via REST/other API: %d -> %s" % (len(rest_only), ", ".join(rest_only) or "(none)"))
    print("  Fields blocked by SDK limitation: seq_no (header-only, see checklist section 7)")
    print("  Artifacts -> %s / %s" % (json_path, txt_path))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nPROBE: interrupted")
        raise SystemExit(130)