"""TOTP code generation from a base32 secret, per RFC 6238."""
from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time


def _decode_secret(secret: str) -> bytes:
    cleaned = secret.replace(" ", "").replace("-", "").upper()
    padding = "=" * (-len(cleaned) % 8)
    return base64.b32decode(cleaned + padding)


def generate_totp(secret: str, interval: int = 30, digits: int = 6) -> str:
    key = _decode_secret(secret)
    counter = int(time.time()) // interval
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_bytes = digest[offset : offset + 4]
    code = struct.unpack(">I", code_bytes)[0] & 0x7FFFFFFF
    return str(code % (10**digits)).zfill(digits)

