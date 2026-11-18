"""Free, rule-based classification from hashtags, captions and file names.

Most channels tag posts with words such as "#Мебель #Диваны #Corona", which already say what
the model is. Matching those (Russian and English) handles a large share of the library with no
API call. Items without a clear match go to the (cheap, grouped) Claude classifier.
"""

from __future__ import annotations

import re
from typing import Any

from .classify import extract_hints, item_text, pretty_title, resource_hint
from .config import Taxonomy

# category -> [(word stem, English label used for titles and tags)]
# Stems match the start of a word ("диван" matches "диваны"); keep them specific.
CATEGORY_WORDS: dict[str, list[tuple[str, str]]] = {
    "Sofas & Armchairs": [("диван", "sofa"), ("софа", "sofa"), ("кресл", "armchair"), ("пуф", "pouf"),
                          ("sofa", "sofa"), ("couch", "sofa"), ("armchair", "armchair"), ("settee", "sofa"),
                          ("loveseat", "sofa"), ("chaise", "chaise longue"), ("pouf", "pouf"), ("ottoman", "ottoman")],
    "Chairs & Stools": [("стул", "chair"), ("табурет", "stool"), ("скамь", "bench"), ("chair", "chair"),
                        ("stool", "stool"), ("bench", "bench")],
    "Tables": [("стол", "table"), ("столик", "table"), ("table", "table"), ("desk", "desk"),
               ("console", "console table")],
    "Beds": [("кроват", "bed"), ("bed", "bed"), ("кровать", "bed")],
    "Wardrobes & Storage": [("шкаф", "wardrobe"), ("комод", "chest of drawers"), ("стеллаж", "shelving"),
                            ("тумб", "cabinet"), ("полк", "shelf"), ("wardrobe", "wardrobe"), ("cabinet", "cabinet"),
                            ("dresser", "dresser"), ("shelf", "shelf"), ("shelving", "shelving"),
                            ("bookcase", "bookcase"), ("sideboard", "sideboard"), ("nightstand", "nightstand")],
    "Kitchens": [("кухн", "kitchen"), ("kitchen", "kitchen")],
    "Bathrooms & Sanitary": [("ванн", "bathroom"), ("санузел", "bathroom"), ("сантехник", "sanitary"),
                             ("раковин", "sink"), ("унитаз", "toilet"), ("смесител", "faucet"), ("душ", "shower"),
                             ("bathroom", "bathroom"), ("bathtub", "bathtub"), ("sink", "sink"),
                             ("toilet", "toilet"), ("shower", "shower"), ("faucet", "faucet")],
    "Lighting": [("люстр", "chandelier"), ("светильник", "lamp"), ("ламп", "lamp"), ("торшер", "floor lamp"),
                 ("бра", "wall lamp"), ("освещени", "lighting"), ("lamp", "lamp"), ("chandelier", "chandelier"),
                 ("sconce", "wall lamp"), ("pendant", "pendant lamp"), ("lighting", "lighting")],
    "Decor & Accessories": [("декор", "decor"), ("аксессуар", "accessories"), ("ваз", "vase"),
                            ("зеркал", "mirror"), ("картин", "painting"), ("посуд", "tableware"), ("книг", "books"),
                            ("decor", "decor"), ("vase", "vase"), ("mirror", "mirror"), ("painting", "painting"),
                            ("accessor", "accessories"), ("tableware", "tableware"), ("books", "books")],
    "Rugs & Curtains": [("ковр", "rug"), ("ковер", "rug"), ("ковёр", "rug"), ("штор", "curtains"),
                        ("rug", "rug"), ("carpet", "rug"), ("curtain", "curtains")],
    "Indoor Plants": [("растени", "plant"), ("цветы", "flowers"), ("цветок", "flower"), ("кашпо", "planter"),
                      ("plant", "plant"), ("flower", "flowers"), ("planter", "planter")],
    "Appliances & Electronics": [("техник", "appliance"), ("холодильник", "fridge"), ("телевизор", "tv"),
                                 ("электроник", "electronics"), ("appliance", "appliance"), ("fridge", "fridge"),
                                 ("tv", "tv"), ("electronics", "electronics")],
    "Doors & Windows": [("двер", "door"), ("окн", "window"), ("door", "door"), ("window", "window")],
    "Wall & Ceiling Elements": [("стенов", "wall panel"), ("потол", "ceiling"), ("молдинг", "moulding"),
                                ("лепнин", "moulding"), ("wall panel", "wall panel"), ("ceiling", "ceiling"),
                                ("moulding", "moulding"), ("molding", "moulding")],
    "Trees & Vegetation": [("дерев", "tree"), ("куст", "bush"), ("пальм", "palm"), ("трав", "grass"),
                           ("tree", "tree"), ("bush", "bush"), ("shrub", "shrub"), ("palm", "palm"), ("grass", "grass")],
    "Vehicles": [("авто", "car"), ("машин", "car"), ("транспорт", "vehicle"), ("велосипед", "bicycle"),
                 ("мотоцикл", "motorcycle"), ("car", "car"), ("vehicle", "vehicle"), ("bicycle", "bicycle"),
                 ("motorcycle", "motorcycle")],
    "Outdoor Furniture": [("уличн", "outdoor"), ("садов", "garden"), ("шезлонг", "sun lounger"),
                          ("outdoor", "outdoor"), ("garden", "garden"), ("lounger", "sun lounger")],
    "Buildings & Facades": [("здани", "building"), ("фасад", "facade"), ("building", "building"),
                            ("facade", "facade")],
    "Street Elements": [("фонар", "street lamp"), ("street", "street"), ("урн", "bin")],
    "Landscape & Hardscape": [("ландшафт", "landscape"), ("landscape", "landscape"), ("бассейн", "pool")],
    "People": [("люди", "people"), ("человек", "person"), ("people", "people"), ("person", "person"),
               ("human", "person")],
}
# Weak signals: used only when no object category matched.
SCENE_WORDS = {
    "Interior Scene": [("интерьер", "interior"), ("гостин", "living room"), ("спальн", "bedroom"),
                       ("interior", "interior"), ("living room", "living room"), ("bedroom", "bedroom")],
    "Exterior Scene": [("экстерьер", "exterior"), ("exterior", "exterior")],
}
STYLE_WORDS = [
    ("Neoclassic", ["неоклассик", "neoclassic", "neo classic"]),
    ("Classic", ["классик", "классическ", "classic"]),
    ("Minimalist", ["минимал", "minimal"]),
    ("Scandinavian", ["сканди", "scandi"]),
    ("Industrial", ["лофт", "loft", "industrial"]),
    ("Japandi", ["japandi", "джапанди"]),
    ("Art Deco", ["ар-деко", "ардеко", "art deco", "artdeco"]),
    ("Mid-Century", ["mid-century", "midcentury", "mid century"]),
    ("Rustic", ["кантри", "rustic", "country"]),
    ("Oriental", ["восточн", "oriental"]),
    ("Modern", ["современ", "модерн", "modern"]),
    ("Contemporary", ["contemporary"]),
]
# Words that never name the object (file names such as "3D Oasis.rar").
GENERIC_TITLE_WORDS = {"3d", "d", "3", "oasis", "model", "models", "max", "archive", "file", "new", "part", "untitled",
                       "rar", "zip", "corona", "vray", "free", "pack", "by", "the"}

_WORD = re.compile(r"[a-zа-яё]+|[0-9]+", re.I)
_HASHTAG = re.compile(r"#([\wа-яё-]+)", re.I)


def _matches(words: list[str], text: str, stem: str) -> bool:
    if " " in stem:
        return stem in text
    if len(stem) <= 3:  # short stems ("tv", "бра", "душ") must match a whole word
        return stem in words
    return any(w.startswith(stem) for w in words)


def _score(table: dict[str, list[tuple[str, str]]], tags: list[str], tag_text: str,
           name_words: list[str], name_text: str, words: list[str], text: str
           ) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Hashtag hit = 3, file-name hit = 2 (+1 for the last word, the head noun), caption hit = 1."""
    scores: dict[str, int] = {}
    labels: dict[str, list[str]] = {}
    last_pos: dict[str, int] = {}
    for cat, stems in table.items():
        for stem, label in stems:
            hit = 0
            if _matches(tags, tag_text, stem):
                hit = 3
            elif _matches(name_words, name_text, stem):
                hit = 2
                pos = max((i for i, w in enumerate(name_words) if w.startswith(stem)), default=-1)
                last_pos[cat] = max(last_pos.get(cat, -1), pos)
            elif _matches(words, text, stem):
                hit = 1
            if hit:
                scores[cat] = scores.get(cat, 0) + hit
                labels.setdefault(cat, [])
                if label not in labels[cat]:
                    labels[cat].append(label)
    if last_pos:
        head = max(last_pos, key=lambda c: last_pos[c])
        scores[head] += 1
    return scores, labels


def rule_classify(item: dict[str, Any], tax: Taxonomy) -> dict[str, Any] | None:
    """A classification dict, or None when the text is not clear enough."""
    text = item_text(item).lower()
    tags = [t.lower() for t in _HASHTAG.findall(text)]
    tag_text = " ".join(tags)
    words = _WORD.findall(text)
    name_text = " ".join(f["name"] for f in item.get("files", [])).lower()
    name_words = _WORD.findall(name_text.replace("_", " "))

    resource = resource_hint(text)
    if resource and resource in tax.all_categories:
        category, label_words = resource, [resource.split(" ")[0].lower()]
    else:
        scores, labels = _score(CATEGORY_WORDS, tags, tag_text, name_words, name_text, words, text)
        if not scores:
            scores, labels = _score(SCENE_WORDS, tags, tag_text, name_words, name_text, words, text)
        if not scores:
            return None
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        best, best_score = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0
        # Need a hashtag hit (3) or two word hits, and a clear winner.
        if best_score < 2 or best_score == second or best not in tax.all_categories:
            return None
        category, label_words = best, labels[best]

    style = "Other"
    for name, stems in STYLE_WORDS:
        if any(_matches(tags, tag_text, s) or _matches(words, text, s) for s in stems):
            style = name
            break
    hints = extract_hints(text)
    title = pretty_title(item)
    title_words = set(_WORD.findall(title.lower()))
    if not title_words or title_words <= GENERIC_TITLE_WORDS or len(title) < 3:
        noun = label_words[0].title() if label_words else category
        title = f"{style} {noun}" if style != "Other" else noun
    return {
        "title": title,
        "group": tax.group_of(category) or "Uncategorized",
        "category": category,
        "style": style if style in tax.styles else "Other",
        "render_engine": hints.get("render_engine", "Unknown"),
        "max_version": hints.get("max_version"),
        "materials": [],
        "colors": [],
        "tags": list(dict.fromkeys([*label_words, *(t for t in tags if len(t) < 24)]))[:10],
        "is_collection": False,
        "confidence": 0.6,
        "source": "rules",
    }
