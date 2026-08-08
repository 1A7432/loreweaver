"""Every media extension the pack format documents must actually build — anywhere.

Asset MIME used to come from `mimetypes.guess_type`, whose answers are drawn from the
build machine's mime database: a stock CPython calls `.wav` `audio/x-wav`, which is not
in `AUDIO_MIMES`, so four of the six documented audio formats were unbuildable and the
other two were only luckily buildable. `docs/protocol.md` promised a list the engine
could not honour. These tests pin the promise per extension, through the real builder.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.hooks import UI_IMAGE_MIMES
from core.pack import PackError, build_pack
from core.presentation import AUDIO_MIMES

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8ffff3f0005fe02fea7a0a5810000000049454e44ae426082"
)
BLOB = b"\x00" * 64

MANIFEST = """\
id: mimekit
version: 1.0.0
name: {en: Mime Kit, zh: MIME 测试}
description: {en: One cue, one extension., zh: 一条 cue，一个扩展名。}
authors: [tests]
license: MIT
engine:
  protocol: "2.0"
contents:
  presentation: [ui/presentation.yaml]
assets:
  - {path: assets/ref.png}
  - {path: assets/cue.EXT}
"""

KIT = """\
version: 1
generation: allow
subjects:
  - id: wantang
    kind: npc
    name: {en: Gu Wantang, zh: 顾晚棠}
    ref: assets/ref.png
audio:
  - {id: tide, layer: bgm, asset: assets/cue.EXT}
"""

# The audio list `docs/protocol.md` documents, and what each must stamp as.
AUDIO_EXTENSIONS = {
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
}
# The image list, via the 定妆 reference (SVG is text, so it gets real bytes below).
IMAGE_EXTENSIONS = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "svg": "image/svg+xml",
}


def _write_source(root: Path, *, audio_ext: str = "mp3", image_ext: str = "png") -> Path:
    source = root / "src"
    (source / "ui").mkdir(parents=True, exist_ok=True)
    (source / "assets").mkdir(parents=True, exist_ok=True)
    manifest = MANIFEST.replace("assets/cue.EXT", f"assets/cue.{audio_ext}").replace(
        "assets/ref.png", f"assets/ref.{image_ext}"
    )
    kit = KIT.replace("assets/cue.EXT", f"assets/cue.{audio_ext}").replace(
        "assets/ref.png", f"assets/ref.{image_ext}"
    )
    (source / "pack.yaml").write_text(manifest, encoding="utf-8")
    (source / "ui" / "presentation.yaml").write_text(kit, encoding="utf-8")
    image = b'<svg xmlns="http://www.w3.org/2000/svg"/>' if image_ext == "svg" else PNG
    (source / "assets" / f"ref.{image_ext}").write_bytes(image)
    (source / "assets" / f"cue.{audio_ext}").write_bytes(BLOB)
    return source


def _stamped_mime(tmp_path: Path, name: str, **kwargs: str) -> dict[str, str]:
    source = _write_source(tmp_path, **kwargs)
    built = build_pack(source, tmp_path / f"{name}.lwpack")
    return {asset.path: asset.mime for asset in built.manifest.assets}


@pytest.mark.parametrize(("extension", "expected"), sorted(AUDIO_EXTENSIONS.items()))
def test_every_documented_audio_extension_builds(tmp_path: Path, extension: str, expected: str) -> None:
    mimes = _stamped_mime(tmp_path, extension, audio_ext=extension)
    assert mimes[f"assets/cue.{extension}"] == expected
    assert expected in AUDIO_MIMES


@pytest.mark.parametrize(("extension", "expected"), sorted(IMAGE_EXTENSIONS.items()))
def test_every_documented_image_extension_builds(tmp_path: Path, extension: str, expected: str) -> None:
    mimes = _stamped_mime(tmp_path, extension, image_ext=extension)
    assert mimes[f"assets/ref.{extension}"] == expected
    assert expected in UI_IMAGE_MIMES


def test_an_undocumented_extension_still_fails_the_kit_gate(tmp_path: Path) -> None:
    """The table widens what builds; it does not turn the gate off."""
    with pytest.raises(PackError, match="not audio"):
        _stamped_mime(tmp_path, "txt", audio_ext="txt")
