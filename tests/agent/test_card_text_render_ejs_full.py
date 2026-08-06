"""Full-EJS (QuickJS) coverage for the actor-side card-text render hook: real-JS templates in
card-derived persona prose execute through the sandbox engine, the keeper-only red line holds
on that path too, and template writes stay discarded (actor rendering is read-only).

Skipped as a module when the `ejs` extra (quickjs) is not installed; the unconditional subset
coverage lives in `test_card_text_render.py`."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.npc import NpcRecord  # noqa: E402
from agent.npc_actor import voice_npc  # noqa: E402
from agent.services import build_services  # noqa: E402
from core.modvars import build_spec, define_modvar, load_modvars, set_modvar  # noqa: E402
from core.mvu_compat import load_mvu, mvu_init_from_initvar  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text  # noqa: E402

CHAT_KEY = "card-render-full-ejs-room"
KEEPER_SENTINEL = "THE HARBORMASTER DID IT"


def _recording_services(recorded: list[list[dict]]):
    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps({"dialogue": "Aye.", "action_intent": "", "mood": "calm"}))

    # DEFAULT settings: enable_full_ejs=True, and quickjs is present in this module.
    return build_services(Settings(), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8))


async def test_real_js_template_in_persona_renders_via_the_full_engine():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded)

    # A loop + lodash chain the ejs_lite subset cannot render -- output proves the engine ran.
    npc = NpcRecord(
        id="warden",
        name="The Warden",
        persona="Sigils:<% for (const i of _.range(3)) { %> sigil<%= i %><% } %>",
    )
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)

    system_content = recorded[-1][0]["content"]
    assert "Sigils: sigil0 sigil1 sigil2" in system_content
    assert "<%" not in system_content and "%>" not in system_content


async def test_full_engine_sees_player_variables_and_mvu_tree_but_never_keeper_modvars():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded)
    await define_modvar(
        services.documents, CHAT_KEY, build_spec("fear", "number", visibility="player", minimum=0, maximum=10)
    )
    await set_modvar(services.documents, CHAT_KEY, "fear", 7)
    await define_modvar(services.documents, CHAT_KEY, build_spec("true_culprit", "text", visibility="keeper"))
    await set_modvar(services.documents, CHAT_KEY, "true_culprit", KEEPER_SENTINEL)
    await mvu_init_from_initvar(services.documents, CHAT_KEY, {"stage": [2, "story stage"]})

    npc = NpcRecord(
        id="martha",
        name="Martha",
        persona=(
            "Fear=<%= getvar('fear') %> Stage=<%= getvar('stage') %>"
            " Culprit=<%= getvar('true_culprit') || 'unknown' %> Note:{{getvar::true_culprit}}(end)"
        ),
    )
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)

    everything = "\n".join(str(m.get("content") or "") for m in recorded[-1])
    assert "Fear=7" in everything
    assert "Stage=2" in everything  # the MVU tree (no upstream visibility concept) is available
    assert "Culprit=unknown" in everything  # keeper-only modvar behaves as UNSET in the sandbox
    assert "Note:(end)" in everything
    assert KEEPER_SENTINEL not in everything  # the red line, on the full-engine path
    assert "<%" not in everything and "%>" not in everything


async def test_full_engine_template_writes_are_discarded_on_the_actor_path():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded)
    await define_modvar(
        services.documents, CHAT_KEY, build_spec("fear", "number", visibility="player", minimum=0, maximum=10)
    )
    await set_modvar(services.documents, CHAT_KEY, "fear", 7)
    await mvu_init_from_initvar(services.documents, CHAT_KEY, {"stage": [2, "story stage"]})

    npc = NpcRecord(id="martha", name="Martha", persona="<% setvar('stage', 9); setvar('fear', 0) %>She waits.")
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)

    assert "She waits." in recorded[-1][0]["content"]
    # Neither store flushed: the engine's pending_writes are never read back on this path.
    state = await load_modvars(services.documents, CHAT_KEY)
    assert state["values"]["fear"] == 7
    tree = await load_mvu(services.documents, CHAT_KEY)
    assert tree["stage"][0] == 2
