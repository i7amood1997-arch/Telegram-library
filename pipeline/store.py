"""Encrypted pipeline state (data/db.enc) and the published browser index (data/library.enc)."""

from __future__ import annotations

import base64
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
    def __init__(self, data_dir: Path, password: str, old_password: str = "",
                 guest_passwords: list[str] | tuple[str, ...] = ()) -> None:
        self.data_dir = Path(data_dir)
        self.password = password
        self.old_password = old_password
        # Owner first; guests unlock the same published library but never db.enc.
        self.site_passwords = list(dict.fromkeys([password, *[g for g in guest_passwords if g]]))
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
        self._write_text(name, crypto.encrypt_json(payload, self.password, self.salt))

    def _write_text(self, name: str, text: str) -> None:
        target = self.data_dir / name
        tmp = target.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)

    def _access_fingerprint(self) -> str:
        """Identifies the password set + salt; any change means a new content key."""
        material = "\n".join(sorted(self.site_passwords)) + "\n" + self.salt.hex()
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def save(self, library_payload: dict[str, Any], now: float) -> dict[str, bool]:
        """Write library.enc and db.enc only when their content actually changed.

        library.enc can be opened with SITE_PASSWORD or any guest password. When the password
        set changes, the library is re-encrypted with a brand-new content key, so a removed
        guest cannot open it anymore, even with a key remembered in their browser.
        """
        fingerprint = self._access_fingerprint()
        access_changed = (fingerprint != self.db.get("access_fpr")
                          or not self.db.get("content_key"))
        if access_changed:
            self.db["content_key"] = base64.b64encode(crypto.new_content_key()).decode("ascii")
            self.db["access_fpr"] = fingerprint
        lib_hash = _canonical_hash(library_payload)
        wrote_library = False
        if lib_hash != self.db.get("index_hash") or self.rotated or access_changed:
            self.db["index_hash"] = lib_hash
            self.db["index_updated_at"] = now
            content_key = base64.b64decode(self.db["content_key"])
            self._write_text(LIBRARY_FILE, crypto.encrypt_json_multi(
                {**library_payload, "updated_at": now}, self.site_passwords, self.salt,
                content_key))
            wrote_library = True
        wrote_db = False
        if _canonical_hash(self.db) != self._loaded_hash:
            self._write(DB_FILE, self.db)
            self._loaded_hash = _canonical_hash(self.db)
            wrote_db = True
        return {"library": wrote_library, "db": wrote_db}
