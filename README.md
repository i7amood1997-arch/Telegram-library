# Model Library

A private, searchable library of 3ds Max models collected from Telegram channels.

- **Automatic:** every 30 minutes GitHub Actions reads new posts, pairs each preview image with
  its archive files, and categorizes the model with Claude (category, style, render engine,
  3ds Max version, tags).
- **Private:** all library data is encrypted with your password. The repository and the site
  are public, but without the password they show nothing useful.
- **Free hosting:** GitHub Pages + GitHub Actions. You only pay for Claude, which costs cents.
- **Fast:** instant full-text search, filters with live counts, smooth with tens of thousands
  of models, and works on phones.

Each model links back to its Telegram post, where you download it.

## Getting started

Follow **[docs/SETUP.md](docs/SETUP.md)** (Arabic, step by step, Windows-friendly).

## Project layout

| Path | What |
|---|---|
| `pipeline/` | Python: Telegram ingest, grouping, thumbnails, classification, encryption |
| `web/` | Website (Vite + TypeScript) |
| `taxonomy.yml` | Categories, styles and render engines. Edit freely |
| `scripts/login.py` | One-time local Telegram login that prints the secrets you need |
| `.github/workflows/sync.yml` | Scheduled sync + deploy |
| `docs/ARCHITECTURE.md` | How it works: data flow, formats, grouping rules |

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest && ruff check .

python -m pipeline.demo            # fake encrypted library in web/public/demo
cd web && npm install && npm run dev
# open http://localhost:5173/?demo   (password: demo)
```
