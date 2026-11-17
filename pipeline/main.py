"""Command-line entry point.

    python -m pipeline.main sync        # fetch new posts, thumbnails, classify, publish
    python -m pipeline.main reclassify  # re-run classification for every item (within caps)
    python -m pipeline.main rebuild     # only rebuild library.enc from db.enc

Logs contain only counts and durations: never titles, captions, file names or channels.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from .classify import Classifier, needs_classification
from .config import Settings, Taxonomy, load_taxonomy
from .grouping import group_messages, new_channel_state
from .store import Store, StoreError
from .thumbnails import save_thumb

log = logging.getLogger("pipeline")

MAX_THUMB_ATTEMPTS = 5
FETCH_SHARE = 0.4  # share of the time budget for fetching messages
MAX_MESSAGES_PER_CHANNEL = 5000  # per run, so a huge backlog cannot starve other channels
CLASSIFY_RESERVE_S = 90  # keep time at the end for classification + saving


def setup_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    for noisy in ("telethon", "httpx", "httpcore", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.ERROR)


async def ingest(settings: Settings, store: Store, deadline: float, stats: dict[str, int]
                 ) -> None:
    """Fetch new posts for every channel, then download missing thumbnails (newest first).

    Time is split so one huge channel cannot starve the others: fetching gets at most
    FETCH_SHARE of the budget (divided fairly across channels), thumbnails get the rest.
    """
    from .telegram_client import ChannelResolver, download_photos, fetch_new, make_client

    db = store.db
    migrations = db.setdefault("migrations", [])
    if "thumb_attempts_reset_v1" not in migrations:
        # Earlier versions counted Telegram rate limits as failed attempts and gave up on
        # thumbnails too early. Give every item without a thumbnail a fresh start.
        for it in db["items"].values():
            if not it.get("thumb"):
                it.pop("thumb_attempts", None)
        migrations.append("thumb_attempts_reset_v1")

    now = time.time()
    fetch_deadline = now + (deadline - now) * FETCH_SHARE
    entities: dict[int, Any] = {}
    photo_cache: dict[tuple[int, int], Any] = {}
    async with make_client(settings.api_id, settings.api_hash, settings.session) as client:
        resolver = ChannelResolver(client)
        for idx, ref in enumerate(settings.channels):
            try:
                entity = await resolver.resolve(ref)
            except Exception as exc:
                log.warning("channel #%d could not be resolved (%s)", idx + 1, type(exc).__name__)
                stats["channel_errors"] += 1
                continue
            cid = int(entity.id)
            entities[cid] = entity
            ch = db["channels"].setdefault(str(cid), {"id": cid, "last_message_id": 0})
            ch["ref"] = ref
            ch["title"] = getattr(entity, "title", "") or ""
            ch["username"] = getattr(entity, "username", None)

            remaining = len(settings.channels) - idx
            share_deadline = time.time() + max(0.0, fetch_deadline - time.time()) / remaining
            if time.time() > fetch_deadline:
                continue
            msgs, photos = await fetch_new(client, entity, ch["last_message_id"], share_deadline,
                                           limit=MAX_MESSAGES_PER_CHANNEL)
            photo_cache.update({(cid, mid): m for mid, m in photos.items()})
            state = db["states"].setdefault(str(cid), new_channel_state())
            result = group_messages(cid, msgs, state, db["items"])
            if msgs:
                ch["last_message_id"] = max(m.id for m in msgs)
            stats["messages"] += len(msgs)
            stats["new_items"] += len(result.new_ids)
            stats["updated_items"] += len(result.updated_ids)

        # Thumbnails: all channels together, newest models first, downloaded concurrently.
        todo = [it for it in db["items"].values()
                if it["channel_id"] in entities and it.get("preview_message_id")
                and not it.get("thumb") and it.get("thumb_attempts", 0) < MAX_THUMB_ATTEMPTS]
        todo.sort(key=lambda it: it["posted_at"], reverse=True)
        stats["thumbs_pending"] = len(todo)

        def on_result(item: dict[str, Any], data: bytes | None, status: str) -> None:
            if status == "missing":  # preview deleted or not a photo: stop trying
                item["thumb_attempts"] = MAX_THUMB_ATTEMPTS
                stats["thumbs_missing"] += 1
                return
            if status == "ok" and data is not None:
                try:
                    item["thumb"] = save_thumb(store.thumbs_dir, settings.thumb_secret,
                                               item["id"], data)
                except Exception as exc:  # undecodable image
                    status = type(exc).__name__
                else:
                    item.pop("thumb_attempts", None)
                    stats["thumbs"] += 1
                    if item.get("classification") is not None and not item.get("cls_img"):
                        item.pop("taxonomy_version", None)  # classify again, now with the image
                    return
            item["thumb_attempts"] = item.get("thumb_attempts", 0) + 1
            stats["thumb_errors"] += 1
            stats[f"thumb_err_{status}"] += 1

        limited = await download_photos(client, entities, todo, photo_cache,
                                        deadline - CLASSIFY_RESERVE_S, on_result)
        stats["thumbs_rate_limited"] = str(limited).lower()


def classify(settings: Settings, store: Store, tax: Taxonomy, deadline: float,
             stats: dict[str, int]) -> None:
    if not settings.anthropic_key:
        log.info("ANTHROPIC_API_KEY not set; skipping classification")
        return
    import anthropic

    db = store.db
    client = anthropic.Anthropic(api_key=settings.anthropic_key, max_retries=3)

    def channel_title(item: dict[str, Any]) -> str:
        return db["channels"].get(str(item["channel_id"]), {}).get("title", "")

    clf = Classifier(client, tax, settings.classifier_model, store.thumbs_dir, channel_title)

    # 1. Collect finished batches.
    still_running = []
    for record in db["batches"]:
        try:
            done = clf.collect_batch(record, db["items"])
        except Exception as exc:
            log.warning("batch check failed (%s)", type(exc).__name__)
            done = None
            if time.time() - record["submitted_at"] > 3 * 86400:
                done = 0  # give up; items get retried
        if done is None:
            still_running.append(record)
        else:
            stats["classified"] += done
    db["batches"] = still_running

    in_batch = {i for b in db["batches"] for i in b["item_ids"]}
    pending = [it for it in db["items"].values()
               if it["id"] not in in_batch and needs_classification(it, tax)]
    # Wait for thumbnails that are still expected, so the image can be used.
    pending = [it for it in pending
               if it.get("thumb") or not it.get("preview_message_id")
               or it.get("thumb_attempts", 0) >= MAX_THUMB_ATTEMPTS]
    pending.sort(key=lambda it: it["posted_at"], reverse=True)
    stats["classify_pending"] = len(pending)
    if not pending:
        return

    if len(pending) >= settings.batch_threshold:
        try:
            record = clf.submit_batch(pending)
            db["batches"].append(record)
            stats["batched"] += len(record["item_ids"])
            return
        except Exception as exc:
            log.warning("batch submit failed (%s); falling back to direct calls",
                        type(exc).__name__)
    stats["classified"] += clf.classify_now(pending[: settings.max_classifications], deadline)


def channel_report(store: Store, settings: Settings) -> list[str]:
    """Per-channel counts, labelled by position in TG_CHANNELS only (never by name)."""
    by_ref = {ch.get("ref"): int(cid) for cid, ch in store.db["channels"].items()}
    lines = []
    for idx, ref in enumerate(settings.channels, start=1):
        cid = by_ref.get(ref)
        items = [it for it in store.db["items"].values() if it["channel_id"] == cid]
        gave_up = sum(1 for i in items
                      if not i.get("thumb") and i.get("thumb_attempts", 0) >= MAX_THUMB_ATTEMPTS)
        classified = sum(1 for i in items if (i.get("classification") or {}).get("category")
                         not in (None, "Uncategorized"))
        lines.append(
            f"channel#{idx} items={len(items)}"
            f" with_preview={sum(1 for i in items if i.get('preview_message_id'))}"
            f" thumbs={sum(1 for i in items if i.get('thumb'))}"
            f" thumbs_gave_up={gave_up} classified={classified}"
        )
    return lines


def write_outputs(stats: dict[str, Any], channel_lines: list[str] | None = None) -> None:
    for line in channel_lines or []:
        log.info("%s", line)
    log.info("summary %s", " ".join(f"{k}={v}" for k, v in stats.items()))
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as fh:
            fh.write("### Sync summary\n\n| key | value |\n|---|---|\n")
            fh.writelines(f"| {k} | {v} |\n" for k, v in stats.items())
            if channel_lines:
                fh.write("\n```\n" + "\n".join(channel_lines) + "\n```\n")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            for k, v in stats.items():
                fh.write(f"{k}={v}\n")


def run(mode: str, data_dir: Path) -> int:
    from collections import defaultdict

    from .build_index import build_library

    setup_logging()
    started = time.time()
    settings = Settings.from_env()
    tax = load_taxonomy()
    need_tg = mode == "sync"
    missing = settings.missing(telegram=need_tg)
    if missing:
        log.error("missing configuration: %s", ", ".join(missing))
        return 2

    store = Store(data_dir, settings.site_password, settings.site_password_old)
    try:
        store.load()
    except StoreError as exc:
        log.error("%s", exc)
        return 3

    stats: dict[str, Any] = defaultdict(int)
    deadline = started + settings.time_budget_s

    if mode == "reclassify":
        for it in store.db["items"].values():
            it.pop("taxonomy_version", None)
            it.pop("classify_attempts", None)
    if mode == "sync":
        asyncio.run(ingest(settings, store, deadline, stats))
    if mode in ("sync", "reclassify"):
        classify(settings, store, tax, deadline, stats)

    # Only show channels that are still configured (a channel removed from TG_CHANNELS
    # disappears from the site; its data stays in db.enc in case it is added back).
    active = {int(cid) for cid, ch in store.db["channels"].items()
              if ch.get("ref") in settings.channels} if settings.channels else None
    library = build_library(store.db, tax, active)
    wrote = store.save(library, now=time.time())
    stats["items_total"] = len(library["items"])
    stats["changed"] = str(wrote["db"] or wrote["library"]).lower()
    stats["duration_s"] = int(time.time() - started)
    write_outputs(dict(stats), channel_report(store, settings) if settings.channels else None)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline")
    parser.add_argument("mode", choices=["sync", "reclassify", "rebuild"], nargs="?",
                        default="sync")
    parser.add_argument("--data-dir", default=os.environ.get("DATA_DIR", "data"))
    args = parser.parse_args(argv)
    return run(args.mode, Path(args.data_dir))


if __name__ == "__main__":
    sys.exit(main())
