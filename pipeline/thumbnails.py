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
