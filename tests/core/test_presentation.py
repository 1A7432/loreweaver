"""Tests for core.presentation — the M19 presentation-kit schema.

Author-time strict, exactly like `core.panels`: an unknown key or a bad enum is an
error the packer reports, never a silent drop that leaves an author wondering why
their module looks wrong at the table.
"""

from __future__ import annotations

import pytest

from core.presentation import parse_presentation_text

KIT = """\
version: 2
generation: allow
style:
  keywords: {en: "ink wash, muted indigo", zh: "水墨, 靛青"}
  banned: [text overlays, modern clothing]
subjects:
  - id: wantang
    kind: npc
    name: {en: Gu Wantang, zh: 顾晚棠}
    ref: assets/wantang.png
    prompt: a woman in her thirties, plain dark coat
  - id: the-quay
    kind: location
    name: 石埠
audio:
  - {id: tide, layer: bgm, asset: assets/tide.mp3, title: 潮涌}
  - {id: sting, layer: sfx, asset: assets/sting.mp3}
"""


def test_kit_parses_subjects_cues_and_style():
    kit = parse_presentation_text(KIT)

    assert kit.generates is True
    assert kit.style_for("zh") == "水墨, 靛青" and kit.style_for("en") == "ink wash, muted indigo"
    assert kit.banned == ("text overlays", "modern clothing")

    wantang = kit.subject("wantang")
    assert wantang is not None and wantang.kind == "npc"
    assert wantang.display_name("zh") == "顾晚棠" and wantang.display_name("en") == "Gu Wantang"
    assert wantang.ref == "assets/wantang.png"

    # A subject may exist without a reference: nameable in a caption, never generated.
    quay = kit.subject("the-quay")
    assert quay is not None and quay.ref == ""

    tide = kit.cue("tide")
    assert tide is not None and tide.layer == "bgm" and tide.title == "潮涌"
    assert kit.cue("sting") is not None and kit.cue("nope") is None


def test_asset_paths_are_what_the_pack_build_must_digest():
    kit = parse_presentation_text(KIT)
    assert kit.asset_paths == ("assets/wantang.png", "assets/tide.mp3", "assets/sting.mp3")


def test_pack_only_is_the_author_veto():
    kit = parse_presentation_text(KIT.replace("generation: allow", "generation: pack_only"))
    assert kit.generates is False
    # The subjects are still declared — they are simply never generated.
    assert kit.subject("wantang") is not None


def test_schema_rejections_are_author_actionable():
    cases = [
        ("version: 1\n", "version must be 2"),
        ("version: 2\ngeneration: sometimes\n", "generation"),
        ("version: 2\nmood: dark\n", "unknown keys"),
        ("version: 2\nsubjects: [{id: A, kind: npc, name: x}]\n", "lowercase slug"),
        ("version: 2\nsubjects: [{id: a, kind: monster, name: x}]\n", "kind"),
        ("version: 2\nsubjects: [{id: a, kind: npc, name: x, ref: /etc/passwd}]\n", "relative path"),
        ("version: 2\nsubjects: [{id: a, kind: npc, name: x, ref: ../x.png}]\n", ".. segments"),
        ("version: 2\naudio: [{id: a, layer: voice, asset: x.mp3}]\n", "layer"),
        ("version: 2\nsubjects: [{id: a, kind: npc, name: x}, {id: a, kind: npc, name: y}]\n", "duplicate"),
        ("version: 2\nstyle: {keywords: {fr: bleu}}\n", "unknown locale"),
    ]
    for text, expected in cases:
        with pytest.raises(ValueError, match=expected):
            parse_presentation_text(text)


def test_an_empty_kit_is_valid_but_stages_nothing():
    kit = parse_presentation_text("version: 2\n")
    assert kit.subjects == () and kit.audio == () and kit.asset_paths == ()
    assert kit.style_for("en") == ""


# --- pack-level: the kit rides the content-addressed pipeline ----------------


async def test_kit_assets_are_digested_disclosed_and_reachable(tmp_path):
    """The kit's refs and cues are ordinary pack files: the build digests them, the
    trust card discloses the imagegen exposure, and install lands the kit in the
    pack home where the room view reads it."""
    from agent.services import build_services
    from gateway.presentation import load_room_kit
    from infra.config import Settings
    from infra.embeddings import FakeEmbeddings
    from infra.llm import FakeLLM
    from tests.fixtures.presentation_pack import install_kit_pack

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    home = await install_kit_pack(services, "room", tmp_path)

    assert (home / "ui" / "presentation.yaml").is_file()

    room_kit = await load_room_kit(services, "room", "zh")
    assert bool(room_kit) is True
    wantang = room_kit.subject("wantang")
    assert wantang is not None and wantang.generatable is True
    assert room_kit.subject("the-quay").generatable is False  # declared, no ref
    tide = room_kit.cue("tide")
    assert tide is not None and len(tide.hash) == 64 and tide.audio_item()["title"] == "潮涌"
    assert room_kit.style == ("水墨, 靛青",)


async def test_a_pack_the_room_has_not_enabled_contributes_no_kit(tmp_path):
    from agent.services import build_services
    from gateway.ops import set_enabled_panel_packs
    from gateway.presentation import load_room_kit
    from infra.config import Settings
    from infra.embeddings import FakeEmbeddings
    from infra.llm import FakeLLM
    from tests.fixtures.presentation_pack import install_kit_pack

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    await install_kit_pack(services, "room", tmp_path)
    await set_enabled_panel_packs(services.store, "room", [])

    # Install ≠ enable, for kits exactly as for panels.
    assert bool(await load_room_kit(services, "room", "zh")) is False


async def test_a_ref_that_is_not_an_image_fails_the_build(tmp_path):
    from core.pack import PackError, build_pack
    from tests.fixtures.presentation_pack import KIT, write_pack_source

    broken = KIT.replace("ref: assets/wantang.png", "ref: assets/tide.mp3")
    source = write_pack_source(tmp_path, kit=broken)
    with pytest.raises(PackError, match="not an image"):
        build_pack(source, tmp_path / "broken.lwpack")


# --- v2: the templates allowlist and the palette ------------------------------


def test_v2_templates_and_palette_parse_and_gate():
    kit = parse_presentation_text(
        "version: 2\n"
        "templates: [title_card, letter]\n"
        "style:\n"
        '  palette: ["#16232e", wet slate blue]\n'
    )
    assert kit.templates == ("title_card", "letter")
    assert kit.palette == ("#16232e", "wet slate blue")
    assert kit.allows_template("title_card") and kit.allows_template("letter")
    assert not kit.allows_template("image") and not kit.allows_template("clipping")

    # Omitted templates = every shape allowed (the permissive default keeps v1 behavior).
    open_kit = parse_presentation_text("version: 2\n")
    assert open_kit.templates == () and open_kit.palette == ()
    for kind in ("image", "title_card", "letter", "clipping", "text"):
        assert open_kit.allows_template(kind)


def test_v2_rejections_are_author_actionable():
    cases = [
        ("version: 2\ntemplates: [poster]\n", "templates"),
        ("version: 2\ntemplates: [letter, letter]\n", "listed twice"),
        ("version: 2\nstyle: {palette: [{}]}\n", "palette"),
        ("version: 2\nstyle: {palette: [" + ", ".join(["a"] * 9) + "]}\n", "at most 8"),
    ]
    for text, expected in cases:
        with pytest.raises(ValueError, match=expected):
            parse_presentation_text(text)


async def test_room_kit_intersects_templates_and_unions_palette(tmp_path):
    """Two enabled packs: the room's template set is the INTERSECTION of the declaring
    kits (most-restrictive-wins, like the `generates` AND), the palette the union."""
    from pathlib import Path

    from agent.services import build_services
    from core.pack import build_pack, install_pack
    from gateway.ops import set_enabled_panel_packs
    from gateway.presentation import load_room_kit
    from infra.config import Settings
    from infra.embeddings import FakeEmbeddings
    from infra.llm import FakeLLM
    from net.session import PROTOCOL_VERSION

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    data_dir = Path(settings.data_dir)

    def _kit_pack(pack_id: str, templates: str, palette: str) -> None:
        src = tmp_path / f"src-{pack_id}"
        (src / "ui").mkdir(parents=True)
        (src / "ui/presentation.yaml").write_text(
            f"version: 2\ntemplates: [{templates}]\nstyle:\n  palette: [{palette}]\n",
            encoding="utf-8",
        )
        (src / "pack.yaml").write_text(
            f"id: {pack_id}\nversion: 1.0.0\nname: {pack_id}\ndescription: kit\nauthors: [ada]\n"
            "license: MIT\nengine: {}\ncontents:\n  presentation: [ui/presentation.yaml]\n",
            encoding="utf-8",
        )
        built = build_pack(src, tmp_path / f"{pack_id}.lwpack")
        install_pack(
            built.path,
            packs_dir=data_dir / "packs",
            skills_dir=data_dir / "skills",
            rulepacks_dir=data_dir / "rulepacks",
            presets_dir=data_dir / "presets",
            current_protocol=PROTOCOL_VERSION,
            current_server="1.0.0",
        )

    _kit_pack("moody", "title_card, letter, text", "midnight blue")
    _kit_pack("austere", "letter, text", "bone white")
    await set_enabled_panel_packs(services.store, "room", ["moody", "austere"])

    room_kit = await load_room_kit(services, "room", "en")
    assert room_kit.templates == ("letter", "text")
    assert room_kit.palette == ("midnight blue", "bone white")
    assert room_kit.allows_template("letter") and not room_kit.allows_template("title_card")


async def test_panels_enable_admits_a_kit_only_pack(tmp_path):
    """k3 playtest D4: a module shipping ONLY a presentation kit (no panels) failed
    `.panels enable`, so its Stage Director could never wake. Kits pass the door now."""
    from agent.context import AgentCtx
    from agent.services import build_services
    from gateway.commands import CommandRouter
    from gateway.ops import set_enabled_panel_packs
    from gateway.presentation import load_room_kit
    from infra.config import Settings
    from infra.embeddings import FakeEmbeddings
    from infra.llm import FakeLLM
    from tests.fixtures.presentation_pack import install_kit_pack

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    await install_kit_pack(services, "room", tmp_path)
    await set_enabled_panel_packs(services.store, "room", [])  # undo the fixture's enable

    router = CommandRouter(services)
    keeper = AgentCtx(chat_key="room", user_id="k1", platform="cli", locale="en")
    reply = await router.dispatch(keeper, ".panels enable stagekit")
    assert reply is not None
    assert reply != services.i18n.with_locale("en").t("commands.panels.unknown", id="stagekit")
    assert bool(await load_room_kit(services, "room", "zh")) is True
