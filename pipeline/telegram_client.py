"""Thin Telethon wrapper: resolve channels, fetch new messages, download preview photos."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession

from .grouping import Msg, is_archive

log = logging.getLogger("pipeline.telegram")

MAX_FLOOD_WAIT = 300


def make_client(api_id: int, api_hash: str, session: str) -> TelegramClient:
    client = TelegramClient(StringSession(session), api_id, api_hash)
    client.flood_sleep_threshold = 120  # Telethon sleeps automatically for waits up to this
    return client


def normalize(message: Any) -> Msg:
    date = message.date.timestamp() if message.date else 0.0
    text = message.message or ""
    gid = message.grouped_id
    if message.photo is not None:
        return Msg(id=message.id, date=date, kind="photo", grouped_id=gid, text=text)
    if message.document is not None and message.file is not None:
        name = message.file.name or ""
        if name and is_archive(name):
            return Msg(id=message.id, date=date, kind="archive", grouped_id=gid, text=text,
                       file_name=name, size=int(message.file.size or 0))
    return Msg(id=message.id, date=date, kind="other", grouped_id=gid, text=text)


class ChannelResolver:
    """Resolves usernames directly and numeric IDs via the account's dialog list."""

    def __init__(self, client: TelegramClient) -> None:
        self.client = client
        self._dialogs: dict[int, Any] | None = None

    async def resolve(self, ref: str) -> Any:
        numeric = ref.lstrip("-").isdigit()
        if not numeric:
            return await self.client.get_entity(ref)
        if self._dialogs is None:
            self._dialogs = {}
            async for d in self.client.iter_dialogs():
                if d.is_channel:
                    self._dialogs[d.entity.id] = d.entity
        cid = int(ref.lstrip("-"))
        if ref.startswith("-100"):
            cid = int(ref[4:])
        if cid not in self._dialogs:
            raise LookupError("channel not found in this account's dialogs")
        return self._dialogs[cid]


async def fetch_new(
    client: TelegramClient, entity: Any, min_id: int, deadline: float, limit: int | None = None
) -> tuple[list[Msg], dict[int, Any]]:
    """Messages with id > min_id in ascending order, plus raw photo messages by id."""
    msgs: list[Msg] = []
    photos: dict[int, Any] = {}
    try:
        async for m in client.iter_messages(entity, min_id=min_id, reverse=True, limit=limit,
                                            wait_time=0.5):
            if time.time() > deadline:
                break
            norm = normalize(m)
            msgs.append(norm)
            if norm.kind == "photo":
                photos[m.id] = m
    except FloodWaitError as exc:
        log.warning("flood wait %ss; stopping this channel for now", exc.seconds)
        if exc.seconds <= MAX_FLOOD_WAIT:
            await asyncio.sleep(exc.seconds)
    return msgs, photos


DOWNLOAD_CONCURRENCY = 6
PREFETCH_CHUNK = 100
THUMB_MIN_EDGE = 480


def best_photo_size(photo: Any) -> Any | None:
    """Smallest stored size that is still >= THUMB_MIN_EDGE (avoids downloading originals)."""
    sizes = [s for s in getattr(photo, "sizes", []) or []
             if getattr(s, "w", None) and getattr(s, "h", None)]
    big = [s for s in sizes if max(s.w, s.h) >= THUMB_MIN_EDGE]
    if big:
        return min(big, key=lambda s: s.w * s.h)
    return max(sizes, key=lambda s: s.w * s.h, default=None)


async def _prefetch(client: TelegramClient, entities: dict[int, Any],
                    items: list[dict[str, Any]], cache: dict[tuple[int, int], Any]) -> None:
    """Load preview messages not seen in this run, 100 ids per request."""
    missing: dict[int, list[int]] = {}
    for it in items:
        key = (it["channel_id"], it["preview_message_id"])
        if key not in cache:
            missing.setdefault(key[0], []).append(key[1])
    for cid, ids in missing.items():
        msgs = await client.get_messages(entities[cid], ids=ids)
        for mid, m in zip(ids, msgs, strict=False):
            cache[(cid, mid)] = m  # None when the message was deleted


async def download_photos(
    client: TelegramClient,
    entities: dict[int, Any],
    items: list[dict[str, Any]],
    cache: dict[tuple[int, int], Any],
    deadline: float,
    on_result: Callable[[dict[str, Any], bytes | None, str | None], None],
) -> None:
    """Download preview photos concurrently until the deadline.

    on_result(item, data, error): data=None and error=None means "no photo available".
    """
    sem = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)

    async def one(item: dict[str, Any]) -> None:
        async with sem:
            if time.time() > deadline:
                return
            msg = cache.get((item["channel_id"], item["preview_message_id"]))
            if msg is None or getattr(msg, "photo", None) is None:
                on_result(item, None, None)
                return
            try:
                data = await client.download_media(msg, file=bytes,
                                                   thumb=best_photo_size(msg.photo))
                on_result(item, data if isinstance(data, bytes) and data else None,
                          None if data else "empty")
            except FloodWaitError as exc:
                log.warning("flood wait %ss during downloads", exc.seconds)
                if exc.seconds <= MAX_FLOOD_WAIT:
                    await asyncio.sleep(exc.seconds)
                on_result(item, None, "flood")
            except Exception as exc:
                log.warning("download failed (%s)", type(exc).__name__)
                on_result(item, None, type(exc).__name__)

    for start in range(0, len(items), PREFETCH_CHUNK):
        if time.time() > deadline:
            break
        chunk = items[start:start + PREFETCH_CHUNK]
        try:
            await _prefetch(client, entities, chunk, cache)
        except Exception as exc:
            log.warning("prefetch failed (%s)", type(exc).__name__)
            continue
        await asyncio.gather(*(one(it) for it in chunk))
