"""Low-cost Claude classification: several items per request, compact coded answers.

Compared with one request per item (long instructions + full JSON each time), grouping
GROUP_SIZE items shares the instructions and taxonomy across the group, and the answer uses
numeric codes for category/style with a short title and up to 5 tags. Materials and colors are
skipped. Render engine and 3ds Max version still come from the free regex hints.
"""

from __future__ import annotations

import base64
import logging
import re
import time
from pathlib import Path
from typing import Any

from .classify import (
    MAX_CLASSIFY_ATTEMPTS,
    _clean_list,
    extract_hints,
    fallback,
    item_text,
)
from .config import AI_IMAGE_EDGE, Taxonomy
from .thumbnails import ai_image

log = logging.getLogger("pipeline.lite")

LITE_PROMPT_VERSION = 3
GROUP_SIZE = 5  # fewer items per request = more attention per item
CAPTION_CHARS = 280
TOOL = "record_items"
BATCH_MAX_ITEMS = 4000
# Category list of taxonomy v1, for batches submitted before categories were stored with them.
LEGACY_CATS_V1 = [
    "Sofas & Armchairs", "Chairs & Stools", "Tables", "Beds", "Wardrobes & Storage", "Kitchens",
    "Bathrooms & Sanitary", "Lighting", "Decor & Accessories", "Rugs & Curtains", "Indoor Plants",
    "Appliances & Electronics", "Doors & Windows", "Wall & Ceiling Elements", "Trees & Vegetation",
    "Vehicles", "Outdoor Furniture", "Buildings & Facades", "Street Elements",
    "Landscape & Hardscape", "People", "Interior Scene", "Exterior Scene", "Materials & Textures",
    "HDRI", "Plugins & Add-ons", "3D Software", "Courses & Tutorials",
]


def system_prompt(tax: Taxonomy) -> str:
    cats = "\n".join(f"{i}: {c}" for i, c in enumerate(tax.all_categories))
    styles = ", ".join(f"{i}={s}" for i, s in enumerate(tax.styles))
    return (
        "You catalogue 3ds Max models and resources (materials, HDRI, plugins, software, courses) "
        "for an architectural visualization artist. Each numbered item has a preview image "
        "(when available), file names and the post caption (any language). For EVERY item call "
        f"{TOOL} once with: i (item number), c (category code), s (style code), t (English title, "
        "2-5 words, Title Case, what the preview shows; no file extensions or channel names), "
        "g (3-5 lowercase English search tags).\n"
        "Decide from the image, names and caption together, not the file extension.\n"
        "Rules for the category:\n"
        "- Pick the ONE main object being sold. A sofa shown with a rug and a table is a sofa; "
        "a set of several different furniture pieces is the category of the largest piece.\n"
        "- Interior Scene / Exterior Scene only for a complete room or a complete building "
        "view sold as a whole scene, not for a single object photographed in a room.\n"
        "- Sofas = sofas, couches, sectionals, daybeds; Armchairs = armchairs, lounge chairs, "
        "recliners, poufs and ottomans; a sofa sold together with armchairs is Sofas.\n"
        "- Kitchens = full kitchen sets; Bathrooms & Sanitary = tubs, sinks, toilets, faucets, "
        "bathroom furniture; Wardrobes & Storage = cabinets, shelves, dressers, TV stands; "
        "Decor & Accessories = vases, books, mirrors, frames, sculptures, clocks, tableware, "
        "decor sets; Wall & Ceiling Elements = panels, mouldings, fireplaces, stairs, columns.\n"
        "- Resources (materials, textures, HDRI, plugins, software, courses) only when the post "
        "sells that resource rather than a 3D model; texture/material packs are Materials & "
        "Textures even if packed as zip/rar.\n"
        "- Look at the image first; captions may be in Russian, Chinese or other languages "
        "(e.g. диван=sofa, стол=table, кресло=armchair, люстра=chandelier, шкаф=wardrobe).\n"
        f"Categories:\n{cats}\nStyles: {styles}"
    )


def tool_schema(tax: Taxonomy) -> dict[str, Any]:
    return {
        "name": TOOL,
        "description": "Record the classification of every item in the message.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "i": {"type": "integer"},
                            "c": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": len(tax.all_categories) - 1,
                            },
                            "s": {"type": "integer", "minimum": 0, "maximum": len(tax.styles) - 1},
                            "t": {"type": "string"},
                            "g": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["i", "c", "s", "t"],
                    },
                },
            },
            "required": ["items"],
        },
    }


def build_group_request(
    items: list[dict[str, Any]], thumbs_dir: Path, tax: Taxonomy, model: str
) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    for n, it in enumerate(items):
        thumb = thumbs_dir / it["thumb"] if it.get("thumb") else None
        if thumb is not None and thumb.exists():
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/webp",
                        "data": base64.b64encode(ai_image(thumb, AI_IMAGE_EDGE)).decode("ascii"),
                    },
                }
            )
        names = ", ".join(f["name"] for f in it["files"][:3])
        caption = re.sub(r"\s+", " ", it.get("caption") or "").strip()[:CAPTION_CHARS] or "-"
        content.append(
            {
                "type": "text",
                "text": f"Item {n}{'' if thumb else ' (no image)'}: "
                f"files: {names}; caption: {caption}",
            }
        )
    return {
        "model": model,
        "max_tokens": 4096,  # room for thinking; only used tokens are billed
        "system": system_prompt(tax),
        "messages": [{"role": "user", "content": content}],
        "tools": [tool_schema(tax)],
        "tool_choice": {"type": "tool", "name": TOOL},
    }


def _entries(message: Any) -> list[dict[str, Any]]:
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and block.name == TOOL:
            data = dict(block.input)
            return [e for e in data.get("items", []) if isinstance(e, dict)]
    return []


def apply_entry(item: dict[str, Any], entry: dict[str, Any] | None, tax: Taxonomy,
                cats: list[str] | None = None) -> bool:
    """Store a compact answer on the item; on failure count an attempt (fallback after 3).

    `cats` is the category list the request was built with (codes index into it)."""
    try:
        if entry is None:
            raise ValueError("missing")
        cats = cats or tax.all_categories
        styles = tax.styles
        category = cats[int(entry["c"])]
        style = styles[int(entry["s"])] if 0 <= int(entry.get("s", -1)) < len(styles) else "Other"
        title = re.sub(r"\s+", " ", str(entry.get("t") or "")).strip()[:80]
        if not title:
            raise ValueError("no title")
        hints = extract_hints(item_text(item))
        item["classification"] = {
            "title": title,
            "group": tax.group_of(category) or "Uncategorized",
            "category": category,
            "style": style,
            "render_engine": hints.get("render_engine", "Unknown"),
            "max_version": hints.get("max_version"),
            "materials": [],
            "colors": [],
            "tags": _clean_list([str(t) for t in entry.get("g", [])], 5),
            "is_collection": False,
            "confidence": 0.7,
            "source": "ai-lite",
        }
        item["taxonomy_version"] = tax.version
        item["prompt_version"] = f"lite-{LITE_PROMPT_VERSION}"
        item["cls_img"] = bool(item.get("thumb"))
        item.pop("classify_attempts", None)
        return True
    except (KeyError, ValueError, TypeError, IndexError):
        item["classify_attempts"] = item.get("classify_attempts", 0) + 1
        if item["classify_attempts"] >= MAX_CLASSIFY_ATTEMPTS:
            item["classification"] = fallback(item)
            item["taxonomy_version"] = tax.version
        return False


def _apply_group(group: list[dict[str, Any]], entries: list[dict[str, Any]], tax: Taxonomy,
                 cats: list[str] | None = None) -> int:
    by_i = {}
    for e in entries:
        try:
            by_i[int(e.get("i", -1))] = e
        except (TypeError, ValueError):
            continue
    return sum(int(apply_entry(it, by_i.get(n), tax, cats)) for n, it in enumerate(group))


MAX_API_ERRORS = 3


def api_error_text(exc: Exception) -> str:
    """Status and the API's own error message (it never contains our content), truncated."""
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    msg = ""
    if isinstance(body, dict):
        err = body.get("error")
        msg = str(err.get("message", "")) if isinstance(err, dict) else ""
    return f"{type(exc).__name__} status={status} {msg[:200]}".strip()


class LiteClassifier:
    def __init__(self, client: Any, tax: Taxonomy, model: str, thumbs_dir: Path) -> None:
        self.client = client
        self.tax = tax
        self.model = model
        self.thumbs_dir = thumbs_dir

    def _groups(self, items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        return [items[i : i + GROUP_SIZE] for i in range(0, len(items), GROUP_SIZE)]

    def classify_now(self, items: list[dict[str, Any]], deadline: float, workers: int = 8) -> int:
        """Classify right away (a few hundred items per run), several requests in parallel."""
        import threading
        from concurrent.futures import ThreadPoolExecutor

        lock = threading.Lock()
        state = {"done": 0, "errors": 0}

        def one(group: list[dict[str, Any]]) -> None:
            if time.time() > deadline or state["errors"] >= MAX_API_ERRORS:
                return
            try:
                msg = self.client.messages.create(
                    **build_group_request(group, self.thumbs_dir, self.tax, self.model)
                )
                entries = _entries(msg)
                with lock:
                    state["done"] += _apply_group(group, entries, self.tax)
                    state["errors"] = 0
            except Exception as exc:
                # An API failure (billing, bad request, overload) is not the item's fault:
                # do not count an attempt, so items are not given up as Uncategorized.
                with lock:
                    state["errors"] += 1
                    n = state["errors"]
                log.warning("lite classify error: %s", api_error_text(exc))
                if n == MAX_API_ERRORS:
                    log.warning("stopping AI classification for this run after %d API errors", n)

        groups = self._groups(items)
        if workers <= 1:
            for g in groups:
                one(g)
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(one, groups))
        return state["done"]

    def submit_batch(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        items = items[:BATCH_MAX_ITEMS]
        groups = {f"g{n}": [it["id"] for it in g] for n, g in enumerate(self._groups(items))}
        by_id = {it["id"]: it for it in items}
        requests = [
            {
                "custom_id": cid,
                "params": build_group_request(
                    [by_id[i] for i in ids], self.thumbs_dir, self.tax, self.model
                ),
            }
            for cid, ids in groups.items()
        ]
        batch = self.client.messages.batches.create(requests=requests)
        return {
            "id": batch.id,
            "kind": "lite",
            "cats": list(self.tax.all_categories),
            "groups": groups,
            "item_ids": [it["id"] for it in items],
            "submitted_at": time.time(),
        }

    def collect_batch(self, record: dict[str, Any], items: dict[str, dict[str, Any]]) -> int | None:
        batch = self.client.messages.batches.retrieve(record["id"])
        if batch.processing_status != "ended":
            return None
        done = 0
        seen = set()
        for res in self.client.messages.batches.results(record["id"]):
            ids = record["groups"].get(res.custom_id)
            if not ids:
                continue
            seen.add(res.custom_id)
            group = [items[i] for i in ids if i in items]
            entries = _entries(res.result.message) if res.result.type == "succeeded" else []
            done += _apply_group(group, entries, self.tax, record.get("cats") or LEGACY_CATS_V1)
        return done
