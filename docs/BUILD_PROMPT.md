# Build Prompt: Telegram 3D Model Library

> Hand this entire document to an AI coding agent (or a developer) as the build brief.

---

## 1. Role and Objective

You are a senior full-stack engineer. Your task is to design, build, test and document a **private, searchable web library of 3ds Max models** whose source of truth is a set of Telegram channels. The result must be production-quality, maintainable by a single non-expert owner, and run at **zero hosting cost** using only **GitHub Actions** and **GitHub Pages** in this public repository.

Work incrementally, commit in logical steps, and do not stop at a prototype: every section below is a requirement unless it is explicitly marked *optional*.

---

## 2. Background

- The owner is an architectural visualization artist. Their main source of 3D models is **about six Telegram channels** that publish **3ds Max models for interior and exterior design**.
- Each channel follows a predictable pattern: a **preview image post** (a render of the model, sometimes with a caption) followed by **one or more file posts** (usually `.zip`, `.rar` or `.7z` archives, sometimes split into parts).
- Searching Telegram for a specific model is slow and unreliable. The owner wants one website that shows **every model across all channels**, **automatically categorized**, with fast search and filtering, where each result links back to the original Telegram post for download.
- The site is for **the owner only**. The interface language is **English**. The owner uses **Windows** locally.

---

## 3. Hard Constraints

1. **Hosting:** the website is a **static site on GitHub Pages**. There is no always-on server.
2. **Processing:** all ingestion and classification run in **GitHub Actions** on a schedule (**every 30 minutes**) plus manual `workflow_dispatch`. A 15–30 minute delay before new models appear is acceptable.
3. **The repository is public.** Therefore:
   - All library data (titles, captions, file names, channel identities, links, categories) **must be encrypted at rest** in the repository and decrypted **only in the browser** with a password.
   - **No secret or library content may ever appear in Actions logs**, commit messages or plaintext files. Log only counts, durations and opaque IDs.
   - Channel identifiers are secrets and must be supplied through GitHub Secrets, not committed.
4. **No re-hosting of model archives.** Never download the archive files. Store only metadata and a small preview thumbnail; downloading happens in Telegram via the deep link.
5. **Cost control:** Claude API usage must be bounded, cached and idempotent. No item is ever classified twice unless the taxonomy version changes.

---

## 4. Architecture

```
┌──────────────────────── GitHub Actions (cron: every 30 min) ────────────────────────┐
│ 1. Decrypt data/db.enc → in-memory DB (includes per-channel last_message_id cursor)  │
│ 2. Telethon (user session) → fetch new messages since cursor for each channel       │
│ 3. Group preview image + archive post(s) into "model items"                         │
│ 4. Download preview photo → resize to WebP thumbnail (opaque filename)              │
│ 5. Classify new items with Claude (text + image) → structured JSON                  │
│ 6. Re-encrypt db.enc + build encrypted public index library.enc                     │
│ 7. Commit to the `data` branch → build frontend → deploy to GitHub Pages            │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────── GitHub Pages (static) ──────────────────────────────┐
│ Password gate → Web Crypto decrypts library.enc → in-browser search index (worker)  │
│ Grid of model cards · facets · detail view · "Open in Telegram" deep link            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Branch strategy
- **`main`**: source code, workflows, docs. Humans commit here.
- **`data`**: generated, append-mostly content only (`db.enc`, `library.enc`, `thumbs/`). Only the workflow commits here, using concise generic messages such as `data: +12 items`. This keeps `main` history clean.
- Deployment uses `actions/upload-pages-artifact` + `actions/deploy-pages` and combines the built frontend from `main` with the data from `data`.

### Suggested repository layout
```
/
├── .github/workflows/
│   ├── sync.yml              # scheduled ingest + classify + deploy
│   ├── deploy.yml            # deploy on push to main (frontend changes)
│   └── ci.yml                # lint + tests on PRs
├── pipeline/                 # Python 3.12 package
│   ├── config.py             # env/secret loading, constants, taxonomy version
│   ├── telegram_client.py    # Telethon wrapper, flood-wait handling
│   ├── grouping.py           # preview ↔ archive grouping logic (pure, unit-tested)
│   ├── thumbnails.py         # download + resize + opaque naming
│   ├── classify.py           # Claude calls, schema, retries, batching
│   ├── crypto.py             # AES-GCM + PBKDF2, format shared with the frontend
│   ├── store.py              # DB model, load/save, cursor management
│   ├── build_index.py        # produce library.enc for the browser
│   └── main.py               # CLI entry points: sync, backfill, reclassify
├── scripts/
│   └── login.py              # one-time local script to create a Telethon StringSession
├── taxonomy.yml              # editable category tree (single source of truth)
├── tests/                    # pytest, with anonymized fixtures
├── web/                      # Vite + TypeScript frontend
│   ├── src/
│   └── index.html
├── docs/
│   ├── SETUP.md              # step-by-step owner guide (Windows-friendly)
│   └── ARCHITECTURE.md
└── README.md
```

---

## 5. Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Purpose |
|---|---|
| `TG_API_ID`, `TG_API_HASH` | Telegram application credentials from my.telegram.org |
| `TG_SESSION` | Telethon `StringSession` produced by `scripts/login.py` |
| `TG_CHANNELS` | Newline- or comma-separated list of channel usernames or numeric IDs |
| `ANTHROPIC_API_KEY` | Claude API key for classification |
| `SITE_PASSWORD` | Password used to encrypt library data and unlock the site |
| `THUMB_SECRET` | Random key used to derive opaque thumbnail filenames (HMAC) |

**Security note to surface in docs:** the owner should create a **secondary Telegram account** that only joins the source channels and use it for `TG_SESSION`. The owner's **primary** account must also be a member of the channels so deep links open correctly on their devices.

---

## 6. Ingestion Pipeline (Python)

### 6.1 Telegram access
- Use **Telethon** with a `StringSession` from the `TG_SESSION` secret. Never write the session to disk in the runner.
- Resolve each entry in `TG_CHANNELS` to an entity once per run.
- **Backfill mode** (`python -m pipeline.main backfill`): iterate the full history oldest → newest, in resumable chunks, committing progress periodically so a long backfill can span several runs without losing work.
- **Sync mode** (default, scheduled): fetch only messages with `id > last_message_id` per channel.
- Handle `FloodWaitError` by sleeping the requested time (with an upper bound, after which the run exits cleanly and resumes next time). Add small jittered delays between requests.
- Respect a per-run time budget (for example 20 minutes) so runs never overlap. Use a workflow `concurrency` group with `cancel-in-progress: false`.

### 6.2 Grouping posts into model items
This is the most important logic in the pipeline. Implement it as **pure functions** with thorough unit tests.

- A **model item** = one preview image (optional) + one or more archive messages.
- Rules, in priority order:
  1. Messages sharing a Telegram **`grouped_id`** (album) belong together.
  2. An archive message is attached to the **nearest preceding photo** in the same channel, provided no other archive has already claimed that photo **and** the gap is within a configurable window (default: 15 messages and 6 hours).
  3. **Multi-part archives** (`.part1.rar`/`.part2.rar`, `.z01`/`.zip`, `.7z.001`/`.7z.002`, `name (1).rar` …) collapse into one item with an ordered list of parts.
  4. Multiple consecutive distinct archives after a single photo: if their base names are similar, treat them as one item with several files. Otherwise create separate items that share the same preview.
  5. An archive with no matching photo becomes an item with no thumbnail (still searchable and classifiable from text).
  6. Photos with no archive within the window are ignored, but kept as pending candidates so an archive arriving in a later run can still attach to them. Persist pending photos in the DB.
- Only treat documents as archives if their extension is in an allow-list (`.zip`, `.rar`, `.7z`, `.max`, `.part*.rar`, `.z##`, `.###`). Ignore other media.

### 6.3 Extracted fields per item
```
id                 stable: "<channel_id>:<first_archive_message_id>"
channel_id, channel_title
message_ids        all archive message IDs (ordered), preview_message_id
files              [{name, size_bytes, ext}]
caption            combined captions from preview and archives (trimmed)
posted_at          ISO 8601 UTC of the first archive
link               deep link to the preview (or first archive) message:
                   public channel  → https://t.me/<username>/<msg_id>
                   private channel → https://t.me/c/<internal_id>/<msg_id>
thumb              opaque filename or null
classification     see §7 (null until classified)
taxonomy_version   integer
```

### 6.4 Thumbnails
- Download the **smallest photo size ≥ 480 px** on the long edge (never the original), resize to **480 px max**, encode to **WebP quality ≈ 70**, strip metadata. Target **< 35 KB**.
- Filename = first 24 hex characters of `HMAC-SHA256(THUMB_SECRET, item_id)` + `.webp`. Filenames must not reveal channels or IDs.
- Thumbnails are stored unencrypted for performance. This is an accepted trade-off, since they are only anonymous preview renders. *Optional:* a setting to encrypt thumbnails too, decrypted client-side.

---

## 7. Automatic Classification (Claude API)

### 7.1 Model and calling pattern
- Use the official `anthropic` Python SDK. Read the model ID from an environment variable `CLASSIFIER_MODEL` with default `claude-haiku-5-5` (fast and inexpensive, supports vision). The owner can switch to `claude-sonnet-5-5` for higher accuracy.
- Send **the thumbnail image + file names + caption + channel title** in one request.
- Force structured output through **tool use with a strict JSON schema** (a single `record_classification` tool, `tool_choice` forced). Validate the response with Pydantic. On validation failure, retry once, then store `category: "Uncategorized"` with `confidence: 0`.
- **Backfill** uses the **Message Batches API** (lower cost). **Scheduled sync** uses normal requests, because volumes are small.
- Enforce a configurable cap of `MAX_CLASSIFICATIONS_PER_RUN` (default 300). The remainder carries over to the next run.
- Apply **deterministic pre-extraction** before calling Claude: use regex to detect render engine (`corona`, `vray`/`v-ray`, `fstorm`, `arnold`) and 3ds Max version (`max 2018`, `2021`, …) from names and captions. Pass these to the model as hints, and prefer regex results when they are unambiguous.
- Prompts are stored as versioned constants. Captions may be in any language (often Russian, Arabic or Chinese). Instruct the model to produce English output.

### 7.2 Taxonomy (`taxonomy.yml`, editable by the owner)
```yaml
version: 1
categories:
  Interior:
    - Sofas & Armchairs
    - Chairs & Stools
    - Tables
    - Beds
    - Wardrobes & Storage
    - Kitchens
    - Bathrooms & Sanitary
    - Lighting
    - Decor & Accessories
    - Rugs & Curtains
    - Indoor Plants
    - Appliances & Electronics
    - Doors & Windows
    - Wall & Ceiling Elements
  Exterior:
    - Trees & Vegetation
    - Vehicles
    - Outdoor Furniture
    - Buildings & Facades
    - Street Elements
    - Landscape & Hardscape
    - People
  Scenes:
    - Interior Scene
    - Exterior Scene
styles: [Modern, Contemporary, Minimalist, Classic, Neoclassic, Art Deco, Scandinavian,
         Industrial, Japandi, Mid-Century, Rustic, Oriental, Other]
render_engines: [Corona, V-Ray, FStorm, Arnold, Unknown]
```
The JSON schema enums are **generated from this file** at runtime. When `version` changes, the `reclassify` command (manual `workflow_dispatch` input) re-processes affected items within the per-run cap.

### 7.3 Classification output schema
```json
{
  "title":        "Clean, human-readable English name, e.g. 'Boucle Curved Sofa'",
  "group":        "Interior | Exterior | Scenes",
  "category":     "one value from taxonomy",
  "style":        "one value from styles",
  "render_engine":"one value from render_engines",
  "max_version":  "e.g. '2021' or null",
  "materials":    ["fabric", "oak wood", "brass"],
  "colors":       ["beige", "black"],
  "tags":         ["5–12 lowercase English search keywords, including synonyms"],
  "is_collection":"true if the archive appears to contain many models",
  "confidence":   0.0
}
```

---

## 8. Encryption Format (shared by Python and the browser)

- **KDF:** PBKDF2-HMAC-SHA256, **600,000 iterations**, random 16-byte salt.
- **Cipher:** AES-256-GCM, random 12-byte IV per file.
- **Payload:** UTF-8 JSON → gzip → encrypt.
- **File layout:** a small JSON header `{ "v":1, "kdf":"pbkdf2-sha256", "iter":600000, "salt":"b64", "iv":"b64" }` followed by base64 ciphertext, or an equivalent documented binary layout. Document the format in `ARCHITECTURE.md`.
- `db.enc` = full pipeline state (items, cursors, pending photos, classification cache).
- `library.enc` = slimmed browser index containing only the fields the UI needs.
- The browser decrypts with the **Web Crypto API** (`PBKDF2` → `AES-GCM`) and decompresses with `DecompressionStream('gzip')`.
- Provide a **cross-language round-trip test**: Python encrypts and a Node test decrypts using the same code path as the frontend.

---

## 9. Frontend (GitHub Pages)

### 9.1 Stack
- **Vite + TypeScript**, using **Preact** or vanilla TS. Keep the bundle small (< 150 KB gzipped, excluding data).
- **MiniSearch** (or an equivalent) for full-text search with prefix matching, fuzzy matching and field boosting (`title` > `tags` > `category` > `files` > `caption`). Build the index in a **Web Worker** so the UI never blocks.
- Configure the Vite `base` correctly for the repository's Pages path.
- Add `<meta name="robots" content="noindex,nofollow">` and a `robots.txt` that disallows all crawling.

### 9.2 Password gate
- Full-screen, minimal unlock screen with a password field and a **"Remember on this device"** checkbox.
- When the checkbox is ticked, store the **derived key** (never the password) in `localStorage`. Otherwise use `sessionStorage`. Provide a **Lock** button that clears it.
- Show a clear error on a wrong password (GCM authentication failure). No other content may be visible before unlocking.

### 9.3 Main interface
- **Header:** product name, a prominent search box (shortcut `/` focuses it, `Esc` clears it), total and filtered counts, theme toggle, Lock button.
- **Sidebar facets (collapsible on mobile into a drawer):** Group → Category tree with counts, Style, Render engine, 3ds Max version, Channel, Date added (presets: last 24 h / 7 days / 30 days / all), "Has preview" toggle. Counts update live as filters change.
- **Results grid:** responsive cards using a **virtualized/windowed** layout that stays smooth with 20,000+ items. Each card shows the lazy-loaded thumbnail with a fixed aspect ratio and skeleton loader, the title, a category chip, up to 3 tags, total size, a relative date and a **"NEW"** badge for items added since the owner's last visit (tracked in `localStorage`).
- **Sort:** Relevance (default when searching), Newest (default otherwise), Title A–Z, Size.
- **Detail view** (modal or side panel, deep-linkable via URL hash): large preview, all classification fields, original caption (collapsible), the file list with parts and sizes, channel name, posting date, and a primary **"Open in Telegram"** button plus **"Copy link"**. Clicking a tag or category in the detail view applies it as a filter.
- **URL state:** the query, filters, sort and open item are reflected in the URL so views can be bookmarked and restored.
- **Empty and error states:** helpful messages for no results (suggest clearing filters), a failed data load, and an empty library.
- **"Last updated"** indicator, read from index metadata.

### 9.4 Design quality
- A clean, modern, professional look inspired by asset libraries and design-tool UIs. Use neutral surfaces so preview renders stand out.
- **Dark and light themes**, defaulting to the system preference, using CSS custom properties.
- Fully responsive from 360 px phones to wide desktops. Touch-friendly targets.
- Accessible: semantic HTML, keyboard navigation through cards and the modal, visible focus rings, sufficient contrast, `alt` text from titles, `prefers-reduced-motion` respected.
- Performance targets: first unlock-to-results under 2 s for 10,000 items on a mid-range phone, and smooth 60 fps scrolling.

---

## 10. GitHub Actions Workflows

### `sync.yml`
- Triggers: `schedule: '*/30 * * * *'` and `workflow_dispatch` with inputs `mode` (`sync` | `backfill` | `reclassify`) and `max_items`.
- `permissions: contents: write, pages: write, id-token: write`.
- `concurrency: { group: sync, cancel-in-progress: false }`, with a `timeout-minutes` value aligned to the time budget.
- Steps: check out `main` and `data` (separate paths), set up Python with pip caching, run the pipeline, commit to `data` **only if something changed**, build the frontend, assemble the Pages artifact (frontend + `library.enc` + `thumbs/`) and deploy.
- **Log hygiene:** the pipeline prints only aggregate counts, for example `channels=6 new_messages=41 new_items=12 classified=12 duration=94s`. Disable verbose library logging (Telethon at WARNING). Never `echo` secrets or data.

### `deploy.yml`
- On push to `main` (frontend or workflow changes): rebuild and redeploy using the existing `data` branch.

### `ci.yml`
- On pull requests: `ruff` + `pytest` for Python, and `tsc --noEmit` + unit tests for the frontend.

**Note for docs:** GitHub may disable scheduled workflows after 60 days without repository activity. Because the workflow commits new data regularly this should not happen, but document how to re-enable the workflow if it does.

---

## 11. One-Time Local Setup (Windows), to be documented in `docs/SETUP.md`

Write this guide for a non-developer, with exact PowerShell commands and screenshots-level clarity:
1. Create a secondary Telegram account (recommended) and join the source channels with it.
2. Get `api_id` and `api_hash` from my.telegram.org.
3. Install Python 3.12, run `pip install telethon`, run `python scripts/login.py`, enter the phone number and code, and copy the printed `StringSession`.
4. Add all secrets from §5 to the repository.
5. Enable GitHub Pages with source **GitHub Actions**.
6. Run the **sync** workflow manually in `backfill` mode and watch it complete (possibly over several runs).
7. Open the site, enter the password, and tick "Remember on this device".
8. How to edit `taxonomy.yml` and trigger `reclassify`, how to add or remove a channel, and how to rotate the password (re-encryption happens automatically on the next run).

---

## 12. Quality Requirements

- **Python:** 3.12, type hints throughout, `ruff` clean, small focused modules, and no hidden global state.
- **Tests:**
  - Grouping logic, covering albums, multi-part archives, orphan archives, orphan photos, cross-run pending photos and similar-name merging. Use anonymized synthetic fixtures only.
  - Deep link construction for public and private channels.
  - Regex pre-extraction (render engine, Max version).
  - Classification response validation, with the Claude call mocked.
  - Crypto round trip Python → Node.
  - Idempotency: running sync twice with no new messages yields no data commit.
- **Resilience:** any single failed item (download, classification) is logged by opaque ID and retried in a later run. It must never abort the whole run. A corrupted or missing `db.enc` must fail loudly without overwriting good data.
- **Docs:** `README.md` (overview, screenshots placeholder, quick links), `docs/SETUP.md`, and `docs/ARCHITECTURE.md` (data flow, formats, grouping rules, cost estimate).

---

## 13. Non-Goals

- No downloading, mirroring or re-hosting of model archives.
- No multi-user accounts, comments or uploads.
- No server, database service or paid hosting.
- No real-time (sub-minute) updates.

---

## 14. Delivery Milestones

1. **Foundation:** repo layout, crypto module + browser counterpart with the round-trip test, `taxonomy.yml`, CI.
2. **Ingestion:** Telethon client, grouping logic with full tests, thumbnails, encrypted DB, backfill + sync commands, `scripts/login.py`.
3. **Frontend MVP:** password gate, decrypt, search, grid, detail view, deep links, deployed via Actions.
4. **Classification:** Claude integration, batch backfill, per-run caps, facets wired to classification fields.
5. **Polish:** virtualization, URL state, NEW badges, themes, accessibility pass, performance check against the targets, complete docs.

## 15. Acceptance Criteria

- [ ] A scheduled run picks up a newly posted model in any configured channel, and it appears on the site within roughly 30 minutes, correctly grouped with its preview and categorized.
- [ ] Without the password, the repository and the site expose no titles, captions, file names, channel identities or links.
- [ ] Actions logs contain no library content or secrets.
- [ ] Searching "curved boucle sofa" or "olive tree" returns relevant results instantly, and facet filters combine correctly.
- [ ] "Open in Telegram" opens the exact source post on desktop and mobile.
- [ ] Re-running sync with no new posts produces no commit and no Claude calls.
- [ ] All tests pass in CI, and the owner can complete setup by following `docs/SETUP.md` alone.
