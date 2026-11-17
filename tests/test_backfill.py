"""Newest-first channel sync: chunked results must match grouping the whole channel at once."""

import asyncio
import random

import pytest

from pipeline.backfill import sync_channel
from pipeline.grouping import Msg, group_messages, new_channel_state

CID = 42
T0 = 1_700_000_000.0


def make_channel(n_models: int, seed: int = 1) -> list[Msg]:
    """photo, archive (sometimes split into parts), occasional text posts."""
    rng = random.Random(seed)
    msgs: list[Msg] = []
    mid = 0
    t = T0

    def add(kind, **kw):
        nonlocal mid, t
        mid += 1
        t += rng.randint(60, 900)
        msgs.append(Msg(id=mid, date=t, kind=kind, **kw))

    for n in range(n_models):
        if rng.random() < 0.1:
            add("other", text="ad")
        add("photo", text=f"preview {n}")
        parts = rng.choice([1, 1, 1, 2])
        for p in range(1, parts + 1):
            name = f"model{n}.part{p}.rar" if parts > 1 else f"model{n}.rar"
            add("archive", file_name=name, size=10)
    return msgs


def fake_fetch(channel: list[Msg]):
    async def fetch(lo, hi, limit):
        rng = [m for m in channel if m.id > lo and (hi == 0 or m.id < hi)]
        rng.sort(key=lambda m: m.id, reverse=True)
        return rng[:limit], len(rng) <= limit

    return fetch


def reference(channel):
    items: dict = {}
    group_messages(CID, channel, new_channel_state(), items)
    return {i["id"]: (i["preview_message_id"], len(i["files"])) for i in items.values()}


def run_until_done(channel, limit, ch=None, states=None, items=None, max_runs=500):
    ch = ch if ch is not None else {"last_message_id": 0}
    states = states if states is not None else {}
    items = items if items is not None else {}
    for _ in range(max_runs):
        asyncio.run(sync_channel(CID, ch, states, items, fake_fetch(channel), limit))
        if not ch["gaps"] and ch["last_message_id"] == channel[-1].id:
            break
    return ch, states, items


def summary(items):
    return {i["id"]: (i["preview_message_id"], len(i["files"])) for i in items.values()}


@pytest.mark.parametrize("seed", [1, 2, 3])
@pytest.mark.parametrize("limit", [3, 7, 13, 50, 1000])
def test_chunked_newest_first_matches_reference(limit, seed):
    """Same items, previews and split-archive parts as reading the channel in one go."""
    channel = make_channel(120, seed)
    _, _, items = run_until_done(channel, limit)
    assert summary(items) == reference(channel)


def test_first_run_returns_newest_models():
    channel = make_channel(200)
    ch, states, items = {"last_message_id": 0}, {}, {}
    asyncio.run(sync_channel(CID, ch, states, items, fake_fetch(channel), 30))
    newest_ids = {m.id for m in channel[-30:]}
    assert items and all(min(i["message_ids"]) in newest_ids for i in items.values())
    assert ch["gaps"] and ch["last_message_id"] == channel[-1].id


def test_new_posts_between_backfill_runs():
    channel = make_channel(100)
    ch, states, items = {"last_message_id": 0}, {}, {}
    asyncio.run(sync_channel(CID, ch, states, items, fake_fetch(channel), 25))
    # New posts arrive while history is still being filled.
    more = make_channel(5, seed=9)
    last = channel[-1]
    for k, m in enumerate(more, start=1):
        channel.append(Msg(id=last.id + k, date=last.date + 60 * k, kind=m.kind, text=m.text,
                           file_name=m.file_name.replace("model", "new"), size=m.size))
    run_until_done(channel, 25, ch, states, items)
    assert summary(items) == reference(channel)


def test_existing_partial_channel_migrates():
    """A channel synced oldest-first up to some point continues correctly."""
    channel = make_channel(150)
    cut = channel[len(channel) // 3].id
    ch, states, items = {"last_message_id": cut}, {str(CID): new_channel_state()}, {}
    group_messages(CID, [m for m in channel if m.id <= cut], states[str(CID)], items)
    run_until_done(channel, 40, ch, states, items)
    assert summary(items) == reference(channel)


def test_orphan_gets_preview_when_older_chunk_arrives():
    # photo 1, archive 2 — read archive first (top chunk), photo later (gap chunk).
    channel = [Msg(1, T0, "photo", text="Nice chair"), Msg(2, T0 + 60, "archive",
                                                          file_name="chair.rar", size=1)]
    ch, states, items = {"last_message_id": 0}, {}, {}
    asyncio.run(sync_channel(CID, ch, states, items, fake_fetch(channel), 1))
    assert items[f"{CID}:2"]["preview_message_id"] is None
    items[f"{CID}:2"]["classification"] = {"category": "Chairs & Stools"}
    items[f"{CID}:2"]["taxonomy_version"] = 1
    asyncio.run(sync_channel(CID, ch, states, items, fake_fetch(channel), 1))
    it = items[f"{CID}:2"]
    assert it["preview_message_id"] == 1 and "Nice chair" in it["caption"]
    assert "taxonomy_version" not in it  # re-queued for classification
    assert ch["gaps"] == []
