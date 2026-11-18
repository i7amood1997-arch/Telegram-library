"""Preview thumbnails: resize to small WebP files with opaque (HMAC-derived) names."""

from __future__ import annotations

import hashlib
import hmac
import io
from pathlib import Path

from PIL import Image, ImageOps

from .config import THUMB_MAX_EDGE, THUMB_QUALITY


def thumb_name(secret: str, item_id: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), item_id.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()[:24] + ".webp"


def make_thumb(image_bytes: bytes) -> bytes:
    with Image.open(io.BytesIO(image_bytes)) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        img.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        # Pillow writes no EXIF/XMP unless asked, so metadata is stripped.
        img.save(out, format="WEBP", quality=THUMB_QUALITY, method=6)
        return out.getvalue()


def save_thumb(thumbs_dir: Path, secret: str, item_id: str, image_bytes: bytes) -> str:
    name = thumb_name(secret, item_id)
    (thumbs_dir / name).write_bytes(make_thumb(image_bytes))
    return name


def _shrink_one(path: str) -> int:
    """Re-encode one oversized thumbnail in place; returns bytes saved (0 if left alone)."""
    p = Path(path)
    try:
        with Image.open(p) as img:
            if max(img.size) <= THUMB_MAX_EDGE:
                return 0
            img.load()
            img.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="WEBP", quality=THUMB_QUALITY, method=4)
    except Exception:
        return 0
    before = p.stat().st_size
    data = out.getvalue()
    if len(data) >= before:
        return 0
    p.write_bytes(data)
    return before - len(data)


def shrink_thumbs(thumbs_dir: Path, deadline: float) -> tuple[int, int]:
    """Shrink thumbnails made with the older, larger size (resumable across runs).

    Returns (files shrunk, bytes saved). Same file names, so nothing else changes.
    """
    import time
    from concurrent.futures import ProcessPoolExecutor

    paths = [str(p) for p in thumbs_dir.glob("*.webp")]
    shrunk = saved = 0
    chunk = 2000
    with ProcessPoolExecutor() as pool:
        for start in range(0, len(paths), chunk):
            if time.time() > deadline:
                break
            for s in pool.map(_shrink_one, paths[start : start + chunk], chunksize=50):
                if s:
                    shrunk += 1
                    saved += s
    return shrunk, saved


def ai_image(path: Path, edge: int) -> bytes:
    """A smaller copy of a thumbnail for Claude (fewer image tokens, same category signal)."""
    with Image.open(path) as img:
        if max(img.size) <= edge:
            return path.read_bytes()
        img.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="WEBP", quality=70, method=2)
        return out.getvalue()
