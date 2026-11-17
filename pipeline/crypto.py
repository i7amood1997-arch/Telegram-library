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


# --------------------------------------------------------------------------------------------
# Format v2: one content key, unlocked by any of several passwords ("key slots").
#
#   {"v": 2, "kdf": "pbkdf2-sha256", "iter": 600000, "salt": "<b64>",
#    "slots": [{"iv": "<b64>", "wk": "<b64 AES-GCM(password_key, content_key)>"}, ...],
#    "iv": "<b64>", "ct": "<b64 AES-GCM(content_key, gzip(JSON))>"}
#
# All slots share one salt, so the browser derives the (slow) PBKDF2 key once and then tries
# each slot cheaply. Slots are shuffled so their order says nothing about whose they are.
# --------------------------------------------------------------------------------------------

FORMAT_V2 = 2


def new_content_key() -> bytes:
    return os.urandom(32)


def encrypt_json_multi(payload: Any, passwords: list[str], salt: bytes, content_key: bytes
                       ) -> str:
    if not passwords:
        raise ValueError("at least one password is required")
    slots = []
    for pw in passwords:
        iv = os.urandom(12)
        wk = AESGCM(derive_key(pw, salt)).encrypt(iv, content_key, None)
        slots.append({"iv": _b64e(iv), "wk": _b64e(wk)})
    order = list(range(len(slots)))
    for i in range(len(order) - 1, 0, -1):  # Fisher-Yates with os.urandom
        j = int.from_bytes(os.urandom(4), "big") % (i + 1)
        order[i], order[j] = order[j], order[i]
    iv = os.urandom(12)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(content_key).encrypt(iv, gzip.compress(raw, mtime=0), None)
    return json.dumps({
        "v": FORMAT_V2, "kdf": "pbkdf2-sha256", "iter": KDF_ITERATIONS, "salt": _b64e(salt),
        "slots": [slots[i] for i in order], "iv": _b64e(iv), "ct": _b64e(ct),
    })


def decrypt_json_multi(blob: str, password: str) -> Any:
    try:
        env = json.loads(blob)
        if env.get("v") != FORMAT_V2:
            return decrypt_json(blob, password)
        key = derive_key(password, _b64d(env["salt"]), int(env["iter"]))
        for slot in env["slots"]:
            try:
                content_key = AESGCM(key).decrypt(_b64d(slot["iv"]), _b64d(slot["wk"]), None)
            except InvalidTag:
                continue
            plain = AESGCM(content_key).decrypt(_b64d(env["iv"]), _b64d(env["ct"]), None)
            return json.loads(gzip.decompress(plain))
        raise DecryptionError("no matching password")
    except (InvalidTag, ValueError, KeyError) as exc:
        raise DecryptionError(type(exc).__name__) from None
