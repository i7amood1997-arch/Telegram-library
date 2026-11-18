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
from .store import Store, StoreError
from .thumbnails import save_thumb

log = logging.getLogger("pipeline")

MAX_THUMB_ATTEMPTS = 5
FETCH_SHARE = 0.4  # share of the time budget for fetching messages
MAX_MESSAGES_PER_CHANNEL = 5000  # per run, so a huge backlog cannot starve other channels
CLASSIFY_RESERVE_S = 90  # keep time at the end for classification + saving
SHRINK_BUDGET_S = 8 * 60  # one-time thumbnail shrink, spread over runs if needed


def _has_oversized(thumbs_dir: Path) -> bool:
    from PIL import Image

    from .config import THUMB_MAX_EDGE

    for p in thumbs_dir.glob("*.webp"):
        try:
            with Image.open(p) as img:
                if max(img.size) > THUMB_MAX_EDGE:
                    return True
        except Exception:
            continue
    return False


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
    from .backfill import sync_channel
    from .telegram_client import ChannelResolver, download_photos, fetch_range, make_client

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

            async def fetch(lo: int, hi: int, limit: int, *, _entity: Any = entity,
                            _cid: int = cid, _deadline: float = share_deadline
                            ) -> tuple[list[Any], bool]:
                msgs, photos, complete = await fetch_range(client, _entity, lo, hi, _deadline,
                                                           limit)
                photo_cache.update({(_cid, mid): m for mid, m in photos.items()})
                return msgs, complete

            result = await sync_channel(cid, ch, db["states"], db["items"], fetch,
                                        MAX_MESSAGES_PER_CHANNEL)
            stats["messages"] += result.messages
            stats["new_items"] += len(result.new_ids)
            stats["updated_items"] += len(result.updated_ids)
            stats["linked_previews"] += len(result.linked_ids)
            stats["history_gaps"] += len(ch.get("gaps", []))

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


def restore_ai_classifications(db: dict[str, Any], tax: Taxonomy) -> int:
    """Undo a full 'reclassify': keep categories Claude already produced (they cost money)."""
    restored = 0
    for it in db["items"].values():
        cls = it.get("classification")
        if (cls and it.get("prompt_version") is not None
                and it.get("taxonomy_version") != tax.version
                and cls.get("category") in tax.all_categories):
            it["taxonomy_version"] = tax.version
            restored += 1
    return restored


def classify_with_rules(db: dict[str, Any], tax: Taxonomy, in_batch: set[str],
                        stats: dict[str, Any]) -> None:
    """Free pass: hashtags, captions and file names (no API call)."""
    from .rules import rule_classify

    for it in db["items"].values():
        if it["id"] in in_batch or not needs_classification(it, tax):
            continue
        cls = rule_classify(it, tax)
        if cls is None:
            continue
        it["classification"] = cls
        it["taxonomy_version"] = tax.version
        it["prompt_version"] = "rules"
        it.pop("classify_attempts", None)
        stats["rules_classified"] += 1


def classify(settings: Settings, store: Store, tax: Taxonomy, deadline: float,
             stats: dict[str, Any]) -> None:
    db = store.db
    migrations = db.setdefault("migrations", [])
    if "restore_ai_classified_v1" not in migrations:
        stats["restored_classifications"] = restore_ai_classifications(db, tax)
        migrations.append("restore_ai_classified_v1")

    if "retry_uncategorized_v1" not in migrations:
        # Items that ended as Uncategorized (earlier failures, e.g. no API credit) get a
        # fresh, full chance with the AI classifier.
        for it in db["items"].values():
            if (it.get("classification") or {}).get("category") == "Uncategorized":
                it.pop("classification", None)
                it.pop("taxonomy_version", None)
                it.pop("classify_attempts", None)
                stats["uncategorized_retried"] += 1
        migrations.append("retry_uncategorized_v1")

    if "rules_recheck_v1" not in migrations:
        # Stricter rules: re-check earlier rule results; unclear ones go to Claude instead.
        from .rules import rule_classify

        for it in db["items"].values():
            if it.get("prompt_version") != "rules":
                continue
            cls = rule_classify(it, tax)
            if cls is None:
                for k in ("classification", "taxonomy_version", "prompt_version",
                          "classify_attempts"):
                    it.pop(k, None)
                stats["rules_sent_to_ai"] += 1
            elif cls["category"] != (it.get("classification") or {}).get("category"):
                it["classification"] = cls
                stats["rules_recategorized"] += 1
        migrations.append("rules_recheck_v1")

    in_batch = {i for b in db["batches"] for i in b["item_ids"]}
    classify_with_rules(db, tax, in_batch, stats)

    if not settings.anthropic_key:
        log.info("ANTHROPIC_API_KEY not set; skipping AI classification")
        return
    import anthropic

    from .lite import LiteClassifier, api_error_text

    client = anthropic.Anthropic(api_key=settings.anthropic_key, max_retries=3)

    def channel_title(item: dict[str, Any]) -> str:
        return db["channels"].get(str(item["channel_id"]), {}).get("title", "")

    full = Classifier(client, tax, settings.classifier_model, store.thumbs_dir, channel_title)
    lite = LiteClassifier(client, tax, settings.classifier_model, store.thumbs_dir)

    # 1. Collect finished batches (old per-item batches and new grouped ones).
    still_running = []
    for record in db["batches"]:
        try:
            clf = lite if record.get("kind") == "lite" else full
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

    # 2. Whatever the rules could not place goes to the grouped, low-cost classifier.
    in_batch = {i for b in db["batches"] for i in b["item_ids"]}
    pending = [it for it in db["items"].values()
               if it["id"] not in in_batch and needs_classification(it, tax)]
    pending = [it for it in pending
               if it.get("thumb") or not it.get("preview_message_id")
               or it.get("thumb_attempts", 0) >= MAX_THUMB_ATTEMPTS]
    pending.sort(key=lambda it: it["posted_at"], reverse=True)
    stats["classify_pending"] = len(pending)
    if not pending:
        return
    if len(pending) >= settings.batch_threshold:
        try:
            # Several batches of BATCH_MAX_ITEMS each (request size limits), all at once.
            todo = pending[: settings.max_batch_items]
            while todo:
                record = lite.submit_batch(todo)
                db["batches"].append(record)
                stats["batched"] += len(record["item_ids"])
                todo = todo[len(record["item_ids"]):]
            return
        except Exception as exc:
            if stats["batched"]:
                log.warning("batch submit stopped (%s)", api_error_text(exc))
                return
            log.warning("batch submit failed (%s); falling back to direct calls",
                        api_error_text(exc))
    stats["classified"] += lite.classify_now(pending[: settings.max_classifications], deadline)


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

    store = Store(data_dir, settings.site_password, settings.site_password_old,
                  settings.guest_passwords)
    try:
        store.load()
    except StoreError as exc:
        log.error("%s", exc)
        return 3

    stats: dict[str, Any] = defaultdict(int)
    deadline = started + settings.time_budget_s

    if mode in ("add-guest", "remove-guest"):
        from .guests import GuestError, add_guest, remove_guest

        try:
            if mode == "add-guest":
                add_guest(store.db, settings.guest_name)
                stats["guest_added"] = 1
            elif not remove_guest(store.db, settings.guest_name):
                log.error("no guest with that name")
                return 4
        except GuestError as exc:
            log.error("%s", exc)
            return 4
    if mode == "reclassify":
        # Redo only free/fallback results; categories Claude produced are kept (they cost money).
        for it in store.db["items"].values():
            if it.get("prompt_version") in (None, "rules"):
                it.pop("taxonomy_version", None)
                it.pop("classify_attempts", None)
    if mode in ("sync", "rebuild") and "thumbs_shrunk_v1" not in store.db.setdefault(
            "migrations", []):
        # Older thumbnails were 480px; the site outgrew GitHub Pages' 1 GB limit.
        from .thumbnails import shrink_thumbs

        n, saved = shrink_thumbs(store.thumbs_dir, time.time() + SHRINK_BUDGET_S)
        stats["thumbs_shrunk"] = n
        stats["thumbs_saved_mb"] = saved // 1_000_000
        if store.thumbs_dir.exists() and not _has_oversized(store.thumbs_dir):
            store.db["migrations"].append("thumbs_shrunk_v1")
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
    stats["site_passwords"] = len(store.site_passwords)
    stats["guests"] = len(store.db.get("guests", []))
    stats["changed"] = str(wrote["db"] or wrote["library"]).lower()
    stats["duration_s"] = int(time.time() - started)
    write_outputs(dict(stats), channel_report(store, settings) if settings.channels else None)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline")
    parser.add_argument("mode", nargs="?",
                        choices=["sync", "reclassify", "rebuild", "add-guest", "remove-guest"],
                        default="sync")
    parser.add_argument("--data-dir", default=os.environ.get("DATA_DIR", "data"))
    args = parser.parse_args(argv)
    return run(args.mode, Path(args.data_dir))


if __name__ == "__main__":
    sys.exit(main())
