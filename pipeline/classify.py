"""Automatic classification of model items with the Claude API (text + preview image)."""

from __future__ import annotations

import base64
import logging
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from .config import CAPTION_MAX_CHARS, MAX_CLASSIFY_ATTEMPTS, Taxonomy

log = logging.getLogger("pipeline.classify")

PROMPT_VERSION = 1
TOOL_NAME = "record_classification"
MAX_TOKENS = 700
BATCH_MAX_ITEMS = 4000

SYSTEM_PROMPT = """\
You catalogue 3ds Max models and other resources for an architectural visualization artist. \
Each item comes from a Telegram channel post: a preview image plus file names and an \
optional caption \
(captions may be in any language, often Russian, Arabic or Chinese, and may contain \
hashtags, links or channel advertising; ignore advertising).

Classify the model by calling the record_classification tool exactly once.
Rules:
- Output everything in English.
- title: a clean, specific, human-readable name (2-6 words, Title Case) describing what the \
model shows, e.g. "Boucle Curved Sofa", "Olive Tree in Pot". Use the brand or designer name \
only if it is clearly stated. Never include file extensions, version numbers or channel names.
- category must be one of the allowed values; pick the one matching the main object. If the \
preview shows a full furnished room or a complete exterior view, use the matching Scene category.
- Not every item is a model. Use the Resources group when the item is:
  - "Materials & Textures": material libraries, PBR texture sets, seamless textures, decals, \
  .sbsar files, or previews of material spheres / flat texture swatches.
  - "HDRI": HDR / EXR environment maps and sky domes (often a panorama or sky preview).
  - "Plugins & Add-ons": 3ds Max scripts and plugins (.ms, .mzp, .mse, .mcr), render-engine \
  add-ons, tools and presets.
  - "3D Software": installers or updates of applications (3ds Max, Corona, V-Ray, Photoshop, \
  etc.), .exe / .msi / .iso files, often shown with a logo or splash screen.
  For Resources, style may be "Other" and render_engine "Unknown" unless stated.
- style: the dominant design style; use "Other" when unclear.
- render_engine and max_version: use the hints provided when present; otherwise infer from \
the text; use "Unknown"/null when not stated. Do not guess a version from the image.
- materials and colors: up to 5 each, lowercase, visible in the preview.
- tags: 5-12 lowercase English search keywords a person might type, including synonyms \
(e.g. "couch" for a sofa), object types, shapes and notable features.
- is_collection: true when the archive clearly contains many different models (a pack/set).
- confidence: 0-1, how sure you are about the category.
"""

_RENDER_PATTERNS = [
    ("Corona", re.compile(r"(?<![a-z])corona(?![a-z])", re.I)),
    ("V-Ray", re.compile(r"(?<![a-z])v[\s\-_]?ray(?![a-z])", re.I)),
    ("FStorm", re.compile(r"(?<![a-z])f[\s\-_]?storm(?![a-z])", re.I)),
    ("Arnold", re.compile(r"(?<![a-z])arnold(?![a-z])", re.I)),
]
_MAX_VERSION = re.compile(r"(?:3ds[\s_\-]*)?max[\s_\-]*(20[0-3]\d)(?!\d)", re.I)


def extract_hints(text: str) -> dict[str, str]:
    """Deterministic hints from file names + caption."""
    hints: dict[str, str] = {}
    engines = {name for name, pat in _RENDER_PATTERNS if pat.search(text)}
    if len(engines) == 1:
        hints["render_engine"] = engines.pop()
    elif len(engines) > 1:
        hints["render_engine_candidates"] = ", ".join(sorted(engines))
    versions = sorted({m.group(1) for m in _MAX_VERSION.finditer(text)})
    if versions:
        hints["max_version"] = versions[0]  # oldest version listed = minimum needed
    return hints


class Classification(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    group: str
    category: str
    style: str
    render_engine: str
    max_version: str | None = None
    materials: list[str] = Field(default_factory=list)
    colors: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    is_collection: bool = False
    confidence: float = 0.0


def tool_schema(tax: Taxonomy) -> dict[str, Any]:
    str_list = {"type": "array", "items": {"type": "string"}}
    return {
        "name": TOOL_NAME,
        "description": "Record the classification of one 3D model.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "group": {"type": "string", "enum": tax.groups},
                "category": {"type": "string", "enum": tax.all_categories},
                "style": {"type": "string", "enum": tax.styles},
                "render_engine": {"type": "string", "enum": tax.render_engines},
                "max_version": {"type": ["string", "null"]},
                "materials": str_list,
                "colors": str_list,
                "tags": str_list,
                "is_collection": {"type": "boolean"},
                "confidence": {"type": "number"},
            },
            "required": ["title", "group", "category", "style", "render_engine", "tags",
                         "is_collection", "confidence"],
        },
    }


def _clean_list(values: list[str], limit: int) -> list[str]:
    out: list[str] = []
    for v in values:
        v = re.sub(r"\s+", " ", str(v)).strip().lower().lstrip("#")
        if v and v not in out:
            out.append(v)
    return out[:limit]


def normalize(data: dict[str, Any], tax: Taxonomy, hints: dict[str, str]) -> dict[str, Any]:
    """Validate a raw tool input and coerce it onto the taxonomy."""
    c = Classification.model_validate(data)
    group = tax.group_of(c.category)
    if group is None:
        raise ValueError("category outside taxonomy")
    render = hints.get("render_engine") or c.render_engine
    if render not in tax.render_engines:
        render = "Unknown"
    version = hints.get("max_version") or c.max_version
    if version and not re.fullmatch(r"20[0-3]\d", str(version)):
        version = None
    return {
        "title": re.sub(r"\s+", " ", c.title).strip(),
        "group": group,
        "category": c.category,
        "style": c.style if c.style in tax.styles else "Other",
        "render_engine": render,
        "max_version": version,
        "materials": _clean_list(c.materials, 5),
        "colors": _clean_list(c.colors, 5),
        "tags": _clean_list(c.tags, 12),
        "is_collection": c.is_collection,
        "confidence": max(0.0, min(1.0, float(c.confidence))),
    }


def fallback(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": pretty_title(item),
        "group": "Uncategorized",
        "category": "Uncategorized",
        "style": "Other",
        "render_engine": extract_hints(item_text(item)).get("render_engine", "Unknown"),
        "max_version": extract_hints(item_text(item)).get("max_version"),
        "materials": [],
        "colors": [],
        "tags": [],
        "is_collection": False,
        "confidence": 0.0,
    }


def pretty_title(item: dict[str, Any]) -> str:
    from .grouping import parse_archive_name

    name = item["files"][0]["name"] if item.get("files") else "Untitled"
    parsed = parse_archive_name(name)
    base = parsed.base if parsed else name
    noise = r"\b(?:3ds ?)?max ?20[0-3]\d\b|\b(?:max|3ds|corona|vray|v ray|fstorm|20[0-3]\d)\b"
    base = re.sub(noise, " ", base, flags=re.I)
    base = re.sub(r"\s+", " ", base).strip()
    return base.title() if base else "Untitled"


def item_text(item: dict[str, Any]) -> str:
    names = " ".join(f["name"] for f in item.get("files", []))
    return f"{names}\n{item.get('caption', '')}"


def build_request(
    item: dict[str, Any], channel_title: str, thumb_path: Path | None, tax: Taxonomy, model: str
) -> dict[str, Any]:
    hints = extract_hints(item_text(item))
    files = "\n".join(f"- {f['name']} ({f['size'] / 1_048_576:.1f} MB)" for f in item["files"])
    caption = (item.get("caption") or "").strip()[:CAPTION_MAX_CHARS] or "(none)"
    hint_text = "\n".join(f"- {k}: {v}" for k, v in hints.items()) or "(none)"
    text = (
        f"Channel: {channel_title}\n\nArchive files:\n{files}\n\n"
        f"Caption:\n{caption}\n\nDetected hints:\n{hint_text}"
    )
    content: list[dict[str, Any]] = []
    if thumb_path is not None and thumb_path.exists():
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/webp",
                       "data": base64.b64encode(thumb_path.read_bytes()).decode("ascii")},
        })
    else:
        text += "\n\n(No preview image available; classify from the text.)"
    content.append({"type": "text", "text": text})
    return {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": content}],
        "tools": [tool_schema(tax)],
        "tool_choice": {"type": "tool", "name": TOOL_NAME},
    }


def _tool_input(message: Any) -> dict[str, Any] | None:
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and block.name == TOOL_NAME:
            return dict(block.input)
    return None


def needs_classification(item: dict[str, Any], tax: Taxonomy) -> bool:
    if item.get("classification") is None:
        return True
    return item.get("taxonomy_version") != tax.version


def _apply(item: dict[str, Any], raw: dict[str, Any] | None, tax: Taxonomy) -> bool:
    """Store a classification on the item; returns True on success."""
    hints = extract_hints(item_text(item))
    if raw is not None:
        try:
            item["classification"] = normalize(raw, tax, hints)
            item["taxonomy_version"] = tax.version
            item["prompt_version"] = PROMPT_VERSION
            item["cls_img"] = bool(item.get("thumb"))
            item.pop("classify_attempts", None)
            return True
        except (ValidationError, ValueError, TypeError):
            pass
    item["classify_attempts"] = item.get("classify_attempts", 0) + 1
    if item["classify_attempts"] >= MAX_CLASSIFY_ATTEMPTS:
        item["classification"] = fallback(item)
        item["taxonomy_version"] = tax.version
    return False


def _custom_id(item_id: str) -> str:
    return item_id.replace(":", "_").replace("-", "m")


class Classifier:
    def __init__(self, client: Any, tax: Taxonomy, model: str, thumbs_dir: Path,
                 channel_title: Callable[[dict[str, Any]], str]) -> None:
        self.client = client
        self.tax = tax
        self.model = model
        self.thumbs_dir = thumbs_dir
        self.channel_title = channel_title

    def _request(self, item: dict[str, Any]) -> dict[str, Any]:
        thumb = self.thumbs_dir / item["thumb"] if item.get("thumb") else None
        return build_request(item, self.channel_title(item), thumb, self.tax, self.model)

    def classify_one(self, item: dict[str, Any]) -> bool:
        for attempt in range(2):
            try:
                msg = self.client.messages.create(**self._request(item))
            except Exception as exc:  # network / rate limit: log type only, never content
                log.warning("classify error %s (attempt %d)", type(exc).__name__, attempt + 1)
                time.sleep(2 * (attempt + 1))
                continue
            raw = _tool_input(msg)
            if raw is not None:
                return _apply(item, raw, self.tax)
        return _apply(item, None, self.tax)

    def classify_now(self, items: list[dict[str, Any]], deadline: float) -> int:
        done = 0
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = []
            for item in items:
                if time.time() > deadline:
                    break
                futures.append(pool.submit(self.classify_one, item))
            for f in futures:
                done += int(f.result())
        return done

    def submit_batch(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        items = items[:BATCH_MAX_ITEMS]
        requests = [{"custom_id": _custom_id(i["id"]), "params": self._request(i)} for i in items]
        batch = self.client.messages.batches.create(requests=requests)
        return {"id": batch.id, "item_ids": [i["id"] for i in items], "submitted_at": time.time()}

    def collect_batch(self, record: dict[str, Any], items: dict[str, dict[str, Any]]) -> int | None:
        """Returns number classified when the batch finished, or None while still running."""
        batch = self.client.messages.batches.retrieve(record["id"])
        if batch.processing_status != "ended":
            return None
        by_custom = {_custom_id(i): i for i in record["item_ids"]}
        done = 0
        for res in self.client.messages.batches.results(record["id"]):
            item = items.get(by_custom.get(res.custom_id, ""))
            if item is None:
                continue
            raw = _tool_input(res.result.message) if res.result.type == "succeeded" else None
            done += int(_apply(item, raw, self.tax))
        return done
