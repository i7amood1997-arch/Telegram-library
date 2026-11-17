"""Thin Telethon wrapper: resolve channels, fetch new messages, download preview photos."""

from __future__ import annotations

import asyncio
import logging
import time
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


async def download_photo(client: TelegramClient, entity: Any, msg_id: int,
                         cache: dict[int, Any]) -> bytes | None:
    message = cache.get(msg_id)
    if message is None:
        message = await client.get_messages(entity, ids=msg_id)
    if message is None or message.photo is None:
        return None
    data = await client.download_media(message, file=bytes)
    return data if isinstance(data, bytes) else None
