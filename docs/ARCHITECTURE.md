# Architecture

## Data flow

```
GitHub Actions "Sync library" (cron */30, manual, push to main)
  1. checkout main → ./app, data branch → ./data (git worktree)
  2. python -m pipeline.main sync --data-dir ../data
       Store.load()          decrypt data/db.enc (SITE_PASSWORD, falls back to SITE_PASSWORD_OLD)
       ingest()              Telethon, per channel, NEWEST FIRST (pipeline/backfill.py):
                             new posts above the head first, then unread history ("gaps")
                             top-down; ≤ 5000 messages per channel per run, fetching gets
                             ≤ 40% of the budget shared fairly across channels
         group_messages()    photos + archives → model items (pure, see grouping.py)
         thumbnails          all channels together, newest first, 6 concurrent downloads of the
                             smallest stored size ≥ 320px → WebP → data/thumbs/<hmac>.webp.
                             Rate limits (FloodWait / FloodPremiumWait, common on non-Premium
                             accounts) never count as failed attempts: a long one ends the
                             download phase and the rest is retried next run
       classify()            collect finished Claude batches; submit a new batch (≥ 40 pending)
                             or classify directly (capped per run)
       build_library()       slim browser index
       Store.save()          write library.enc / db.enc only if content changed
  3. commit + push ./data when changed
  4. build web/ (Vite), add library.enc + thumbs/, deploy to GitHub Pages
```

Scheduled runs deploy only when data changed. Manual runs and pushes always deploy.

## Branches

| Branch | Content | Written by |
|---|---|---|
| `main` | source code, workflows, docs, `taxonomy.yml` | humans |
| `data` | `db.enc`, `library.enc`, `thumbs/` | the workflow only |

## Encryption format

`db.enc` and `library.enc` are UTF-8 JSON envelopes:

```json
{"v":1,"kdf":"pbkdf2-sha256","iter":600000,"salt":"<b64>","iv":"<b64>","ct":"<b64>"}
```

- Key: PBKDF2-HMAC-SHA256(password, salt, 600 000 iterations) → 32 bytes.
- Cipher: AES-256-GCM, random 12-byte IV per write; `ct` includes the 16-byte tag.
- Plaintext: gzip(JSON).
- The salt is reused across writes, so a browser can keep its derived key ("Remember on this
  device"). It is regenerated when the password is rotated, which invalidates remembered keys.
- Implementations: `pipeline/crypto.py` (writer) and `web/src/crypto.js` (reader, Web Crypto).
  `tests/test_crypto_node.py` checks that the two are compatible.

Thumbnails are not encrypted. Their names are `HMAC-SHA256(THUMB_SECRET, item_id)[:24].webp`,
so they cannot be linked to channels or posts.

### Guest passwords (`library.enc` format v2)

`library.enc` is encrypted with a random 256-bit **content key**. For `SITE_PASSWORD` and each
line of `GUEST_PASSWORDS` there is a slot holding the content key wrapped with that password's
PBKDF2 key. All slots share one salt, so the browser derives once and tries each slot cheaply,
and the slot order is shuffled. Whenever the set of passwords changes, a new content key is
generated, so a removed guest cannot open the new file even with a remembered key. `db.enc`
stays format v1 and opens only with `SITE_PASSWORD`.

## Grouping rules (`pipeline/grouping.py`)

Per channel, messages in ascending id order:

1. **Photo**: remembered as a candidate preview (kept in state across runs, trimmed by window).
2. **Archive** (`.zip .rar .7z .max`, plus split forms `.partN.rar`, `.z01`, `.r00`, `.7z.001`,
   `name (2).rar`, `name part 2.zip`):
   - Merge into the previous item when it is in the same album, continues a split set (same
     base name + part number), or has the same or a similar name (≥ 0.8 similarity) and the
     same preview photo.
   - Otherwise create a new item using the nearest preceding photo within **15 messages and
     6 hours** (album photo first). An already-claimed photo is shared.
3. Other messages are ignored.

The item id is `<channel_id>:<first archive message id>`. Deep links point to the first
archive message: `t.me/<username>/<id>` for public channels, `t.me/c/<id>/<id>` for private ones.

## Classification

- Model: `CLASSIFIER_MODEL` (default `claude-haiku-5-5`), called with the preview image,
  file names, caption (≤ 1500 chars) and regex hints (render engine, 3ds Max version).
- Output is forced through a single tool (`record_classification`) whose enums come from
  `taxonomy.yml`, then validated with Pydantic and coerced (the group is derived from the category,
  and regex hints win over model guesses).
- Failed items are retried in later runs. After 3 failures they get an `Uncategorized` fallback.
- Changing `taxonomy.yml` `version` re-queues every item. `reclassify` mode forces all.

### Cost estimate

One request ≈ 1.3k input tokens (a ~480px image plus text) and ≈ 200 output tokens. With
Haiku-class pricing that is a fraction of a cent per model. The batch API halves this for the
initial backfill, so a few thousand models costs a few dollars once. Afterwards, new posts cost cents per month.

## Log hygiene

The repository is public, so Actions logs are public too. The pipeline logs only counts,
durations and exception class names. Telethon, httpx and anthropic loggers are set to ERROR.
`tests/test_main.py` asserts that channel and model names never appear in the output.

## Browser app (`web/`)

- Vite + TypeScript, no framework. MiniSearch runs in a Web Worker (prefix + fuzzy, AND falling
  back to OR, boosted fields: title > tags > category > style > files > caption).
- Virtualized grid: only cards near the viewport are in the DOM.
- Filter state lives in the query string, and the open model in `#m=<id>`.
- `?demo` loads `./demo/library.enc` (password `demo`), generated by `python -m pipeline.demo`.

## Diagnostics

Each run logs (and writes to the run's summary page) aggregate counters plus one line per channel,
labelled only by position in `TG_CHANNELS`:

```
channel#3 items=5210 with_preview=5190 thumbs=4100 thumbs_gave_up=0 classified=3900
```

## Newest-first sync (`pipeline/backfill.py`)

Each channel stores its head (`last_message_id`) and a list of unread history ranges
(`gaps`, each with the grouping state at its lower end). A run reads the head first; if the new
posts do not fit in the per-run limit, the unread remainder becomes a gap. Leftover budget
fills gaps from the top down. Chunks are grouped in ascending order, and at every chunk boundary
`link_orphans` repairs what the boundary cut: it merges the next part of a split archive into
its first part, and gives a preview-less model the nearest unclaimed photo just below it.
`tests/test_backfill.py` checks that any chunk size yields exactly the same items as reading
the channel in one go.
