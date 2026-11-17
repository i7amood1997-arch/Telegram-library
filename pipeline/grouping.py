"""Group Telegram posts (preview photos + archive files) into model items.

Pure logic: no network or disk access, so it can be tested exhaustively.

Rules (in priority order):
  1. Messages sharing a Telegram album (grouped_id) belong together.
  2. Parts of a multi-part archive (.part1.rar, .z01/.zip, .7z.001, "name (2).rar") and
     consecutive archives with the same or a very similar base name merge into one item.
  3. Otherwise an archive attaches to the nearest preceding photo within the window. If that
     photo is already claimed, the new item shares it as its preview.
  4. An archive with no photo in the window becomes an item without a preview.
Photos and the last item are kept in per-channel state, so posts split across runs still
group correctly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Literal

from .config import GROUP_MAX_MESSAGE_GAP, GROUP_MAX_SECONDS, NAME_SIMILARITY

Kind = Literal["photo", "archive", "other"]

ARCHIVE_EXTS = {"zip", "rar", "7z", "max"}

# (regex, ext) pairs; group "base" is the set name, group "part" is the part number.
_PART_PATTERNS: list[tuple[re.Pattern[str], str | None]] = [
    (re.compile(r"^(?P<base>.+?)\.part0*(?P<part>\d+)\.(?P<ext>rar|zip|7z)$", re.I), None),
    (re.compile(r"^(?P<base>.+?)\.(?P<ext>zip|rar|7z)\.0*(?P<part>\d+)$", re.I), None),
    (re.compile(r"^(?P<base>.+?)\.z(?P<part>\d{2})$", re.I), "zip"),
    (re.compile(r"^(?P<base>.+?)\.r(?P<part>\d{2})$", re.I), "rar"),
    (re.compile(r"^(?P<base>.+?)[\s_\-]*part[\s_\-]*0*(?P<part>\d+)\.(?P<ext>rar|zip|7z)$", re.I),
     None),
    (re.compile(r"^(?P<base>.+?)\s*\((?P<part>\d+)\)\.(?P<ext>rar|zip|7z)$", re.I), None),
]
_PLAIN = re.compile(r"^(?P<base>.+)\.(?P<ext>zip|rar|7z|max)$", re.I)


@dataclass(frozen=True)
class ArchiveName:
    base: str  # normalized set name used for matching
    ext: str
    part: int | None


def normalize_base(name: str) -> str:
    name = re.sub(r"[_\-.\s]+", " ", name.lower())
    return re.sub(r"\s+", " ", name).strip()


def parse_archive_name(file_name: str) -> ArchiveName | None:
    name = file_name.strip()
    for pattern, fixed_ext in _PART_PATTERNS:
        m = pattern.match(name)
        if m:
            ext = fixed_ext or m.group("ext").lower()
            return ArchiveName(normalize_base(m.group("base")), ext, int(m.group("part")))
    m = _PLAIN.match(name)
    if m:
        return ArchiveName(normalize_base(m.group("base")), m.group("ext").lower(), None)
    return None


def is_archive(file_name: str) -> bool:
    parsed = parse_archive_name(file_name)
    return parsed is not None and parsed.ext in ARCHIVE_EXTS


@dataclass
class Msg:
    """A normalized Telegram message (independent of Telethon)."""

    id: int
    date: float  # unix seconds
    kind: Kind
    grouped_id: int | None = None
    text: str = ""
    file_name: str = ""
    size: int = 0


def new_channel_state() -> dict[str, Any]:
    return {"photos": [], "last_item": None}


def _within(newer: Msg, older_id: int, older_date: float) -> bool:
    return (newer.id - older_id) <= GROUP_MAX_MESSAGE_GAP and (
        newer.date - older_date
    ) <= GROUP_MAX_SECONDS


def _similar(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return a == b or SequenceMatcher(None, a, b).ratio() >= NAME_SIMILARITY


def _join_caption(*parts: str) -> str:
    seen: list[str] = []
    for p in parts:
        p = (p or "").strip()
        if p and p not in seen:
            seen.append(p)
    return "\n\n".join(seen)


def _file_record(msg: Msg, parsed: ArchiveName) -> dict[str, Any]:
    return {"name": msg.file_name, "size": msg.size, "ext": parsed.ext, "part": parsed.part,
            "msg_id": msg.id}


@dataclass
class GroupResult:
    new_ids: list[str]
    updated_ids: list[str]


def group_messages(
    channel_id: int,
    messages: list[Msg],
    state: dict[str, Any],
    items: dict[str, dict[str, Any]],
) -> GroupResult:
    """Process messages (any order; sorted ascending here) for one channel.

    Mutates `state` (per-channel grouping state) and `items` (all items by id).
    """
    result = GroupResult([], [])
    photos: list[dict[str, Any]] = state.setdefault("photos", [])

    for msg in sorted(messages, key=lambda m: m.id):
        if msg.kind == "photo":
            photos.append({"id": msg.id, "date": msg.date, "grouped_id": msg.grouped_id,
                           "text": msg.text, "claimed_by": None})
            continue
        if msg.kind != "archive":
            continue
        parsed = parse_archive_name(msg.file_name)
        if parsed is None:
            continue

        # Nearest preceding photo within the window (album members first).
        candidates = [p for p in photos if p["id"] < msg.id and _within(msg, p["id"], p["date"])]
        photo = None
        if msg.grouped_id is not None:
            photo = next((p for p in reversed(candidates) if p["grouped_id"] == msg.grouped_id),
                         None)
        if photo is None and candidates:
            photo = candidates[-1]

        last = state.get("last_item")
        target = items.get(last["id"]) if last else None
        if target is not None and _within(msg, last["last_msg_id"], last["date"]):
            same_album = msg.grouped_id is not None and msg.grouped_id == last.get("grouped_id")
            same_set = parsed.base == last["base"]
            same_preview = (photo["id"] if photo else None) == target.get("preview_message_id")
            continues_parts = same_set and parsed.part is not None
            similar = photo is not None and _similar(parsed.base, last["base"])
            if same_album or continues_parts or (same_preview and (same_set or similar)):
                target["files"].append(_file_record(msg, parsed))
                target["files"].sort(key=lambda f: (f["part"] is None, f["part"] or 0, f["msg_id"]))
                target["message_ids"].append(msg.id)
                target["caption"] = _join_caption(target["caption"], msg.text)
                last.update(last_msg_id=msg.id, date=msg.date)
                if target["id"] not in result.new_ids and target["id"] not in result.updated_ids:
                    result.updated_ids.append(target["id"])
                continue

        item_id = f"{channel_id}:{msg.id}"
        preview_text = ""
        if photo is not None:
            if photo["claimed_by"] is None:
                photo["claimed_by"] = item_id
            preview_text = photo["text"]
        items[item_id] = {
            "id": item_id,
            "channel_id": channel_id,
            "message_ids": [msg.id],
            "preview_message_id": photo["id"] if photo else None,
            "files": [_file_record(msg, parsed)],
            "caption": _join_caption(preview_text, msg.text),
            "posted_at": msg.date,
        }
        state["last_item"] = {"id": item_id, "base": parsed.base, "grouped_id": msg.grouped_id,
                              "last_msg_id": msg.id, "date": msg.date}
        result.new_ids.append(item_id)

    # Trim photos that can no longer be matched.
    if messages:
        newest = max(m.id for m in messages)
        state["photos"] = [p for p in photos if newest - p["id"] <= GROUP_MAX_MESSAGE_GAP][-30:]
    return result


def deep_link(channel_id: int, username: str | None, message_id: int) -> str:
    if username:
        return f"https://t.me/{username}/{message_id}"
    return f"https://t.me/c/{channel_id}/{message_id}"
