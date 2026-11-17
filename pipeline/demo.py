"""Generate a fake, encrypted demo library for local frontend development and tests.

    python -m pipeline.demo --out web/public/demo --count 400 --password demo
"""

from __future__ import annotations

import argparse
import random
import time
from pathlib import Path

from PIL import Image, ImageDraw

from . import crypto
from .build_index import build_library
from .config import load_taxonomy
from .thumbnails import make_thumb, thumb_name

WORDS = {
    "Sofas & Armchairs": ["Boucle Curved Sofa", "Leather Club Armchair", "Modular Corner Sofa"],
    "Chairs & Stools": ["Bentwood Dining Chair", "Rattan Bar Stool", "Wishbone Chair"],
    "Tables": ["Travertine Coffee Table", "Oak Dining Table", "Marble Side Table"],
    "Beds": ["Upholstered Platform Bed", "Canopy Bed", "Linen Bed Set"],
    "Lighting": ["Paper Pendant Lamp", "Brass Floor Lamp", "Glass Globe Chandelier"],
    "Decor & Accessories": ["Ceramic Vase Set", "Book Stack Decor", "Abstract Wall Art"],
    "Indoor Plants": ["Fiddle Leaf Fig", "Monstera in Pot", "Olive Tree in Pot"],
    "Kitchens": ["Modern Kitchen Set", "Island Kitchen Walnut"],
    "Trees & Vegetation": ["Olive Tree", "Palm Tree Set", "Japanese Maple"],
    "Vehicles": ["Porsche Taycan", "City Bicycle", "Electric Scooter"],
    "Outdoor Furniture": ["Teak Sun Lounger", "Outdoor Rope Chair"],
    "Interior Scene": ["Scandinavian Living Room", "Japandi Bedroom Scene"],
    "Exterior Scene": ["Modern Villa Exterior", "Desert House Scene"],
}
TAGS = ["modern", "wood", "fabric", "minimal", "luxury", "set", "pot", "green", "metal", "beige"]


def fake_image(rng: random.Random, label: str) -> bytes:
    img = Image.new("RGB", (800, 600), tuple(rng.randint(60, 220) for _ in range(3)))
    d = ImageDraw.Draw(img)
    for _ in range(6):
        x, y = rng.randint(0, 700), rng.randint(0, 500)
        d.rounded_rectangle([x, y, x + rng.randint(60, 260), y + rng.randint(60, 200)], 30,
                            fill=tuple(rng.randint(30, 250) for _ in range(3)))
    d.text((24, 24), label, fill=(255, 255, 255))
    import io

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="web/public/demo")
    ap.add_argument("--count", type=int, default=400)
    ap.add_argument("--password", default="demo")
    args = ap.parse_args()
    rng = random.Random(7)
    tax = load_taxonomy()
    out = Path(args.out)
    (out / "thumbs").mkdir(parents=True, exist_ok=True)
    now = time.time()
    channels = {str(1000 + i): {"id": 1000 + i, "title": f"Demo Channel {i + 1}",
                                "username": None, "ref": str(1000 + i)} for i in range(6)}
    items = {}
    images = [fake_image(rng, f"preview {i}") for i in range(24)]
    for n in range(args.count):
        cat = rng.choice(list(WORDS))
        title = rng.choice(WORDS[cat])
        cid = 1000 + rng.randrange(6)
        item_id = f"{cid}:{n + 10}"
        parts = rng.choice([1, 1, 1, 2, 3])
        base = title.replace(" ", "_")
        files = [{"name": f"{base}.part{p}.rar" if parts > 1 else f"{base}.rar",
                  "size": rng.randint(5, 900) * 1_048_576, "ext": "rar", "part": p if parts > 1
                  else None, "msg_id": n + 10 + p} for p in range(1, parts + 1)]
        has_thumb = rng.random() > 0.05
        thumb = None
        if has_thumb:
            thumb = thumb_name("demo", item_id)
            (out / "thumbs" / thumb).write_bytes(make_thumb(rng.choice(images)))
        items[item_id] = {
            "id": item_id, "channel_id": cid, "message_ids": [f["msg_id"] for f in files],
            "preview_message_id": n + 9 if has_thumb else None, "files": files,
            "caption": f"{title} #3dsmax #{rng.choice(['corona', 'vray'])}",
            "posted_at": now - n * rng.randint(600, 9000),
            "thumb": thumb,
            "classification": {
                "title": title, "group": tax.group_of(cat), "category": cat,
                "style": rng.choice(tax.styles), "render_engine": rng.choice(tax.render_engines),
                "max_version": rng.choice(["2015", "2018", "2021", None]),
                "materials": rng.sample(["oak", "linen", "brass", "marble"], 2),
                "colors": rng.sample(["beige", "black", "white", "green"], 2),
                "tags": rng.sample(TAGS, 5), "is_collection": rng.random() < 0.1,
                "confidence": 0.9,
            } if rng.random() > 0.03 else None,
        }
    db = {"channels": channels, "items": items}
    lib = build_library(db, tax)
    salt = crypto.new_salt()
    (out / "library.enc").write_text(
        crypto.encrypt_json({**lib, "updated_at": now}, args.password, salt), encoding="utf-8")
    print(f"demo library: {len(lib['items'])} items -> {out}")


if __name__ == "__main__":
    main()
