"""`core.preset_store` — disk persistence for imported ST presets (never breaks a turn)."""

from __future__ import annotations

import json

from core.preset import MAX_PRESET_BYTES
from core.preset_store import (
    list_preset_ids,
    load_preset,
    presets_dir,
    sanitize_preset_id,
    save_preset_text,
)

_PRESET = {
    "temperature": 0.9,
    "prompts": [
        {"identifier": "main", "name": "Main", "content": "Write plainly.", "role": "system", "enabled": True},
        {"identifier": "chatHistory", "name": "History", "content": "", "marker": True},
    ],
    "prompt_order": [
        {
            "character_id": 100001,
            "order": [{"identifier": "main", "enabled": True}, {"identifier": "chatHistory", "enabled": True}],
        }
    ],
}


def test_sanitize_preset_id_slugs_and_falls_back():
    assert sanitize_preset_id("双人成行v10.0—青云上.json") == "v10-0"
    assert sanitize_preset_id("My Great Preset (final).json") == "my-great-preset-final"
    assert sanitize_preset_id("青云上.json") == "preset"  # nothing latin survives
    assert sanitize_preset_id("") == ""


def test_save_load_roundtrip_and_listing(tmp_path):
    text = json.dumps(_PRESET, ensure_ascii=False)
    path = save_preset_text(tmp_path, "qingyun", text)
    assert path == presets_dir(tmp_path) / "qingyun.json"
    assert list_preset_ids(tmp_path) == ["qingyun"]

    preset = load_preset(tmp_path, "qingyun")
    assert preset is not None
    assert preset.sampling["temperature"] == 0.9
    assert [prompt.identifier for prompt in preset.prompts] == ["main", "chatHistory"]


def test_load_preset_degrades_to_none_on_any_failure(tmp_path):
    assert load_preset(tmp_path, "missing") is None
    assert load_preset(tmp_path, "../etc/passwd") is None  # not a preset id at all
    save_preset_text(tmp_path, "broken", "not json {{{")
    assert load_preset(tmp_path, "broken") is None
    oversized = presets_dir(tmp_path) / "huge.json"
    oversized.write_bytes(b"x" * (MAX_PRESET_BYTES + 1))
    assert load_preset(tmp_path, "huge") is None


def test_save_preset_text_rejects_bad_ids(tmp_path):
    import pytest

    with pytest.raises(ValueError):
        save_preset_text(tmp_path, "Bad Id!", "{}")
