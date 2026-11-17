"""Newest-first syncing of one channel: recent posts first, older history filled in later.

Per channel we keep:
  * ``last_message_id``: the newest message processed (the "head");
  * ``states[cid]``: grouping state at the head (pending photos, last item);
  * ``gaps``: ranges of history not read yet, each ``{"lo", "hi", "state"}`` meaning messages
    with lo < id < hi are missing, and ``state`` is the grouping state at ``lo`` (so the gap's
    oldest messages can still join photos/parts that were seen just below it).

Every run reads the head first (newest first, up to the limit). If the head range did not fit,
the unread part becomes a gap. Remaining budget fills gaps, newest gap first, again newest
first within it. Each chunk is grouped in ascending order; because chunks arrive top-down,
the photos left over at the top of a chunk are linked to orphan items just above it.
"""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .config import GROUP_MAX_MESSAGE_GAP, GROUP_MAX_SECONDS
from .grouping import Msg, _join_caption, group_messages, new_channel_state, parse_archive_name

# fetch(min_id, max_id, limit) -> (messages newest first, complete)
Fetch = Callable[[int, int, int], Awaitable[tuple[list[Msg], bool]]]


@dataclass
class ChannelSyncResult:
    messages: int = 0
    new_ids: list[str] = field(default_factory=list)
    updated_ids: list[str] = field(default_factory=list)
    linked_ids: list[str] = field(default_factory=list)


def link_orphans(cid: int, state: dict[str, Any], items: dict[str, dict[str, Any]],
                 top_id: int) -> list[str]:
    """Repair items just above a chunk boundary at ``top_id``.

    An item there that has no preview is either the next part of a split archive whose first
    part is the last item below the boundary (merge it in), or a model whose photo is just
    below the boundary (link the nearest unclaimed photo).
    """
    photos = [p for p in state.get("photos", []) if p["claimed_by"] is None]
    last = state.get("last_item")
    target = items.get(last["id"]) if last else None
    if not photos and target is None:
        return []
    orphans = sorted(
        (it for it in items.values()
         if it["channel_id"] == cid and it.get("preview_message_id") is None
         and top_id < min(it["message_ids"]) <= top_id + GROUP_MAX_MESSAGE_GAP),
        key=lambda it: min(it["message_ids"]),
    )
    linked = []
    for it in orphans:
        first = min(it["message_ids"])
        if target is not None and last is not None and _continues_parts(it, last, first):
            target["files"] = sorted(target["files"] + it["files"],
                                     key=lambda f: (f["part"] is None, f["part"] or 0,
                                                    f["msg_id"]))
            target["message_ids"] = sorted(target["message_ids"] + it["message_ids"])
            target["caption"] = _join_caption(target.get("caption", ""), it.get("caption", ""))
            last.update(last_msg_id=max(it["message_ids"]), date=it["posted_at"])
            del items[it["id"]]
            linked.append(target["id"])
            continue
        candidates = [p for p in photos
                      if p["claimed_by"] is None and p["id"] < first
                      and first - p["id"] <= GROUP_MAX_MESSAGE_GAP
                      and it["posted_at"] - p["date"] <= GROUP_MAX_SECONDS]
        if not candidates:
            continue
        photo = max(candidates, key=lambda p: p["id"])
        photo["claimed_by"] = it["id"]
        it["preview_message_id"] = photo["id"]
        it["caption"] = _join_caption(photo["text"], it.get("caption", ""))
        if it.get("classification") is not None:
            it.pop("taxonomy_version", None)  # classify again with the preview and caption
        linked.append(it["id"])
    return linked


def _continues_parts(item: dict[str, Any], last: dict[str, Any], first: int) -> bool:
    parsed = parse_archive_name(item["files"][0]["name"]) if item.get("files") else None
    return (parsed is not None and parsed.part is not None and parsed.base == last["base"]
            and first - last["last_msg_id"] <= GROUP_MAX_MESSAGE_GAP
            and item["posted_at"] - last["date"] <= GROUP_MAX_SECONDS)


def _group(cid: int, msgs: list[Msg], state: dict[str, Any], items: dict[str, dict[str, Any]],
           result: ChannelSyncResult) -> None:
    res = group_messages(cid, msgs, state, items)
    result.messages += len(msgs)
    result.new_ids += res.new_ids
    result.updated_ids += [i for i in res.updated_ids if i not in result.updated_ids]
    if msgs:
        result.linked_ids += link_orphans(cid, state, items, max(m.id for m in msgs))


async def sync_channel(cid: int, ch: dict[str, Any], states: dict[str, Any],
                       items: dict[str, dict[str, Any]], fetch: Fetch, limit: int
                       ) -> ChannelSyncResult:
    """Read up to ``limit`` messages for one channel: head first, then history gaps."""
    result = ChannelSyncResult()
    key = str(cid)
    head = int(ch.get("last_message_id", 0))
    gaps: list[dict[str, Any]] = ch.setdefault("gaps", [])
    head_state = states.setdefault(key, new_channel_state())
    budget = limit

    # 1. Head: everything newer than what we have, newest first.
    msgs, complete = await fetch(head, 0, budget)
    budget -= len(msgs)
    if msgs:
        newest = max(m.id for m in msgs)
        if complete:
            _group(cid, msgs, head_state, items, result)  # contiguous with the old head
        else:
            oldest = min(m.id for m in msgs)
            if oldest - head > 1:
                gaps.append({"lo": head, "hi": oldest, "state": copy.deepcopy(head_state)})
            head_state = new_channel_state()
            states[key] = head_state
            _group(cid, msgs, head_state, items, result)
        ch["last_message_id"] = newest

    # 2. History gaps, newest gap first, newest messages first inside each gap.
    for gap in sorted(gaps, key=lambda g: g["hi"], reverse=True):
        if budget <= 0:
            break
        msgs, complete = await fetch(gap["lo"], gap["hi"], budget)
        budget -= len(msgs)
        if complete:
            _group(cid, msgs, gap["state"], items, result)  # reaches lo: use the state there
            if not msgs:
                # Nothing left in the range: photos at lo may still pair with items above it.
                result.linked_ids += link_orphans(cid, gap["state"], items, gap["lo"])
            gaps.remove(gap)
        elif msgs:
            _group(cid, msgs, new_channel_state(), items, result)
            gap["hi"] = min(m.id for m in msgs)
    return result
