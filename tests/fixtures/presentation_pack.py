"""A real installed-and-enabled pack carrying a presentation kit (M19).

The Stage Director is kit-gated by design — a module opts into having one by shipping
`ui/presentation.yaml` — so anything that exercises it needs a genuine pack on disk,
installed and enabled for the room. This builds the smallest one that still covers the
kit's whole surface (a subject WITH a 定妆 reference, a subject WITHOUT one, an audio
cue) through the real build/install path, so the tests also prove the pack pipeline
carries kits end to end.
"""

from __future__ import annotations

from pathlib import Path

from core.pack import build_pack, install_pack
from net.session import PROTOCOL_VERSION
from gateway.ops import set_enabled_panel_packs

PACK_ID = "stagekit"

# A 1x1 PNG and a tiny MP3-shaped blob — enough for real digests and MIME sniffing.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8ffff3f0005fe02fea7a0a5810000000049454e44ae426082"
)
MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 64

MANIFEST = """\
id: stagekit
version: 1.0.0
name: {en: Stage Kit, zh: 演出资料包}
description: {en: A fixture module with a presentation kit., zh: 带演出资料包的测试模组。}
authors: [tests]
license: MIT
engine:
  protocol: "2.0"
contents:
  presentation: [ui/presentation.yaml]
assets:
  - {path: assets/wantang.png, title: Wantang portrait}
  - {path: assets/tide.mp3, title: Tide theme}
"""

KIT = """\
version: 1
generation: allow
style:
  keywords: {en: "ink wash, muted indigo", zh: "水墨, 靛青"}
  banned: [text overlays, modern clothing]
subjects:
  - id: wantang
    kind: npc
    name: {en: Gu Wantang, zh: 顾晚棠}
    ref: assets/wantang.png
    prompt: a woman in her thirties, plain dark coat, wet hair
  - id: the-quay
    kind: location
    name: {en: The quay, zh: 石埠}
audio:
  - {id: tide, layer: bgm, asset: assets/tide.mp3, title: 潮涌}
"""


def write_pack_source(root: Path, *, kit: str = KIT, manifest: str = MANIFEST) -> Path:
    """Lay out a pack source tree under ``root`` and return it."""
    source = root / "src"
    (source / "ui").mkdir(parents=True, exist_ok=True)
    (source / "assets").mkdir(parents=True, exist_ok=True)
    (source / "pack.yaml").write_text(manifest, encoding="utf-8")
    (source / "ui" / "presentation.yaml").write_text(kit, encoding="utf-8")
    (source / "assets" / "wantang.png").write_bytes(PNG)
    (source / "assets" / "tide.mp3").write_bytes(MP3)
    return source


async def install_kit_pack(services, chat_key: str, tmp_path: Path, *, kit: str = KIT) -> Path:
    """Build, install and ENABLE the fixture pack for ``chat_key``. Returns its home."""
    source = write_pack_source(tmp_path, kit=kit)
    built = build_pack(source, tmp_path / f"{PACK_ID}.lwpack")
    data_dir = Path(services.settings.data_dir)
    report = install_pack(
        built.path,
        packs_dir=data_dir / "packs",
        skills_dir=data_dir / "skills",
        rulepacks_dir=data_dir / "rulepacks",
        presets_dir=data_dir / "presets",
        current_protocol=PROTOCOL_VERSION,
        current_server="1.0.0",
    )
    await set_enabled_panel_packs(services.store, chat_key, [PACK_ID])
    assert report.pack_dir is not None
    return report.pack_dir
