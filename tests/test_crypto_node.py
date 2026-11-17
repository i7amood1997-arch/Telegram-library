"""Cross-language check: Python encrypts, the browser decryption code (run in Node) decrypts."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from pipeline import crypto

WEB = Path(__file__).resolve().parent.parent / "web"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_python_to_browser_roundtrip(tmp_path):
    payload = {"items": [{"t": "Boucle Sofa", "cap": "مرحبا ✓"}], "n": 3}
    blob = tmp_path / "library.enc"
    blob.write_text(crypto.encrypt_json(payload, "s3cret", crypto.new_salt()))
    out = subprocess.run(["node", "scripts/decrypt.mjs", str(blob), "s3cret"], cwd=WEB,
                         capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == payload
    bad = subprocess.run(["node", "scripts/decrypt.mjs", str(blob), "wrong"], cwd=WEB,
                         capture_output=True, text=True)
    assert bad.returncode != 0


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_multi_password_envelope_in_browser_code(tmp_path):
    payload = {"items": [{"t": "HDRI Pack"}]}
    salt = crypto.new_salt()
    blob = tmp_path / "library.enc"
    blob.write_text(crypto.encrypt_json_multi(payload, ["owner", "guest one", "guest-2"], salt,
                                              crypto.new_content_key()))
    for pw in ("owner", "guest one", "guest-2"):
        out = subprocess.run(["node", "scripts/decrypt.mjs", str(blob), pw], cwd=WEB,
                             capture_output=True, text=True, check=True)
        assert json.loads(out.stdout) == payload
    bad = subprocess.run(["node", "scripts/decrypt.mjs", str(blob), "nope"], cwd=WEB,
                         capture_output=True, text=True)
    assert bad.returncode != 0
