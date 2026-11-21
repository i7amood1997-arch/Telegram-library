"""Free rule-based classification and the grouped low-cost Claude classifier."""

from types import SimpleNamespace

import pytest

from pipeline.config import load_taxonomy
from pipeline.lite import GROUP_SIZE, LiteClassifier, apply_entry, build_group_request
from pipeline.main import classify_with_rules, restore_ai_classifications
from pipeline.rules import rule_classify

TAX = load_taxonomy()


def item(name="3D Oasis.rar", caption="", iid="1:1", thumb=None):
    return {"id": iid, "channel_id": 1, "message_ids": [1], "preview_message_id": None,
            "files": [{"name": name, "size": 1, "ext": "rar", "part": None, "msg_id": 1}],
            "caption": caption, "posted_at": 0.0, "thumb": thumb}


@pytest.mark.parametrize(("name", "caption", "category", "title"), [
    ("3D Oasis.rar", "#Мебель #Диваны #3dsMax #Corona #Vray", "Sofas", "Sofa"),
    ("3D Oasis.rar", "#Мебель #Столы #Corona", "Tables", "Table"),
    ("3D Oasis.rar", "#Свет #Люстры #Неоклассика", "Lighting", "Neoclassic Chandelier"),
    ("3D Oasis.rar", "#Кухня #Современный", "Kitchens", "Modern Kitchen"),
    ("Boucle_Sofa_Corona.rar", "", "Sofas", "Boucle Sofa"),
    ("Table lamp.rar", "", "Lighting", "Table Lamp"),
    ("Wood_PBR_Textures.rar", "", "Materials & Textures", None),
    ("3D Oasis.rar", "#Интерьер #Гостиная", "Interior Scene", None),
])
def test_rules_classify_clear_posts(name, caption, category, title):
    cls = rule_classify(item(name, caption), TAX)
    assert cls is not None and cls["category"] == category
    assert cls["group"] == TAX.group_of(category)
    if title:
        assert cls["title"] == title


@pytest.mark.parametrize(("name", "caption"), [
    ("model_8837.rar", ""),
    ("3D Oasis.rar", "#3dsMax #Corona"),
])
def test_rules_skip_unclear_posts(name, caption):
    assert rule_classify(item(name, caption), TAX) is None


def test_rules_pass_marks_items_and_skips_batched():
    db = {"items": {"1:1": item(caption="#Диваны"), "1:2": item(caption="#Диваны", iid="1:2"),
                    "1:3": item("x.rar", iid="1:3")}}
    stats = {"rules_classified": 0}
    classify_with_rules(db, TAX, {"1:2"}, stats)
    assert stats["rules_classified"] == 1
    assert db["items"]["1:1"]["prompt_version"] == "rules"
    assert "classification" not in db["items"]["1:2"]  # already in a batch
    assert "classification" not in db["items"]["1:3"]  # unclear


def test_restore_keeps_paid_ai_classifications():
    paid = item(iid="a")
    paid.update(classification={"category": "Tables"}, prompt_version=1)
    rules_only = item(iid="b")
    rules_only.update(classification={"category": "Tables"}, prompt_version=None)
    db = {"items": {"a": paid, "b": rules_only}}
    assert restore_ai_classifications(db, TAX) == 1
    assert paid["taxonomy_version"] == TAX.version
    assert "taxonomy_version" not in rules_only


def test_group_request_is_compact(tmp_path):
    items = [item(f"m{i}.rar", "#x", iid=f"1:{i}") for i in range(GROUP_SIZE)]
    req = build_group_request(items, tmp_path, TAX, "m")
    texts = [c["text"] for c in req["messages"][0]["content"] if c["type"] == "text"]
    assert len(texts) == GROUP_SIZE and texts[0].startswith("Item 0")
    assert req["tool_choice"]["name"] == "record_items"
    assert "Categories:" in req["system"]


def test_apply_entry_codes_and_failure():
    it = item("Boucle_Sofa_corona_max2018.rar")
    sofa = TAX.all_categories.index("Sofas")
    modern = TAX.styles.index("Modern")
    entry = {"i": 0, "c": sofa, "s": modern, "t": "Boucle Sofa", "g": ["Sofa", "boucle"]}
    assert apply_entry(it, entry, TAX)
    c = it["classification"]
    assert c["category"] == "Sofas" and c["style"] == "Modern"
    assert c["render_engine"] == "Corona" and c["max_version"] == "2018"  # free regex hints
    bad = item(iid="2")
    for _ in range(3):
        assert not apply_entry(bad, {"i": 0, "c": 999, "s": 0, "t": "x"}, TAX)
    assert bad["classification"]["category"] == "Uncategorized"


def test_lite_classifier_groups_items(tmp_path):
    calls = []
    sofa = TAX.all_categories.index("Sofas")

    def create(**req):
        n = sum(1 for c in req["messages"][0]["content"] if c["type"] == "text")
        calls.append(n)
        entries = [{"i": i, "c": sofa, "s": 0, "t": f"Sofa {i}", "g": ["sofa"]} for i in range(n)]
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", name="record_items",
                                                        input={"items": entries})])

    client = SimpleNamespace(messages=SimpleNamespace(create=create))
    items = [item(iid=f"1:{i}") for i in range(20)]
    done = LiteClassifier(client, TAX, "m", tmp_path).classify_now(items, deadline=1e12)
    assert done == 20
    assert calls == [5, 5, 5, 5]  # 4 requests instead of 20


def test_api_errors_do_not_burn_attempts(tmp_path):
    calls = []

    class BadRequest(Exception):
        status_code = 400
        body = {"error": {"message": "Your credit balance is too low"}}

    def create(**req):
        calls.append(1)
        raise BadRequest()

    client = SimpleNamespace(messages=SimpleNamespace(create=create))
    items = [item(iid=f"1:{i}") for i in range(80)]
    assert LiteClassifier(client, TAX, "m", tmp_path).classify_now(items, deadline=1e12) == 0
    assert len(calls) == 3  # stops early instead of sending every group
    assert all("classify_attempts" not in it and "classification" not in it for it in items)


def test_thumbs_shrink_and_ai_image(tmp_path):
    from PIL import Image

    from pipeline.config import AI_IMAGE_EDGE, THUMB_MAX_EDGE
    from pipeline.thumbnails import ai_image, shrink_thumbs

    big = tmp_path / "a.webp"
    Image.effect_noise((480, 360), 60).convert("RGB").save(big, "WEBP", quality=70)
    small = tmp_path / "b.webp"
    Image.new("RGB", (200, 150), "red").save(small, "WEBP")
    small_bytes = small.read_bytes()
    n, saved = shrink_thumbs(tmp_path, deadline=1e12)
    assert n == 1 and saved > 0
    with Image.open(big) as im:
        assert max(im.size) == THUMB_MAX_EDGE
    assert small.read_bytes() == small_bytes
    import io
    with Image.open(io.BytesIO(ai_image(big, AI_IMAGE_EDGE))) as im:
        assert max(im.size) == AI_IMAGE_EDGE


def test_rules_need_tag_or_name_evidence():
    # Caption words alone are too loose: "стол" and "стулья" in a description go to Claude.
    assert rule_classify(item("3D Oasis.rar", "Кухня в стиле, стол и стулья, стол"), TAX) is None


def test_uncategorized_and_weak_rules_are_retried():
    weak = item("3D Oasis.rar", "стол и ещё стол", iid="w")
    weak.update(classification={"category": "Tables"}, prompt_version="rules", taxonomy_version=1)
    unc = item(iid="u")
    unc.update(classification={"category": "Uncategorized"}, taxonomy_version=1)
    db = {"items": {"w": weak, "u": unc}, "batches": [], "channels": {},
          "migrations": ["restore_ai_classified_v1"]}
    from collections import defaultdict

    from pipeline.config import Settings
    from pipeline.main import classify

    store = SimpleNamespace(db=db, thumbs_dir=None)
    classify(Settings(), store, TAX, 1e12, defaultdict(int))
    assert "classification" not in weak and "classification" not in unc


def test_rules_tell_sofas_from_armchairs():
    cls = rule_classify(item("3D Oasis.rar", "#Мебель #Кресла #Corona"), TAX)
    assert cls["category"] == "Armchairs"
    assert rule_classify(item("Lounge_armchair.rar"), TAX)["category"] == "Armchairs"
    assert rule_classify(item("Chesterfield_sofa.rar"), TAX)["category"] == "Sofas"


def test_taxonomy_migration_splits_and_keeps(monkeypatch):
    from collections import defaultdict

    from pipeline.main import migrate_taxonomy

    def old(iid, title, category, caption=""):
        it = item(iid=iid, caption=caption)
        it.update(classification={"title": title, "category": category, "group": "Interior"},
                  taxonomy_version=1, prompt_version="lite-2")
        return it

    items = {
        "a": old("a", "Boucle Sofa", "Sofas & Armchairs"),
        "b": old("b", "Lounge Armchair", "Sofas & Armchairs"),
        "c": old("c", "Sofa with Armchair Set", "Sofas & Armchairs"),
        "d": old("d", "Velvet Piece", "Sofas & Armchairs"),           # unclear -> Claude
        "e": old("e", "Oak Table", "Tables"),                         # unchanged, no API
    }
    stats = defaultdict(int)
    migrate_taxonomy({"items": items}, TAX, stats)
    assert items["a"]["classification"]["category"] == "Sofas"
    assert items["b"]["classification"]["category"] == "Armchairs"
    assert items["c"]["classification"]["category"] == "Sofas"
    assert "classification" not in items["d"]
    assert items["e"]["classification"]["category"] == "Tables"
    assert items["e"]["taxonomy_version"] == TAX.version
    assert stats["taxonomy_split"] == 3 and stats["taxonomy_to_ai"] == 1
    assert stats["taxonomy_kept"] == 1


def test_legacy_batch_codes_use_old_category_list():
    from pipeline.lite import LEGACY_CATS_V1, apply_entry

    it = item(iid="x")
    assert apply_entry(it, {"i": 0, "c": 1, "s": 0, "t": "Bar Stool"}, TAX, LEGACY_CATS_V1)
    assert it["classification"]["category"] == "Chairs & Stools"


def test_uncategorized_items_are_retried_later():
    from collections import defaultdict

    from pipeline.main import retry_uncategorized

    it = item(iid="u")
    it.update(classification={"category": "Uncategorized"}, taxonomy_version=2)
    db = {"items": {"u": it}}
    stats = defaultdict(int)
    retry_uncategorized(db, stats, now=1000)
    assert "classification" not in it and stats["uncategorized_retried"] == 1
    it.update(classification={"category": "Uncategorized"}, taxonomy_version=2)
    retry_uncategorized(db, stats, now=2000)   # too soon: left alone
    assert it["classification"]["category"] == "Uncategorized"
