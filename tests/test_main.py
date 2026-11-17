"""End-to-end pipeline run with a fake Telegram client (no network)."""

import io
from types import SimpleNamespace

from PIL import Image

from pipeline import crypto
from pipeline import main as pm
from pipeline import telegram_client as tc
from pipeline.grouping import Msg

T0 = 1_700_000_000.0


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (900, 700), (90, 120, 60)).save(buf, "JPEG")
    return buf.getvalue()


class FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def install_fakes(monkeypatch, feed):
    entity = SimpleNamespace(id=777, title="Secret Channel", username=None)

    async def resolve(self, ref):
        return entity

    async def fetch_new(client, ent, min_id, deadline, limit=None):
        msgs = [m for m in feed if m.id > min_id]
        return msgs, {}

    async def download_photos(client, entities, items, cache, deadline, on_result):
        for it in items:
            on_result(it, _jpeg(), None)

    monkeypatch.setattr(tc, "make_client", lambda *a: FakeClient())
    monkeypatch.setattr(tc.ChannelResolver, "resolve", resolve)
    monkeypatch.setattr(tc, "fetch_new", fetch_new)
    monkeypatch.setattr(tc, "download_photos", download_photos)


def env(monkeypatch):
    for k, v in {"TG_API_ID": "1", "TG_API_HASH": "h", "TG_SESSION": "s", "TG_CHANNELS": "777",
                 "SITE_PASSWORD": "pw", "THUMB_SECRET": "ts", "ANTHROPIC_API_KEY": ""}.items():
        monkeypatch.setenv(k, v)


def test_sync_end_to_end(tmp_path, monkeypatch, capsys):
    env(monkeypatch)
    out_file = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out_file))
    feed = [Msg(1, T0, "photo", text="Lovely sofa"),
            Msg(2, T0 + 5, "archive", file_name="Lovely_Sofa_corona.rar", size=5_000_000)]
    install_fakes(monkeypatch, feed)

    assert pm.main(["sync", "--data-dir", str(tmp_path)]) == 0
    lib = crypto.decrypt_json((tmp_path / "library.enc").read_text(), "pw")
    assert len(lib["items"]) == 1
    it = lib["items"][0]
    assert it["th"] and (tmp_path / "thumbs" / it["th"]).exists()
    assert it["l"] == "https://t.me/c/777/2"
    assert it["r"] == "Corona"  # regex hint used even without Claude
    assert "changed=true" in out_file.read_text()

    # Logs must not leak library content.
    logs = capsys.readouterr()
    for secret in ("Lovely", "Secret Channel", "Sofa"):
        assert secret not in logs.out + logs.err

    # Second run, nothing new: no file changes.
    before = {p.name: p.stat().st_mtime_ns for p in tmp_path.glob("*.enc")}
    out_file.write_text("")
    assert pm.main(["sync", "--data-dir", str(tmp_path)]) == 0
    assert "changed=false" in out_file.read_text()
    assert before == {p.name: p.stat().st_mtime_ns for p in tmp_path.glob("*.enc")}

    # A later part arrives in the next run and merges into the same item.
    feed.append(Msg(3, T0 + 9, "archive", file_name="Lovely_Sofa_corona.zip", size=1))
    assert pm.main(["sync", "--data-dir", str(tmp_path)]) == 0
    lib = crypto.decrypt_json((tmp_path / "library.enc").read_text(), "pw")
    assert len(lib["items"]) == 1 and len(lib["items"][0]["f"]) == 2


def test_missing_config_fails(tmp_path, monkeypatch):
    for k in ("SITE_PASSWORD", "TG_SESSION"):
        monkeypatch.delenv(k, raising=False)
    assert pm.main(["sync", "--data-dir", str(tmp_path)]) == 2


def test_wrong_password_does_not_overwrite(tmp_path, monkeypatch):
    env(monkeypatch)
    install_fakes(monkeypatch, [Msg(2, T0, "archive", file_name="a.rar", size=1)])
    assert pm.main(["sync", "--data-dir", str(tmp_path)]) == 0
    original = (tmp_path / "db.enc").read_text()
    monkeypatch.setenv("SITE_PASSWORD", "different")
    assert pm.main(["sync", "--data-dir", str(tmp_path)]) == 3
    assert (tmp_path / "db.enc").read_text() == original


# ---------- concurrent thumbnail downloads ----------

def test_best_photo_size_picks_smallest_large_enough():
    sizes = [SimpleNamespace(type="s", w=90, h=67), SimpleNamespace(type="m", w=320, h=240),
             SimpleNamespace(type="x", w=800, h=600), SimpleNamespace(type="y", w=1280, h=960),
             SimpleNamespace(type="i")]  # stripped size without dimensions
    assert tc.best_photo_size(SimpleNamespace(sizes=sizes)).type == "x"
    assert tc.best_photo_size(SimpleNamespace(sizes=sizes[:2])).type == "m"


def test_download_photos_prefetches_and_reports(monkeypatch):
    import asyncio
    import time as _time

    photo = SimpleNamespace(sizes=[SimpleNamespace(w=800, h=600)])
    calls = {"get": 0, "download": 0}

    class Client:
        async def get_messages(self, entity, ids):
            calls["get"] += 1
            # id 99 was deleted; id 50 is a text message
            return [None if i == 99 else SimpleNamespace(id=i, photo=None if i == 50 else photo)
                    for i in ids]

        async def download_media(self, msg, file, thumb):
            calls["download"] += 1
            assert thumb.w == 800
            return b"img"

    items = [{"id": f"1:{i}", "channel_id": 1, "preview_message_id": i}
             for i in [10, 11, 50, 99]]
    results = {}
    cache = {(1, 10): SimpleNamespace(id=10, photo=photo)}  # already fetched this run
    asyncio.run(tc.download_photos(Client(), {1: object()}, items, cache, _time.time() + 60,
                                   lambda it, d, e: results.__setitem__(it["id"], (d, e))))
    assert calls["get"] == 1 and calls["download"] == 2
    assert results == {"1:10": (b"img", None), "1:11": (b"img", None),
                       "1:50": (None, None), "1:99": (None, None)}


def test_download_photos_respects_deadline():
    import asyncio
    import time as _time

    class Client:
        async def get_messages(self, entity, ids):
            raise AssertionError("should not fetch after deadline")

    asyncio.run(tc.download_photos(Client(), {1: object()},
                                   [{"id": "1:1", "channel_id": 1, "preview_message_id": 1}],
                                   {}, _time.time() - 1, lambda *a: None))
