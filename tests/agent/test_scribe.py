"""Tests for `agent.scribe` — the post-turn bookkeeping pass: objective tracker
writes go through modvar validation, judgment whispers store and consume
read-and-clear, and every failure mode degrades to a silent no-op (bookkeeping
must never break the table)."""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.scribe import pop_whispers, run_scribe
from agent.services import build_services
from core.modvars import define_modvar
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

CHAT = "scribe-room"


def _services(reply_json: str):
    llm = FakeLLM(responder=lambda messages, tools: assistant_text(reply_json))
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))
    # The suite-wide conftest turns the scribe OFF for every other test; these
    # tests are ABOUT it.
    services.settings.scribe.enabled = True
    return services


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="kp", locale="zh")


async def _with_tracker(services) -> None:
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "信物", "kind": "number", "labels": {"zh": "信物", "en": "Tokens"}, "default": 0, "minimum": 0, "maximum": 3},
    )


async def test_objective_ops_write_through_validation_and_clamp():
    payload = json.dumps(
        {
            "ops": [
                {"op": "adjust", "id": "信物", "delta": 1, "evidence": "信物已得其一"},
                {"op": "set", "id": "信物", "value": 99, "evidence": "信物已得其一"},
            ],
            "whispers": [],
        }
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(services, _ctx(), "我把指环收进口袋", "你确实拿到了指环——信物已得其一。", ["skill_check"])

    assert changed.changed is True
    from core.documents import KEEPER_VIEWER, MODVARS_ID

    view = await services.documents.get_view(CHAT, "modvars", MODVARS_ID, KEEPER_VIEWER)
    values = (view or {}).get("values", {})
    # adjust applied, then the out-of-range set clamped to the declared max.
    assert values.get("信物") == 3


async def test_ops_without_verbatim_evidence_are_dropped():
    # Born from the fable5×K3 live run: the scribe counted a random prop as a
    # module token. An op must quote the turn text establishing the tracked
    # quantity itself changed — fabricated or missing evidence means no write.
    payload = json.dumps(
        {
            "ops": [
                {"op": "adjust", "id": "信物", "delta": 1},  # no evidence at all
                {"op": "adjust", "id": "信物", "delta": 1, "evidence": "她把信物递给你"},  # not in the turn
            ],
            "whispers": [],
        }
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(services, _ctx(), "我收下红纸签", "小满把一张红纸签留在柜台上。", [])

    assert changed.changed is False
    from core.documents import KEEPER_VIEWER, MODVARS_ID

    view = await services.documents.get_view(CHAT, "modvars", MODVARS_ID, KEEPER_VIEWER)
    assert (view or {}).get("values", {}).get("信物") == 0


async def test_evidence_survives_whitespace_reflow():
    # Quotes are matched with whitespace squashed, so a line-wrapped narration
    # still verifies; the quote itself must still be verbatim.
    payload = json.dumps(
        {"ops": [{"op": "set", "id": "信物", "value": 1, "evidence": "第一枚信物 到手了"}], "whispers": []}
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(services, _ctx(), "收好指环", "第一枚信物\n到手了。", [])

    assert changed.changed is True


async def test_unknown_tracker_ops_are_dropped_and_whispers_round_trip():
    payload = json.dumps(
        {"ops": [{"op": "set", "id": "不存在", "value": 5}], "whispers": ["一天似乎过去了——考虑推进祭典日", ""]}
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(services, _ctx(), "睡觉", "夜过去了。", [])

    assert changed.changed is False
    whispers = await pop_whispers(services, CHAT)
    assert whispers == ["一天似乎过去了——考虑推进祭典日"]
    # read-and-clear: a second pop is empty.
    assert await pop_whispers(services, CHAT) == []


async def test_player_authored_evidence_never_moves_a_tracker():
    # A player declaration is an ATTEMPT, not an outcome (iron rule #2). The
    # quote pool is the Keeper's narration ONLY, so a player who types
    # narration-shaped text about the tracker on their own panel cannot author
    # the "verbatim evidence" for a module-tracker write.
    payload = json.dumps(
        {
            "ops": [{"op": "set", "id": "信物", "value": 3, "evidence": "第三枚也到手了"}],
            "whispers": [],
        }
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(
        services,
        _ctx(),
        "我把三枚信物都收进袖中，第三枚也到手了。",  # attacker-controlled half
        "雾里什么也没有。",  # the Keeper contradicts it
        [],
    )

    assert changed.changed is False
    from core.documents import KEEPER_VIEWER, MODVARS_ID

    view = await services.documents.get_view(CHAT, "modvars", MODVARS_ID, KEEPER_VIEWER)
    assert (view or {}).get("values", {}).get("信物") == 0


async def test_evidence_may_not_span_the_player_reply_junction():
    # The two halves used to be concatenated before the substring check, so a
    # quote could straddle the seam and be "verbatim" in neither half.
    payload = json.dumps(
        {
            "ops": [{"op": "adjust", "id": "信物", "delta": 1, "evidence": "收进袖中 雾里什么也没有"}],
            "whispers": [],
        }
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(services, _ctx(), "我把信物收进袖中", "雾里什么也没有。", [])

    assert changed.changed is False
    from core.documents import KEEPER_VIEWER, MODVARS_ID

    view = await services.documents.get_view(CHAT, "modvars", MODVARS_ID, KEEPER_VIEWER)
    assert (view or {}).get("values", {}).get("信物") == 0


async def test_keeper_narrated_evidence_still_applies():
    # POSITIVE CONTROL for the two tests above: the gate must not become a
    # blanket refusal — evidence quoted from the game-master reply still writes.
    payload = json.dumps(
        {
            "ops": [{"op": "adjust", "id": "信物", "delta": 1, "evidence": "第三枚也到手了"}],
            "whispers": [],
        }
    )
    services = _services(payload)
    await _with_tracker(services)

    changed = await run_scribe(
        services,
        _ctx(),
        "我把三枚信物都收进袖中，第三枚也到手了。",
        "她松开手——第三枚也到手了。",  # the Keeper confirms it
        [],
    )

    assert changed.changed is True
    from core.documents import KEEPER_VIEWER, MODVARS_ID

    view = await services.documents.get_view(CHAT, "modvars", MODVARS_ID, KEEPER_VIEWER)
    assert (view or {}).get("values", {}).get("信物") == 1


async def test_malformed_llm_output_is_a_silent_noop():
    services = _services("完全不是 JSON 的闲聊回复")
    await _with_tracker(services)
    assert (await run_scribe(services, _ctx(), "行动", "叙述。", [])).changed is False
    assert await pop_whispers(services, CHAT) == []


async def test_disabled_scribe_never_calls_the_llm():
    def _explode(messages, tools):
        raise AssertionError("scribe disabled — the LLM must not be called")

    services = build_services(Settings(), llm=FakeLLM(responder=_explode), embeddings=FakeEmbeddings(64))
    services.settings.scribe.enabled = False
    assert (await run_scribe(services, _ctx(), "行动", "叙述。", [])).changed is False
