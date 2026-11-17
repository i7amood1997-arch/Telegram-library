"""Guest passwords managed from the workflow (no GitHub secret needed).

Guests live in db.enc (encrypted with SITE_PASSWORD). Their passwords are published only in
owner.enc, which is encrypted with SITE_PASSWORD alone, so the owner can read and share them
from the website ("Share access") while guests cannot see each other's passwords.
"""

from __future__ import annotations

import re
import secrets
import time
from typing import Any

# No look-alike characters (0/o, 1/l/i), so passwords are easy to read out and type.
ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
GROUPS, GROUP_LEN = 4, 4  # 16 chars from 31 symbols ≈ 79 bits


class GuestError(ValueError):
    pass


def generate_password() -> str:
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(GROUP_LEN))
                    for _ in range(GROUPS))


def clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name or "").strip()[:40]
    if not name:
        raise GuestError("guest name is empty")
    return name


def add_guest(db: dict[str, Any], name: str) -> dict[str, Any]:
    name = clean_name(name)
    guests = db.setdefault("guests", [])
    if any(g["name"].lower() == name.lower() for g in guests):
        raise GuestError("a guest with this name already exists")
    guest = {"name": name, "password": generate_password(), "created": int(time.time())}
    guests.append(guest)
    return guest


def remove_guest(db: dict[str, Any], name: str) -> bool:
    name = clean_name(name)
    guests = db.setdefault("guests", [])
    keep = [g for g in guests if g["name"].lower() != name.lower()]
    removed = len(keep) != len(guests)
    db["guests"] = keep
    return removed


def owner_payload(db: dict[str, Any], secret_guest_count: int) -> dict[str, Any]:
    return {
        "guests": [{"name": g["name"], "password": g["password"], "created": g["created"]}
                   for g in db.get("guests", [])],
        "secret_guests": secret_guest_count,
    }
