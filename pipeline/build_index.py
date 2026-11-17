"""Build the slim, browser-facing library payload from the pipeline DB."""

from __future__ import annotations

from typing import Any

from .classify import fallback
from .config import CAPTION_MAX_CHARS, Taxonomy
from .grouping import deep_link

INDEX_FORMAT = 1


def build_library(db: dict[str, Any], tax: Taxonomy, active_channel_ids: set[int] | None = None
                  ) -> dict[str, Any]:
    channels = db.get("channels", {})
    out_items: list[dict[str, Any]] = []
    for item in db.get("items", {}).values():
        cid = item["channel_id"]
        if active_channel_ids is not None and cid not in active_channel_ids:
            continue
        ch = channels.get(str(cid), {})
        cls = item.get("classification") or fallback(item)
        link_id = item["message_ids"][0]
        out_items.append({
            "id": item["id"],
            "t": cls["title"],
            "g": cls["group"],
            "c": cls["category"],
            "s": cls["style"],
            "r": cls["render_engine"],
            "mv": cls.get("max_version"),
            "tg": cls.get("tags", []),
            "m": cls.get("materials", []),
            "co": cls.get("colors", []),
            "col": bool(cls.get("is_collection")),
            "p": item.get("classification") is not None,
            "f": [[f["name"], f["size"]] for f in item["files"]],
            "sz": sum(f["size"] for f in item["files"]),
            "cap": (item.get("caption") or "")[:CAPTION_MAX_CHARS],
            "d": int(item["posted_at"]),
            "ch": cid,
            "l": deep_link(cid, ch.get("username"), link_id),
            "th": item.get("thumb"),
        })
    out_items.sort(key=lambda i: (i["d"], i["id"]), reverse=True)
    used = {i["ch"] for i in out_items}
    return {
        "format": INDEX_FORMAT,
        "taxonomy": tax.as_dict(),
        "channels": [
            {"id": int(cid), "title": ch.get("title", "")}
            for cid, ch in sorted(channels.items(), key=lambda kv: kv[1].get("title", ""))
            if int(cid) in used
        ],
        "items": out_items,
    }
