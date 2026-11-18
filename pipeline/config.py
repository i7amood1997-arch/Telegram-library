"""Runtime configuration, loaded from environment variables (GitHub Secrets in Actions)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
TAXONOMY_PATH = ROOT / "taxonomy.yml"

# Grouping window: an archive attaches to a preview photo at most this far back.
GROUP_MAX_MESSAGE_GAP = 15
GROUP_MAX_SECONDS = 6 * 3600

# Archive similarity threshold (0..1) for merging consecutive archives into one item.
NAME_SIMILARITY = 0.8

THUMB_MAX_EDGE = 360  # keeps the Pages site well under GitHub's 1 GB limit
THUMB_QUALITY = 62
AI_IMAGE_EDGE = 256  # images sent to Claude are shrunk further: fewer image tokens

MAX_CLASSIFY_ATTEMPTS = 3
CAPTION_MAX_CHARS = 1500


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Taxonomy:
    version: int
    categories: dict[str, list[str]]
    styles: list[str]
    render_engines: list[str]

    @property
    def groups(self) -> list[str]:
        return list(self.categories)

    @property
    def all_categories(self) -> list[str]:
        return [c for cats in self.categories.values() for c in cats]

    def group_of(self, category: str) -> str | None:
        for group, cats in self.categories.items():
            if category in cats:
                return group
        return None

    def as_dict(self) -> dict:
        return {
            "version": self.version,
            "categories": self.categories,
            "styles": self.styles,
            "render_engines": self.render_engines,
        }


def load_taxonomy(path: Path = TAXONOMY_PATH) -> Taxonomy:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return Taxonomy(
        version=int(raw["version"]),
        categories={str(k): [str(c) for c in v] for k, v in raw["categories"].items()},
        styles=[str(s) for s in raw["styles"]],
        render_engines=[str(r) for r in raw["render_engines"]],
    )


def parse_channels(raw: str) -> list[str]:
    """Channels secret: usernames (with or without @, or t.me links) or numeric IDs."""
    out: list[str] = []
    for part in re.split(r"[\s,]+", raw):
        part = part.strip()
        if not part:
            continue
        part = re.sub(r"^(https?://)?t\.me/", "", part).lstrip("@").rstrip("/")
        out.append(part)
    return out


@dataclass
class Settings:
    api_id: int = 0
    api_hash: str = ""
    session: str = ""
    channels: list[str] = field(default_factory=list)
    anthropic_key: str = ""
    site_password: str = ""
    site_password_old: str = ""
    guest_passwords: list[str] = field(default_factory=list)
    guest_name: str = ""
    thumb_secret: str = ""
    classifier_model: str = "claude-haiku-5-5"
    max_classifications: int = 300
    batch_threshold: int = 40
    max_batch_items: int = 4000
    time_budget_s: int = 20 * 60

    @classmethod
    def from_env(cls) -> Settings:
        api_id = _env("TG_API_ID")
        return cls(
            api_id=int(api_id) if api_id.isdigit() else 0,
            api_hash=_env("TG_API_HASH"),
            session=_env("TG_SESSION"),
            channels=parse_channels(_env("TG_CHANNELS")),
            anthropic_key=_env("ANTHROPIC_API_KEY"),
            site_password=_env("SITE_PASSWORD"),
            site_password_old=_env("SITE_PASSWORD_OLD"),
            guest_passwords=[g.strip() for g in _env("GUEST_PASSWORDS").splitlines()
                             if g.strip()],
            guest_name=_env("GUEST_NAME"),
            thumb_secret=_env("THUMB_SECRET"),
            classifier_model=_env("CLASSIFIER_MODEL") or "claude-haiku-5-5",
            max_classifications=int(_env("MAX_CLASSIFICATIONS_PER_RUN") or 300),
            batch_threshold=int(_env("BATCH_THRESHOLD") or 40),
            max_batch_items=int(_env("MAX_BATCH_ITEMS") or 4000),
            time_budget_s=int(_env("TIME_BUDGET_SECONDS") or 20 * 60),
        )

    def missing(self, *, telegram: bool = True) -> list[str]:
        missing = []
        if not self.site_password:
            missing.append("SITE_PASSWORD")
        if not self.thumb_secret:
            missing.append("THUMB_SECRET")
        if telegram:
            for name, val in (
                ("TG_API_ID", self.api_id),
                ("TG_API_HASH", self.api_hash),
                ("TG_SESSION", self.session),
                ("TG_CHANNELS", self.channels),
            ):
                if not val:
                    missing.append(name)
        return missing
