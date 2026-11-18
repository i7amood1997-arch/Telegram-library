import json
from types import SimpleNamespace

import pytest

from pipeline import crypto
from pipeline.build_index import build_library
from pipeline.classify import (
    Classifier,
    _apply,
    build_request,
    extract_hints,
    needs_classification,
    normalize,
    pretty_title,
    tool_schema,
)
from pipeline.config import MAX_CLASSIFY_ATTEMPTS, load_taxonomy, parse_channels
from pipeline.store import Store, StoreError
from pipeline.thumbnails import make_thumb, thumb_name

TAX = load_taxonomy()


def item(**kw):
    base = {"id": "5:10", "channel_id": 5, "message_ids": [10], "preview_message_id": 9,
            "files": [{"name": "Boucle_Sofa_Corona_max2018.rar", "size": 2_000_000, "ext": "rar",
                       "part": None, "msg_id": 10}],
            "caption": "Sofa model", "posted_at": 1_700_000_000.0}
    base.update(kw)
    return base


GOOD = {"title": "Boucle Sofa", "group": "Exterior", "category": "Sofas & Armchairs",
        "style": "Modern", "render_engine": "V-Ray", "max_version": "2020",
        "materials": ["Fabric", "fabric"], "colors": ["Beige"], "tags": ["Sofa", "#couch"],
        "is_collection": False, "confidence": 1.4}


# ---------- crypto ----------

def test_crypto_roundtrip_and_wrong_password():
    salt = crypto.new_salt()
    blob = crypto.encrypt_json({"a": "مرحبا", "n": [1, 2]}, "pw", salt)
    assert crypto.decrypt_json(blob, "pw") == {"a": "مرحبا", "n": [1, 2]}
    assert crypto.read_salt(blob) == salt
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt_json(blob, "nope")
    assert "مرحبا" not in blob


# ---------- config ----------

def test_parse_channels():
    assert parse_channels("@a, https://t.me/b\n-1001234 c/") == ["a", "b", "-1001234", "c"]


# ---------- classification ----------

def test_hints():
    h = extract_hints("Sofa_Corona_max2018.rar 3ds Max 2021")
    assert h == {"render_engine": "Corona", "max_version": "2018"}
    assert "render_engine" not in extract_hints("corona and vray versions")
    assert extract_hints("no hints")== {}


def test_normalize_coerces_to_taxonomy():
    out = normalize(GOOD, TAX, {"render_engine": "Corona", "max_version": "2018"})
    assert out["group"] == "Interior"  # fixed from the category
    assert out["render_engine"] == "Corona" and out["max_version"] == "2018"
    assert out["materials"] == ["fabric"] and out["tags"] == ["sofa", "couch"]
    assert out["confidence"] == 1.0


def test_normalize_rejects_unknown_category():
    with pytest.raises(ValueError):
        normalize({**GOOD, "category": "Spaceships"}, TAX, {})


def test_apply_failure_falls_back_after_attempts():
    it = item()
    for _ in range(MAX_CLASSIFY_ATTEMPTS):
        assert not _apply(it, None, TAX)
    assert it["classification"]["category"] == "Uncategorized"
    assert not needs_classification(it, TAX)


def test_tool_schema_enums():
    schema = tool_schema(TAX)["input_schema"]["properties"]
    assert "Tables" in schema["category"]["enum"]


def test_build_request_without_thumb(tmp_path):
    req = build_request(item(), "Chan", None, TAX, "m")
    assert req["tool_choice"] == {"type": "tool", "name": "record_classification"}
    assert req["messages"][0]["content"][-1]["type"] == "text"


def test_pretty_title():
    assert pretty_title(item()) == "Boucle Sofa"


def test_classifier_with_mocked_client(tmp_path):
    block = SimpleNamespace(type="tool_use", name="record_classification", input=GOOD)
    client = SimpleNamespace(messages=SimpleNamespace(
        create=lambda **kw: SimpleNamespace(content=[block])))
    clf = Classifier(client, TAX, "m", tmp_path, lambda i: "Chan")
    it = item()
    assert clf.classify_one(it)
    assert it["classification"]["title"] == "Boucle Sofa"
    assert not needs_classification(it, TAX)


# ---------- thumbnails ----------

def test_thumbnail_small_and_opaque():
    from io import BytesIO

    from PIL import Image

    from pipeline.config import THUMB_MAX_EDGE

    buf = BytesIO()
    Image.new("RGB", (1600, 1200), (120, 80, 40)).save(buf, "JPEG")
    out = make_thumb(buf.getvalue())
    img = Image.open(BytesIO(out))
    assert img.format == "WEBP" and max(img.size) == THUMB_MAX_EDGE
    name = thumb_name("secret", "5:10")
    assert name.endswith(".webp") and "5" not in name[:0] and len(name) == 29


# ---------- store + index ----------

def test_store_idempotent_and_rotation(tmp_path):
    s = Store(tmp_path, "pw")
    s.load()
    s.db["items"]["5:10"] = item()
    lib = build_library(s.db, TAX)
    assert s.save(lib, now=1) == {"library": True, "db": True}

    s2 = Store(tmp_path, "pw")
    s2.load()
    assert s2.save(build_library(s2.db, TAX), now=2) == {"library": False, "db": False}

    with pytest.raises(StoreError):
        Store(tmp_path, "wrong").load()

    s3 = Store(tmp_path, "new", old_password="pw")
    s3.load()
    assert s3.rotated
    assert s3.save(build_library(s3.db, TAX), now=3) == {"library": True, "db": True}
    lib_blob = (tmp_path / "library.enc").read_text()
    assert crypto.decrypt_json_multi(lib_blob, "new")["items"][0]["id"] == "5:10"


def test_store_refuses_missing_db(tmp_path):
    (tmp_path / "library.enc").write_text("{}")
    with pytest.raises(StoreError):
        Store(tmp_path, "pw").load()


def test_library_contents():
    db = {"channels": {"5": {"title": "C", "username": "chan", "ref": "chan"}},
          "items": {"5:10": item()}}
    lib = build_library(db, TAX)
    entry = lib["items"][0]
    assert entry["l"] == "https://t.me/chan/10"
    assert entry["g"] == "Uncategorized"
    # Empty optional fields are left out to keep the payload small for phones.
    assert "m" not in entry and "co" not in entry and "col" not in entry
    long = item()
    long["caption"] = "word " * 400
    cap = build_library({"channels": {}, "items": {"5:10": long}}, TAX)["items"][0]["cap"]
    assert len(cap) <= 120
    assert lib["channels"] == [{"id": 5, "title": "C"}]
    assert build_library(db, TAX, active_channel_ids={99})["items"] == []
    json.dumps(lib)


def test_resource_hints_from_names_and_captions():
    from pipeline.classify import resource_hint

    cases = {
        "Wood_PBR_Textures_4k.rar": "Materials & Textures",
        "3D Oasis.rar #Текстуры #Материалы": "Materials & Textures",
        "Sunset_Sky_HDRI_Pack.zip": "HDRI",
        "Corona_Renderer_12_Setup_x64.rar": "3D Software",
        "Autodesk 3ds Max 2025 Win64.iso": "3D Software",
        "FloorGenerator_v3.mzp": "Plugins & Add-ons",
        "RailClone Pro plugin.zip": "Plugins & Add-ons",
        "Interior_Lighting_Course_Part1.rar": "Courses & Tutorials",
        "3D Oasis.rar #Уроки": "Courses & Tutorials",
    }
    for text, expected in cases.items():
        assert resource_hint(text) == expected, text
    for model in ("Boucle_Sofa_Corona.rar #Мебель #Диваны #3dsMax #Corona",
                  "Garden_Tools_Set.rar", "Panoramic_Window.rar", "Updated_Chair.zip"):
        assert resource_hint(model) is None, model


def test_fallback_uses_resource_hint():
    from pipeline.classify import fallback

    it = item(files=[{"name": "Concrete_Seamless_Textures.zip", "size": 1, "ext": "zip",
                      "part": None, "msg_id": 10}], caption="")
    assert fallback(it)["category"] == "Materials & Textures"
    assert fallback(it)["group"] == "Resources"


# ---------- guest passwords ----------

def test_guest_passwords_unlock_library_and_can_be_revoked(tmp_path):
    lib = build_library({"channels": {}, "items": {"5:10": item()}}, TAX)

    s = Store(tmp_path, "owner", guest_passwords=["guest-a", "guest-b"])
    s.load()
    s.save(lib, now=1)
    blob = (tmp_path / "library.enc").read_text()
    for pw in ("owner", "guest-a", "guest-b"):
        assert crypto.decrypt_json_multi(blob, pw)["items"][0]["id"] == "5:10"
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt_json_multi(blob, "stranger")
    # Guests can never open the pipeline state.
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt_json((tmp_path / "db.enc").read_text(), "guest-a")
    key_before = s.db["content_key"]

    # Same passwords, same content: nothing rewritten.
    s2 = Store(tmp_path, "owner", guest_passwords=["guest-b", "guest-a"])
    s2.load()
    assert s2.save(lib, now=2) == {"library": False, "db": False}

    # Revoke guest-a: library re-encrypted with a NEW content key.
    s3 = Store(tmp_path, "owner", guest_passwords=["guest-b"])
    s3.load()
    assert s3.save(lib, now=3)["library"] is True
    blob = (tmp_path / "library.enc").read_text()
    assert s3.db["content_key"] != key_before
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt_json_multi(blob, "guest-a")
    assert crypto.decrypt_json_multi(blob, "guest-b")["items"]
    assert crypto.decrypt_json_multi(blob, "owner")["items"]


def test_guest_passwords_env_parsing(monkeypatch):
    from pipeline.config import Settings

    monkeypatch.setenv("GUEST_PASSWORDS", "first pass\n\n  second-pass  \n")
    assert Settings.from_env().guest_passwords == ["first pass", "second-pass"]
