"""Encrypted pipeline state (data/db.enc) and the published browser index (data/library.enc)."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from . import crypto

DB_FILE = "db.enc"
LIBRARY_FILE = "library.enc"
THUMBS_DIR = "thumbs"


def _canonical_hash(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def empty_db() -> dict[str, Any]:
    return {
        "version": 1,
        "channels": {},  # str(channel_id) -> {id, title, username, last_message_id}
        "states": {},  # str(channel_id) -> grouping state
        "items": {},  # item_id -> item
        "batches": [],  # pending Claude batches: {id, item_ids, submitted_at}
        "index_hash": "",
        "index_updated_at": 0,
    }


class StoreError(Exception):
    pass


class Store:
    def __init__(self, data_dir: Path, password: str, old_password: str = "") -> None:
        self.data_dir = Path(data_dir)
        self.password = password
        self.old_password = old_password
        self.db: dict[str, Any] = empty_db()
        self.salt: bytes = crypto.new_salt()
        self._loaded_hash = ""
        self.rotated = False

    @property
    def thumbs_dir(self) -> Path:
        return self.data_dir / THUMBS_DIR

    def load(self) -> None:
        path = self.data_dir / DB_FILE
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            if (self.data_dir / LIBRARY_FILE).exists():
                # Refuse to silently start over when published data exists but state is missing.
                raise StoreError("db.enc missing while library.enc exists; refusing to overwrite")
            self.db = empty_db()
            self._loaded_hash = ""
            return
        blob = path.read_text(encoding="utf-8")
        try:
            self.db = crypto.decrypt_json(blob, self.password)
            self.salt = crypto.read_salt(blob)
        except crypto.DecryptionError:
            if not self.old_password:
                raise StoreError("cannot decrypt db.enc (wrong SITE_PASSWORD?)") from None
            try:
                self.db = crypto.decrypt_json(blob, self.old_password)
            except crypto.DecryptionError:
                raise StoreError("cannot decrypt db.enc with new or old password") from None
            self.salt = crypto.new_salt()  # password rotation: new salt, force rewrite
            self.rotated = True
        for key, val in empty_db().items():
            self.db.setdefault(key, val)
        self._loaded_hash = "" if self.rotated else _canonical_hash(self.db)

    def _write(self, name: str, payload: Any) -> None:
        target = self.data_dir / name
        tmp = target.with_suffix(".tmp")
        tmp.write_text(crypto.encrypt_json(payload, self.password, self.salt), encoding="utf-8")
        os.replace(tmp, target)

    def save(self, library_payload: dict[str, Any], now: float) -> dict[str, bool]:
        """Write library.enc and db.enc only when their content actually changed."""
        lib_hash = _canonical_hash(library_payload)
        wrote_library = False
        if lib_hash != self.db.get("index_hash") or self.rotated:
            self.db["index_hash"] = lib_hash
            self.db["index_updated_at"] = now
            self._write(LIBRARY_FILE, {**library_payload, "updated_at": now})
            wrote_library = True
        wrote_db = False
        if _canonical_hash(self.db) != self._loaded_hash:
            self._write(DB_FILE, self.db)
            self._loaded_hash = _canonical_hash(self.db)
            wrote_db = True
        return {"library": wrote_library, "db": wrote_db}
