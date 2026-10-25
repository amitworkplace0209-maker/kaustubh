"""Minimal CBOR (RFC 8949) codec for WebAuthn / COSE structures.

WebAuthn attestation objects, authenticator data and COSE public keys use a
small subset of CBOR: unsigned / negative integers, byte strings, text strings,
arrays and maps. This module decodes and encodes exactly that subset with strict
bounds / minimal-encoding checks — enough for local-RP WebAuthn verification
without pulling in a full CBOR dependency.
"""
from __future__ import annotations

from typing import Any


class CborError(ValueError):
    pass


def _read(data: bytes, offset: int, n: int) -> bytes:
    end = offset + n
    if end > len(data):
        raise CborError("truncated CBOR input")
    return data[offset:end]


def _length(data: bytes, offset: int, info: int) -> tuple[int, int]:
    """Return (length, next offset) for an additional-info length."""
    if info < 24:
        return info, offset
    n = {24: 1, 25: 2, 26: 4, 27: 8}.get(info)
    if n is None:
        raise CborError(f"unsupported CBOR additional info: {info}")
    raw = _read(data, offset, n)
    length = int.from_bytes(raw, "big")
    if n == 1 and length < 24:
        raise CborError("non-minimal CBOR length encoding")
    return length, offset + n


def cbor_decode(data: bytes, offset: int = 0) -> tuple[Any, int]:
    """Decode ONE CBOR value starting at offset; returns (value, next offset)."""
    if offset >= len(data):
        raise CborError("empty CBOR input")
    major = data[offset] >> 5
    info = data[offset] & 0x1F
    off = offset + 1

    if major == 0:  # unsigned int
        length, off = _length(data, off, info)
        return length, off

    if major == 1:  # negative int
        length, off = _length(data, off, info)
        return -1 - length, off

    if major == 2:  # byte string
        length, off = _length(data, off, info)
        return _read(data, off, length), off + length

    if major == 3:  # text string
        length, off = _length(data, off, info)
        raw = _read(data, off, length)
        try:
            return raw.decode("utf-8"), off + length
        except UnicodeDecodeError as exc:
            raise CborError("invalid UTF-8 text string") from exc

    if major == 4:  # array
        count, off = _length(data, off, info)
        items: list[Any] = []
        for _ in range(count):
            item, off = cbor_decode(data, off)
            items.append(item)
        return items, off

    if major == 5:  # map
        count, off = _length(data, off, info)
        mapping: dict[Any, Any] = {}
        for _ in range(count):
            key, off = cbor_decode(data, off)
            value, off = cbor_decode(data, off)
            if not isinstance(key, (int, str, bytes)):
                raise CborError(f"unsupported CBOR map key type: {type(key).__name__}")
            mapping[key] = value
        return mapping, off

    if major == 6:  # tag — return the tagged inner value
        _, off = _length(data, off, info)
        value, off = cbor_decode(data, off)
        return value, off

    if major == 7:  # simple values used by COSE maps are not expected; booleans only
        if info == 20:
            return False, off
        if info == 21:
            return True, off
        raise CborError(f"unsupported CBOR simple/float value: {info}")

    raise CborError(f"unknown CBOR major type: {major}")


def cbor_loads(data: bytes) -> Any:
    value, off = cbor_decode(data, 0)
    if off != len(data):
        raise CborError("trailing bytes after CBOR payload")
    return value


def _head(major: int, length: int) -> bytes:
    if length < 24:
        return bytes([(major << 5) | length])
    if length < (1 << 8):
        return bytes([(major << 5) | 24, length])
    if length < (1 << 16):
        return bytes([(major << 5) | 25]) + length.to_bytes(2, "big")
    if length < (1 << 32):
        return bytes([(major << 5) | 26]) + length.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + length.to_bytes(8, "big")


def cbor_dumps(value: Any) -> bytes:
    """Encode the WebAuthn/COSE subset (used by tests to build valid payloads)."""
    if value is None:
        return b"\xf6"
    if value is True:
        return b"\xf5"
    if value is False:
        return b"\xf4"
    if isinstance(value, int):
        if value >= 0:
            return _head(0, value)
        return _head(1, -1 - value)
    if isinstance(value, bytes):
        return _head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return _head(3, len(raw)) + raw
    if isinstance(value, (list, tuple)):
        out = _head(4, len(value))
        for item in value:
            out += cbor_dumps(item)
        return out
    if isinstance(value, dict):
        out = _head(5, len(value))
        for key, item in value.items():
            out += cbor_dumps(key) + cbor_dumps(item)
        return out
    raise CborError(f"cannot encode {type(value).__name__}")