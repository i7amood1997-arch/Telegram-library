from pipeline.grouping import (
    Msg,
    deep_link,
    group_messages,
    is_archive,
    new_channel_state,
    parse_archive_name,
)

T0 = 1_700_000_000.0
CH = 1234


def photo(i, text="", gid=None, dt=0):
    return Msg(id=i, date=T0 + dt, kind="photo", text=text, grouped_id=gid)


def arch(i, name, text="", gid=None, dt=0, size=100):
    return Msg(id=i, date=T0 + dt, kind="archive", file_name=name, text=text, grouped_id=gid,
               size=size)


def run(msgs, state=None, items=None):
    state = state if state is not None else new_channel_state()
    items = items if items is not None else {}
    res = group_messages(CH, msgs, state, items)
    return res, state, items


# ---------- name parsing ----------

def test_parse_part_patterns():
    assert parse_archive_name("Sofa_Boucle.part1.rar").part == 1
    assert parse_archive_name("Sofa_Boucle.part02.rar").base == "sofa boucle"
    assert parse_archive_name("Tree.z01").ext == "zip"
    assert parse_archive_name("Tree.zip").part is None
    assert parse_archive_name("Kitchen.7z.002").part == 2
    assert parse_archive_name("Lamp (3).rar").part == 3
    assert parse_archive_name("Lamp part 2.zip").part == 2
    assert parse_archive_name("model.max").ext == "max"
    assert parse_archive_name("readme.txt") is None


def test_is_archive():
    assert is_archive("a.rar") and is_archive("a.r00") and is_archive("a.7z.001")
    assert not is_archive("preview.jpg")


# ---------- grouping ----------

def test_photo_then_archive():
    res, _, items = run([photo(1, "Nice sofa"), arch(2, "sofa.rar", "#sofa")])
    assert res.new_ids == ["1234:2"]
    item = items["1234:2"]
    assert item["preview_message_id"] == 1
    assert "Nice sofa" in item["caption"] and "#sofa" in item["caption"]


def test_two_models_each_with_photo():
    _, _, items = run([photo(1), arch(2, "chair.rar"), photo(3), arch(4, "table.rar")])
    assert items["1234:2"]["preview_message_id"] == 1
    assert items["1234:4"]["preview_message_id"] == 3


def test_multipart_archives_merge():
    res, _, items = run([photo(1), arch(2, "kitchen.part1.rar"), arch(3, "kitchen.part2.rar"),
                         arch(4, "kitchen.part3.rar")])
    assert res.new_ids == ["1234:2"]
    assert [f["part"] for f in items["1234:2"]["files"]] == [1, 2, 3]


def test_zip_split_merge():
    _, _, items = run([photo(1), arch(2, "tree.z01"), arch(3, "tree.z02"), arch(4, "tree.zip")])
    assert len(items) == 1
    assert [f["name"] for f in items["1234:2"]["files"]] == ["tree.z01", "tree.z02", "tree.zip"]


def test_album_groups_together():
    msgs = [photo(1, gid=9), arch(2, "a.rar", gid=9), arch(3, "totally_other.rar", gid=9)]
    _, _, items = run(msgs)
    assert len(items) == 1
    assert items["1234:2"]["message_ids"] == [2, 3]


def test_orphan_archive_without_photo():
    _, _, items = run([arch(5, "lonely.rar")])
    assert items["1234:5"]["preview_message_id"] is None


def test_photo_too_far_is_not_used():
    _, _, items = run([photo(1), arch(40, "far.rar")])
    assert items["1234:40"]["preview_message_id"] is None
    _, _, items = run([photo(1), arch(2, "late.rar", dt=7 * 3600)])
    assert items["1234:2"]["preview_message_id"] is None


def test_different_archives_after_one_photo_share_preview():
    _, _, items = run([photo(1), arch(2, "armchair.rar"), arch(3, "bathtub.rar")])
    assert len(items) == 2
    assert items["1234:2"]["preview_message_id"] == 1
    assert items["1234:3"]["preview_message_id"] == 1


def test_similar_names_after_one_photo_merge():
    _, _, items = run([photo(1), arch(2, "Sofa_Set_Max2018.rar"), arch(3, "Sofa_Set_Max2015.rar")])
    assert len(items) == 1


def test_same_name_new_photo_is_new_item():
    _, _, items = run([photo(1), arch(2, "sofa.rar"), photo(3), arch(4, "sofa.rar")])
    assert len(items) == 2


def test_state_carries_across_runs():
    state, items = new_channel_state(), {}
    run([photo(10, "Preview")], state, items)
    assert items == {}
    res, _, _ = run([arch(11, "model.part1.rar")], state, items)
    assert items["1234:11"]["preview_message_id"] == 10
    res, _, _ = run([arch(12, "model.part2.rar")], state, items)
    assert res.updated_ids == ["1234:11"] and res.new_ids == []
    assert len(items["1234:11"]["files"]) == 2


def test_non_archive_documents_ignored():
    _, _, items = run([photo(1), Msg(id=2, date=T0, kind="other")])
    assert items == {}


def test_state_is_json_serializable():
    import json

    _, state, items = run([photo(1), arch(2, "x.rar")])
    json.dumps(state)
    json.dumps(items)


def test_deep_links():
    assert deep_link(1, "somechannel", 5) == "https://t.me/somechannel/5"
    assert deep_link(1500000000, None, 7) == "https://t.me/c/1500000000/7"


def test_resource_file_types():
    for name in ("Sunset_8k.hdr", "Sky.exr", "FloorGenerator.mzp", "script.ms", "Setup.exe",
                 "Fabric.sbsar"):
        assert is_archive(name), name
    _, _, items = run([photo(1), arch(2, "Sunset_Sky_8k.hdr")])
    assert items["1234:2"]["files"][0]["ext"] == "hdr"
