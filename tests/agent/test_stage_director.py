"""Tests for `agent.stage_director` — the M19 presentation actor.

The isolation guarantee has its own oracle (`tests/architecture/test_director_isolation.py`);
this file covers the three output lanes and the image discipline: blocks go through the
engine's own sanitizer, audio cues resolve only against the kit, and generation obeys
ref-mandatory / 宁缺毋滥 / the room budget / the 慢菜先备 larder.

Offline throughout: `FakeLLM` scripts the Director's JSON and `FakeImageGen` records
what a provider would have been sent. The suite-wide conftest keeps the scribe (and so
the Director's only production trigger) OFF; these tests opt in explicitly.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import build_services
from agent.stage_director import PREGEN_KEY, SPENT_KEY, run_director
from core.modvars import define_modvar
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.imagegen import FakeImageGen
from infra.llm import FakeLLM, assistant_text
from tests.fixtures.presentation_pack import KIT, install_kit_pack

CHAT = "director-room"


class _Hub:
    """Records every published event in order (the hub surface the Director uses)."""

    def __init__(self) -> None:
        self.events: list = []

    async def publish(self, chat_key, event):
        self.events.append(event)

    def members(self, chat_key):
        return []


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="tui:player", locale="zh")


async def _room(tmp_path, payload, *, kit: str = KIT, imagegen: FakeImageGen | None = None):
    llm = FakeLLM(responder=lambda messages, tools: assistant_text(json.dumps(payload, ensure_ascii=False)))
    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = True
    # Explicit either way: `Settings()` reads the developer's own `.env`, so a machine with
    # TRPG_IMAGEGEN__* configured would silently hand the "no provider" tests a real one.
    services.imagegen = imagegen
    await install_kit_pack(services, CHAT, tmp_path, kit=kit)
    return services, _Hub()


def _blocks(hub) -> list[dict]:
    return [block for event in hub.events if event.kind == "ui" for block in event.data["blocks"]]


def _audio(hub) -> list[dict]:
    return [event.data for event in hub.events if event.kind == "audio"]


# --- lane 1: performance blocks ---------------------------------------------


async def test_performance_blocks_reach_the_room_through_the_engine_sanitizer(tmp_path):
    services, hub = await _room(
        tmp_path,
        {
            "blocks": [
                {"kind": "title_card", "title": "第二幕 · 曝灯", "subtitle": "初二"},
                {"kind": "clipping", "headline": "石埠溺毙", "body": "昨夜潮退，埠上拾得一人。", "source": "汐浦日报"},
                {"kind": "letter", "body": "戌时来。", "from": "晚棠"},
                {"kind": "nonsense", "body": "x"},  # unknown kind: dropped, not fatal
                {"kind": "letter"},  # required field missing: dropped
            ],
            "audio": [],
            "image": None,
            "prepare": [],
        },
    )

    staged = await run_director(services, _ctx(), "我们上埠头", "潮水退了。", beat="act_transition", hub=hub)

    assert staged is True
    kinds = [block["kind"] for block in _blocks(hub)]
    assert kinds == ["title_card", "clipping", "letter"]
    assert _blocks(hub)[1]["source"] == "汐浦日报"


async def test_a_beat_outside_the_vocabulary_never_wakes_the_director(tmp_path):
    def _explode(messages, tools):
        raise AssertionError("no beat, no director call")

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(responder=_explode), embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = True
    await install_kit_pack(services, CHAT, tmp_path)

    assert await run_director(services, _ctx(), "我看看", "没什么。", beat="none") is False
    assert await run_director(services, _ctx(), "我看看", "没什么。", beat="") is False


async def test_a_room_with_no_presentation_kit_is_never_charged_for_a_beat(tmp_path):
    """Kit-gated by design: a module opts into having a Director by authoring one.
    Without that, an upgrade would silently start paying for generic staging."""

    def _explode(messages, tools):
        raise AssertionError("no kit, no director call")

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(responder=_explode), embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = True

    assert await run_director(services, _ctx(), "我们上埠头", "潮水退了。", beat="scene_change") is False


async def test_disabled_director_never_calls_the_llm(tmp_path):
    def _explode(messages, tools):
        raise AssertionError("director disabled")

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(responder=_explode), embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = False
    await install_kit_pack(services, CHAT, tmp_path)

    assert await run_director(services, _ctx(), "行动", "叙述。", beat="handout") is False


async def test_malformed_output_is_a_silent_noop(tmp_path):
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("完全不是 JSON 的闲聊"))
    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = True
    await install_kit_pack(services, CHAT, tmp_path)
    hub = _Hub()

    assert await run_director(services, _ctx(), "行动", "叙述。", beat="spike", hub=hub) is False
    assert hub.events == []


# --- lane 2: audio cues ------------------------------------------------------


async def test_audio_cues_resolve_only_against_the_kit(tmp_path):
    services, hub = await _room(
        tmp_path,
        {
            "blocks": [],
            "audio": [{"cue": "tide", "action": "play"}, {"cue": "not-in-the-kit", "action": "play"}],
            "image": None,
            "prepare": [],
        },
    )

    staged = await run_director(services, _ctx(), "夜里", "雾起了。", beat="scene_change", hub=hub)

    assert staged is True
    controls = [frame for frame in _audio(hub) if frame.get("type") == "audio_control"]
    assert len(controls) == 1
    assert controls[0]["layer"] == "bgm" and controls[0]["action"] == "play"
    # Pack audio needs no library import: the frame carries the content hash the media
    # byte channel already resolves for an enabled pack.
    assert len(controls[0]["hash"]) == 64 and controls[0]["title"] == "潮涌"


# --- lane 3: the image discipline -------------------------------------------


async def test_generation_carries_the_fixed_portrait_reference_and_style(tmp_path):
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "她站在灯下"}, "prepare": []},
        imagegen=imagegen,
    )

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    assert len(imagegen.calls) == 1
    call = imagegen.calls[0]
    # Ref-mandatory: the 定妆 image itself rides the request, not just its words.
    assert int(call["reference"]) > 0 and call["reference_mime"] == "image/png"
    # ...alongside the kit's subject descriptor, style keywords and banned list.
    assert "plain dark coat" in call["prompt"]
    assert "她站在灯下" in call["prompt"]
    # Style keywords ride in the ROOM's language (the kit declared both); an author
    # writing a Chinese module gets their own words sent to the image provider.
    assert "水墨" in call["prompt"] and "text overlays" in call["prompt"]

    image_blocks = [block for block in _blocks(hub) if block["kind"] == "image"]
    assert len(image_blocks) == 1 and image_blocks[0]["caption"] == "顾晚棠"
    assert await services.store.state_get(CHAT, SPENT_KEY) == "1"


async def test_a_subject_without_a_reference_is_never_generated(tmp_path):
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "the-quay", "prompt": "石埠"}, "prepare": []},
        imagegen=imagegen,
    )

    await run_director(services, _ctx(), "我看埠头", "石埠空着。", beat="scene_change", hub=hub)

    # "No ref, no portrait" is structural, not a prompt request the model may ignore.
    assert imagegen.calls == []
    assert _blocks(hub) == []


async def test_pack_only_vetoes_generation_but_pack_art_still_stages(tmp_path):
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": ["wantang"]},
        kit=KIT.replace("generation: allow", "generation: pack_only"),
        imagegen=imagegen,
    )
    services.settings.director.images = True  # config says yes; the author still wins

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    assert imagegen.calls == []
    # `pack_only` vetoes GENERATION, never STAGING: the kit's own 定妆 reference is pack
    # content, so it is exactly what such an author asked to be shown.
    assert [block["kind"] for block in _blocks(hub)] == ["image"]


async def test_images_off_gate_is_named_in_the_probe(tmp_path):
    from agent.stage_director import IMAGE_IMAGES_OFF
    from agent.tool_trace import enable_tool_trace

    services, hub = await _room(
        tmp_path,
        # "the-quay" has no 定妆 reference, so a decline here can never be masked by the
        # reference fallback — the trace word under test is the one that survives.
        {"blocks": [], "audio": [], "image": {"subject": "the-quay", "prompt": "x"}, "prepare": []},
    )
    services.settings.director.images = False
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我看埠头", "石埠空着。", beat="scene_change", hub=hub)
    finally:
        enable_tool_trace(None)

    [line] = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    assert json.loads(line["event"])["image"]["outcome"] == IMAGE_IMAGES_OFF


async def test_a_background_warm_is_traced_where_the_budget_actually_went(tmp_path):
    """A 慢菜先备 warm is a REAL generation on a later task, so the beat's own row never
    mentions it. The 2026-08-20 play-test read the wrong story out of that silence: two
    pictures traced as generated while the room had paid for eleven, and every later
    `larder` hit looked like it came from nowhere."""
    import asyncio

    from agent.stage_director import IMAGE_GENERATED, PREGEN_TRACE_KIND
    from agent.tool_trace import enable_tool_trace

    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {}, "prepare": ["wantang"]},
        imagegen=imagegen,
    )
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)
        for _ in range(20):  # the warm runs on its own task; let it land
            await asyncio.sleep(0)
            if PREGEN_TRACE_KIND in path.read_text(encoding="utf-8"):
                break
    finally:
        enable_tool_trace(None)

    rows = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    warms = [json.loads(row["event"]) for row in rows if row["tool"] == PREGEN_TRACE_KIND]
    assert [(w["subject"], w["outcome"]) for w in warms] == [("wantang", IMAGE_GENERATED)]
    assert warms[0]["hash"]
    # And the beat's own row still says it asked for one, so the two halves reconcile.
    beat = next(json.loads(row["event"]) for row in rows if row["tool"] == "director")
    assert beat["prepared"] == 1


async def test_pack_only_gate_is_named_in_the_probe(tmp_path):
    from agent.stage_director import IMAGE_PACK_ONLY
    from agent.tool_trace import enable_tool_trace

    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "the-quay", "prompt": "x"}, "prepare": []},
        kit=KIT.replace("generation: allow", "generation: pack_only"),
    )
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我看埠头", "石埠空着。", beat="scene_change", hub=hub)
    finally:
        enable_tool_trace(None)

    [line] = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    assert json.loads(line["event"])["image"]["outcome"] == IMAGE_PACK_ONLY


async def test_no_provider_gate_is_named_in_the_probe(tmp_path):
    from agent.stage_director import IMAGE_NO_PROVIDER
    from agent.tool_trace import enable_tool_trace

    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "the-quay", "prompt": "x"}, "prepare": []},
    )
    assert services.imagegen is None
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我看埠头", "石埠空着。", beat="scene_change", hub=hub)
    finally:
        enable_tool_trace(None)

    [line] = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    assert json.loads(line["event"])["image"]["outcome"] == IMAGE_NO_PROVIDER


async def test_the_room_image_budget_is_a_hard_stop(tmp_path):
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": []},
        imagegen=imagegen,
    )
    services.settings.director.max_images = 0

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    assert imagegen.calls == []


async def test_a_pregenerated_subject_is_served_from_the_larder_without_spending(tmp_path):
    """慢菜先备: a warmed subject costs nothing at the beat that finally uses it."""
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": []},
        imagegen=imagegen,
    )
    await services.store.state_set(CHAT, PREGEN_KEY, json.dumps({"wantang": "a" * 64}))
    await services.store.state_set(CHAT, SPENT_KEY, "1")

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    assert imagegen.calls == []
    assert await services.store.state_get(CHAT, SPENT_KEY) == "1"
    # The larder hash is not room media, so the reachability gate drops the block —
    # exactly the behaviour that keeps a stale/foreign hash off the wire.
    assert _blocks(hub) == []


# --- lane 3b: showing the 定妆 reference when generation cannot run ----------


async def test_the_fixed_reference_is_shown_when_no_image_provider_is_configured(tmp_path):
    """Run 2 (2026-08-19): fourteen authored 定妆 references on disk, zero pictures all
    session, because a room with no imagegen showed NOTHING rather than the picture the
    kit already ships of that very subject."""
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "她站在灯下"}, "prepare": []},
    )
    assert services.imagegen is None

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    image_blocks = [block for block in _blocks(hub) if block["kind"] == "image"]
    assert len(image_blocks) == 1
    assert image_blocks[0]["caption"] == "顾晚棠"
    # The block survived the reachability gate, so the hash IS resolvable room media.
    assert len(image_blocks[0]["hash"]) == 64
    # Nothing was generated, so nothing was charged for.
    assert await services.store.state_get(CHAT, SPENT_KEY) is None
    # ...and it stays OUT of the 慢菜先备 larder: that larder short-circuits generation,
    # so remembering a fallback would retire the subject for the life of the story.
    assert await services.store.state_get(CHAT, PREGEN_KEY) is None


async def test_the_reference_fallback_repeats_without_ever_entering_the_larder(tmp_path):
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": []},
    )

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)
    await run_director(services, _ctx(), "我再抬头", "她还在灯下。", beat="handout", hub=hub)

    hashes = [block["hash"] for block in _blocks(hub) if block["kind"] == "image"]
    # Same bytes, so the content-addressed store hands back the same hash both times —
    # a re-show costs a re-register, never a second copy.
    assert len(hashes) == 2 and hashes[0] == hashes[1]
    assert await services.store.state_get(CHAT, PREGEN_KEY) is None


async def test_a_provider_that_arrives_later_can_still_draw_a_subject_that_fell_back(tmp_path):
    """The bite the larder write would have caused: one beat with no provider (or a dead
    one, or a spent budget) must not mean this room may never draw that subject again."""
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "她站在灯下"}, "prepare": []},
    )
    assert services.imagegen is None
    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    imagegen = FakeImageGen()
    services.imagegen = imagegen  # the provider comes online mid-story
    await run_director(services, _ctx(), "我再抬头", "她还在灯下。", beat="handout", hub=hub)

    assert len(imagegen.calls) == 1, "the earlier fallback must not have retired the subject"
    assert await services.store.state_get(CHAT, SPENT_KEY) == "1"
    # NOW it is remembered: a real generation is what the larder is for.
    assert json.loads(await services.store.state_get(CHAT, PREGEN_KEY))["wantang"]


async def test_a_subject_with_no_reference_still_shows_nothing(tmp_path):
    """宁缺毋滥 is untouched: the fallback IS the reference, so no reference means no
    picture — the same structural rule generation obeys."""
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "the-quay", "prompt": "石埠"}, "prepare": []},
    )

    await run_director(services, _ctx(), "我看埠头", "石埠空着。", beat="scene_change", hub=hub)

    assert _blocks(hub) == []


async def test_generation_still_wins_whenever_it_is_available(tmp_path):
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "她站在灯下"}, "prepare": []},
        imagegen=imagegen,
    )

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    assert len(imagegen.calls) == 1  # the fallback never pre-empts a working provider
    assert await services.store.state_get(CHAT, SPENT_KEY) == "1"


async def test_a_spent_budget_falls_back_to_the_reference_without_charging_again(tmp_path):
    imagegen = FakeImageGen()
    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": []},
        imagegen=imagegen,
    )
    services.settings.director.max_images = 0

    await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)

    assert imagegen.calls == []
    assert await services.store.state_get(CHAT, SPENT_KEY) is None
    assert [block["kind"] for block in _blocks(hub)] == ["image"]


async def test_the_reference_fallback_is_named_in_the_probe(tmp_path):
    from agent.stage_director import IMAGE_REF_FALLBACK
    from agent.tool_trace import enable_tool_trace

    services, hub = await _room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": []},
    )
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)
    finally:
        enable_tool_trace(None)

    [line] = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    assert json.loads(line["event"])["image"]["outcome"] == IMAGE_REF_FALLBACK


async def test_player_visible_trackers_are_in_context_and_keeper_ones_are_not(tmp_path):
    captured: list[str] = []

    def responder(messages, tools):
        captured.append(messages[0]["content"])
        return assistant_text('{"blocks": [], "audio": [], "image": null, "prepare": []}')

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = True
    await install_kit_pack(services, CHAT, tmp_path)
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "祭典日", "kind": "number", "labels": {"zh": "祭典日"}, "default": 2, "minimum": 1, "maximum": 3},
    )
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "hidden", "kind": "text", "labels": {"zh": "沈氏献妻"}, "visibility": "keeper", "default": "yes"},
    )

    await run_director(services, _ctx(), "我数灯", "九盏。", beat="scene_change")

    prompt = captured[0]
    assert "祭典日: 2" in prompt
    assert "沈氏献妻" not in prompt
