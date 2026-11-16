"""Password-based encryption shared with the browser (see web/src/crypto.js).

File format (UTF-8 JSON):
    {"v": 1, "kdf": "pbkdf2-sha256", "iter": 600000,
     "salt": "<b64 16 bytes>", "iv": "<b64 12 bytes>", "ct": "<b64 AES-256-GCM ciphertext+tag>"}
Plaintext = gzip(UTF-8 JSON payload).
"""

from __future__ import annotations

import base64
import gzip
import json
import os
from functools import lru_cache
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

FORMAT_VERSION = 1
KDF_ITERATIONS = 600_000


class DecryptionError(Exception):
    """Wrong password or corrupted file."""


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


@lru_cache(maxsize=8)
def derive_key(password: str, salt: bytes, iterations: int = KDF_ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode("utf-8"))


def new_salt() -> bytes:
    return os.urandom(16)


def encrypt_json(payload: Any, password: str, salt: bytes) -> str:
    key = derive_key(password, salt)
    iv = os.urandom(12)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(key).encrypt(iv, gzip.compress(raw, mtime=0), None)
    return json.dumps(
        {
            "v": FORMAT_VERSION,
            "kdf": "pbkdf2-sha256",
            "iter": KDF_ITERATIONS,
            "salt": _b64e(salt),
            "iv": _b64e(iv),
            "ct": _b64e(ct),
        }
    )


def read_salt(blob: str) -> bytes:
    return _b64d(json.loads(blob)["salt"])


def decrypt_json(blob: str, password: str) -> Any:
    try:
        env = json.loads(blob)
        if env.get("v") != FORMAT_VERSION or env.get("kdf") != "pbkdf2-sha256":
            raise DecryptionError("unsupported format")
        key = derive_key(password, _b64d(env["salt"]), int(env["iter"]))
        plain = AESGCM(key).decrypt(_b64d(env["iv"]), _b64d(env["ct"]), None)
        return json.loads(gzip.decompress(plain))
    except (InvalidTag, ValueError, KeyError) as exc:
        raise DecryptionError(type(exc).__name__) from None
