"""Tests for agent.loop.run_kp_turn: the multi-round AI-KP function-calling
loop (per docs/specs/M1.md §6.5), driven against a tiny inline Toolset with
a scripted/`responder`-driven FakeLLM so everything stays deterministic and
offline.
"""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy

import pytest

from agent.context import AgentCtx
from agent.history import load_chain
from agent.kp_tools_mechanics import InitiativeTools
from agent.loop import KPTurnResult, run_kp_turn
from agent.services import build_services
from agent.tools import Toolset, tool
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, Usage, assistant_text, assistant_tools, tool_call
from infra.oauth_flows import OAuthError

KEEPER_SECRET = "THE BUTLER POISONED THE WINE"


class _SampleProvider:
    """A tiny provider exercising one normal tool and one keeper_only tool."""

    @tool
    async def lookup_time(self, ctx: AgentCtx) -> str:
        """Look up the current in-game time."""
        return "1926-03-15 14:00"

    @tool(keeper_only=True)
    async def secret_truth(self, ctx: AgentCtx) -> str:
        """Reveal the keeper-only truth. Never quote raw to players."""
        return KEEPER_SECRET


class _DiceProvider:
    """A provider exposing a `skill_check` dice tool for dice-first tests."""

    @tool
    async def skill_check(self, ctx: AgentCtx, skill_name: str) -> str:
        """Roll a skill check. Returns a fake rolled result string."""
        return f"{skill_name}: rolled 42 vs 65 -> hard success"


class _BufferedDiceProvider:
    """A dice provider that can emit or omit a structured payload per call."""

    @tool
    async def roll_dice(self, ctx: AgentCtx, expression: str, emit: bool) -> str:
        """Return a deterministic roll and optionally publish its structured payload."""
        if emit:
            ctx.emit_dice({"kind": "roll", "expr": expression, "rolls": [4], "total": 4})
        return f"{expression}: 4"


class _AttributionDiceProvider:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    @tool
    async def skill_check(
        self,
        ctx: AgentCtx,
        skill_name: str,
        actor: str | None = None,
        npc_target: int | None = None,
    ) -> str:
        """Roll one attributed skill check."""
        self.calls.append({"skill_name": skill_name, "actor": actor, "npc_target": npc_target})
        return f"{skill_name}: rolled"


class _ExplodingProvider:
    @tool
    async def explode(self, ctx: AgentCtx) -> str:
        """Raise an unexpected tool implementation failure."""
        raise RuntimeError("tool exploded")


def _toolset() -> Toolset:
    return Toolset(_SampleProvider())


def _dice_toolset() -> Toolset:
    return Toolset(_DiceProvider())


def _services(llm: FakeLLM):
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(chat_key: str, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale=locale)


# ---------------------------------------------------------------------------
# Tool dispatch + final narration
# ---------------------------------------------------------------------------


async def test_run_kp_turn_dispatches_tool_call_and_returns_the_final_narration():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("lookup_time")),
            assistant_text("It is a moonless midnight in Innsmouth."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-1"), services, _toolset(), "What time is it?")

    assert isinstance(result, KPTurnResult)
    assert result.reply == "It is a moonless midnight in Innsmouth."
    assert result.rounds == 2
    assert len(result.tool_trace) == 1
    assert result.tool_trace[0] == {
        "name": "lookup_time",
        "arguments": {},
        "keeper_only": False,
        "result": "1926-03-15 14:00",
    }


async def test_run_kp_turn_commits_at_most_one_initiative_next_per_player_turn():
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call("initiative_tracker", action="next"),
                tool_call("initiative_tracker", action="next"),
            ),
            assistant_text("Bob acts next."),
        ]
    )
    services = _services(llm)
    ctx = _ctx("chat-init-idempotent")
    tracker = InitiativeTools(services)
    await tracker.initiative_tracker(ctx, action="add", name="Alice", initiative=20)
    await tracker.initiative_tracker(ctx, action="add", name="Bob", initiative=15)
    await tracker.initiative_tracker(ctx, action="add", name="Cora", initiative=10)

    result = await run_kp_turn(ctx, services, Toolset(tracker), "Advance initiative once.")

    order = json.loads(
        await services.store.state_get(ctx.chat_key, "initiative") or "[]"
    )
    assert [entry["name"] for entry in order] == ["Bob", "Cora", "Alice"]
    assert [entry["result"] for entry in result.tool_trace if entry["name"] == "initiative_tracker"] == [
        services.i18n.with_locale("en").t("kp_tools.initiative.next_turn", name="Bob"),
        services.i18n.with_locale("en").t("kp_tools.initiative.next_already_committed"),
    ]


async def test_tool_result_is_fed_back_as_a_role_tool_message_with_matching_call_id():
    llm = FakeLLM(script=[assistant_tools(tool_call("lookup_time")), assistant_text("narration")])
    services = _services(llm)

    await run_kp_turn(_ctx("chat-2"), services, _toolset(), "hello")

    # The second `.chat()` call must have received the assistant's tool_calls
    # message plus a matching role="tool" reply appended to the conversation.
    assert len(llm.calls) == 2
    second_call_messages, second_call_tools = llm.calls[1]
    from agent.kp_tools_subsystems import subsystem_schemas
    from core.rulepacks import load_rulepack

    assert second_call_tools == [*_toolset().schemas(), *subsystem_schemas(load_rulepack("coc7"))]

    assistant_msg = next(m for m in second_call_messages if m.get("role") == "assistant" and "tool_calls" in m)
    tool_msg = next(m for m in second_call_messages if m.get("role") == "tool")

    assert assistant_msg["tool_calls"][0]["type"] == "function"
    assert assistant_msg["tool_calls"][0]["function"]["name"] == "lookup_time"
    assert json.loads(assistant_msg["tool_calls"][0]["function"]["arguments"]) == {}
    assert tool_msg["tool_call_id"] == assistant_msg["tool_calls"][0]["id"]
    assert tool_msg["content"] == "1926-03-15 14:00"


async def test_structured_dice_payload_is_bound_to_the_exact_tool_trace_entry():
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call("roll_dice", expression="invalid", emit=False),
                tool_call("roll_dice", expression="1d6", emit=True),
            ),
            assistant_text("The second roll lands on four."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-dice-payload"), services, Toolset(_BufferedDiceProvider()), "roll")

    assert "dice_payloads" not in result.tool_trace[0]
    assert result.tool_trace[1]["dice_payloads"] == [
        {"kind": "roll", "expr": "1d6", "rolls": [4], "total": 4}
    ]


async def test_run_kp_turn_discards_stale_dice_payloads_before_dispatch():
    llm = FakeLLM(script=[assistant_tools(tool_call("lookup_time")), assistant_text("Midnight.")])
    services = _services(llm)
    ctx = _ctx("chat-stale-dice-payload")
    ctx.emit_dice({"kind": "roll", "expr": "stale", "rolls": [99], "total": 99})

    result = await run_kp_turn(ctx, services, _toolset(), "What time is it?")

    assert "dice_payloads" not in result.tool_trace[0]
    assert ctx.dice_payloads == []


# ---------------------------------------------------------------------------
# Keeper-only discipline: recorded in the trace, never echoed verbatim
# ---------------------------------------------------------------------------


async def test_keeper_only_tool_result_is_traced_correctly_and_never_leaks_into_the_reply():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("secret_truth")),
            assistant_text("The investigators sense something is deeply wrong here."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-3"), services, _toolset(), "Who did it?")

    assert result.tool_trace[0]["name"] == "secret_truth"
    assert result.tool_trace[0]["keeper_only"] is True
    assert result.tool_trace[0]["result"] == KEEPER_SECRET  # the raw secret IS captured in the trace...
    assert KEEPER_SECRET not in result.reply  # ...but it must never surface verbatim in the reply


# ---------------------------------------------------------------------------
# output_review post-processing
# ---------------------------------------------------------------------------


async def test_output_review_is_applied_to_the_final_reply():
    llm = FakeLLM(script=[assistant_text("narration")])
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-4"), services, _toolset(), "hi", output_review=str.upper)

    assert result.reply == "NARRATION"


# ---------------------------------------------------------------------------
# max_rounds finalization + deterministic fallback
# ---------------------------------------------------------------------------


async def test_max_rounds_finalizer_narrates_committed_public_tool_results_with_tools_disabled():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("lookup_time")),
            assistant_tools(tool_call("lookup_time")),
            assistant_text("The clock settles at two in the afternoon; the investigation continues."),
        ]
    )
    cleared: list[list[dict]] = []
    llm.clear_continuation = cleared.append  # type: ignore[attr-defined]
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-5"), services, _toolset(), "hi", max_rounds=2)

    assert result.rounds == 2
    assert len(result.tool_trace) == 2
    assert result.reply == "The clock settles at two in the afternoon; the investigation continues."
    assert len(llm.calls) == 3
    finalizer_messages, finalizer_tools = llm.calls[-1]
    assert finalizer_tools == []
    assert llm.tool_choices[-1] == "none"
    finalizer_prompt = finalizer_messages[-1]["content"]
    assert finalizer_messages[-1]["role"] == "user"
    assert "lookup_time" in finalizer_prompt
    assert "1926-03-15 14:00" in finalizer_prompt
    # The main and sanitized finalizer conversations are both retired.
    assert len(cleared) == 2


async def test_max_rounds_finalizer_excludes_keeper_only_results_from_its_prompt():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("secret_truth")),
            assistant_tools(tool_call("lookup_time")),
            assistant_text("Time passes, and the investigators remain uneasy."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-finalize-secret"), services, _toolset(), "Who did it?", max_rounds=2)

    finalizer_messages, _ = llm.calls[-1]
    serialized = json.dumps(finalizer_messages, ensure_ascii=False)
    assert KEEPER_SECRET not in serialized
    assert "lookup_time" in serialized
    assert KEEPER_SECRET not in result.reply


async def test_max_rounds_finalizer_failure_falls_back_with_public_results_but_no_secret():
    calls = 0

    def responder(_messages, tools):
        nonlocal calls
        calls += 1
        if tools == []:
            raise RuntimeError("finalizer failed")
        if calls == 1:
            return assistant_tools(tool_call("secret_truth"))
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=responder)
    services = _services(llm)

    result = await run_kp_turn(
        _ctx("chat-finalize-fallback"), services, _toolset(), "Who did it?", max_rounds=2
    )

    assert services.i18n.with_locale("en").t("loop.max_rounds") in result.reply
    assert "lookup_time" in result.reply
    assert "1926-03-15 14:00" in result.reply
    assert KEEPER_SECRET not in result.reply


async def test_max_rounds_finalizer_cancellation_propagates():
    def responder(_messages, tools):
        if tools == []:
            raise asyncio.CancelledError
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=responder)
    cleared: list[list[dict]] = []
    llm.clear_continuation = cleared.append  # type: ignore[attr-defined]
    services = _services(llm)

    with pytest.raises(asyncio.CancelledError):
        await run_kp_turn(_ctx("chat-finalize-cancelled"), services, _toolset(), "hi", max_rounds=1)

    assert len(cleared) == 2


async def test_cancelled_tool_continuation_is_cleared_before_propagating():
    calls = 0

    def responder(_messages, _tools):
        nonlocal calls
        calls += 1
        if calls == 1:
            return assistant_tools(tool_call("lookup_time"))
        raise asyncio.CancelledError

    llm = FakeLLM(responder=responder)
    cleared: list[list[dict]] = []
    llm.clear_continuation = cleared.append  # type: ignore[attr-defined]
    services = _services(llm)

    with pytest.raises(asyncio.CancelledError):
        await run_kp_turn(_ctx("chat-cancelled"), services, _toolset(), "hi")

    assert len(cleared) == 1


async def test_max_rounds_fallback_is_localized_per_ctx_locale():
    def _always_tool_calls(_messages, tools):
        if tools == []:
            raise RuntimeError("finalizer failed")
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=_always_tool_calls)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-5-zh", locale="zh"), services, _toolset(), "hi", max_rounds=2)

    assert services.i18n.with_locale("zh").t("loop.max_rounds") in result.reply
    assert services.i18n.with_locale("en").t("loop.max_rounds") not in result.reply
    assert "lookup_time" in result.reply


async def test_max_rounds_fallback_also_goes_through_output_review():
    def _always_tool_calls(_messages, tools):
        if tools == []:
            raise RuntimeError("finalizer failed")
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=_always_tool_calls)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-6"), services, _toolset(), "hi", max_rounds=2, output_review=str.upper)

    assert result.reply == result.reply.upper()
    assert services.i18n.with_locale("en").t("loop.max_rounds").upper() in result.reply
    assert "LOOKUP_TIME" in result.reply


async def test_max_rounds_finalizer_reply_goes_through_output_review():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("lookup_time")),
            assistant_text("The clock strikes two."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(
        _ctx("chat-finalizer-review"), services, _toolset(), "hi", max_rounds=1, output_review=str.upper
    )

    assert result.reply == "THE CLOCK STRIKES TWO."


async def test_max_rounds_clears_continuation_before_output_review_failure():
    def responder(_messages, tools):
        if tools == []:
            raise RuntimeError("finalizer failed")
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=responder)
    cleared: list[list[dict]] = []
    llm.clear_continuation = cleared.append  # type: ignore[attr-defined]
    services = _services(llm)

    def broken_review(_reply: str) -> str:
        raise RuntimeError("review exploded")

    with pytest.raises(RuntimeError, match="review exploded"):
        await run_kp_turn(
            _ctx("chat-review-cleanup"),
            services,
            _toolset(),
            "hi",
            max_rounds=1,
            output_review=broken_review,
        )

    assert len(cleared) == 2


async def test_unexpected_tool_dispatch_failure_clears_continuation():
    llm = FakeLLM(script=[assistant_tools(tool_call("explode"))])
    cleared: list[list[dict]] = []
    llm.clear_continuation = cleared.append  # type: ignore[attr-defined]
    services = _services(llm)

    with pytest.raises(RuntimeError, match="tool exploded"):
        await run_kp_turn(
            _ctx("chat-dispatch-cleanup"),
            services,
            Toolset(_ExplodingProvider()),
            "trigger",
        )

    assert len(cleared) == 1


# ---------------------------------------------------------------------------
# History persistence: user + final reply only, never tool chatter
# ---------------------------------------------------------------------------


async def test_a_crashed_attempt_s_dangling_player_message_is_abandoned_by_the_next_turn():
    """The player message is persisted when a turn STARTS (so a companion's nested
    exchange lands after it, in the order the table saw). A turn that dies after that
    write and before its reply leaves the path ending on a lone player line stamped
    with a turn the counter never advanced past; the next attempt abandons it (the
    record stays in the tree, off the path) and chains after the last COMPLETED turn.
    A legitimately trailing player line with an EARLIER stamp is left alone."""
    from agent.history import append_message, load_chain

    services = _services(FakeLLM(script=[assistant_text("Second time lucky.")]))
    chat_key = "chat-heal"
    # A completed turn 1, then an attempt at turn 2 that crashed after its user write.
    await append_message(services, chat_key, "chat_history", role="user", content="hello", turn=1)
    await append_message(services, chat_key, "chat_history", role="assistant", content="hi", turn=1)
    await services.store.state_set(chat_key, "chronicle_turn", "1")
    await append_message(services, chat_key, "chat_history", role="user", content="crashed attempt", turn=2)

    await run_kp_turn(_ctx(chat_key), services, _toolset(), "retry")

    contents = [message["content"] for message in await load_chain(services, chat_key, "chat_history")]
    assert contents == ["hello", "hi", "retry", "Second time lucky."]


async def test_history_persists_only_the_user_message_and_final_reply():
    llm = FakeLLM(script=[assistant_tools(tool_call("lookup_time")), assistant_text("It is midnight.")])
    services = _services(llm)

    await run_kp_turn(_ctx("chat-7"), services, _toolset(), "What time is it?")

    # `_lw_turn` is the room turn that wrote the pair — the handle the chronicle fold
    # cuts history on (M20 A2). It is stripped before any vendor wire.
    history = await load_chain(services, "chat-7", "chat_history")
    # `_lw_id` is the record's own id (what the replay event lane anchors to) — present,
    # opaque, and not what this test is about.
    assert all(message.pop("_lw_id") for message in history)
    assert history == [
        {"role": "user", "content": "What time is it?", "_lw_turn": 1},
        {"role": "assistant", "content": "It is midnight.", "_lw_turn": 1},
    ]


async def test_history_reloads_across_turns_and_honors_a_custom_history_key():
    llm = FakeLLM(script=[assistant_text("first reply"), assistant_text("second reply")])
    services = _services(llm)
    ctx = _ctx("chat-8")

    await run_kp_turn(ctx, services, _toolset(), "first message", history_key="custom_history")
    await run_kp_turn(ctx, services, _toolset(), "second message", history_key="custom_history")

    assert len(llm.calls) == 2
    second_turn_messages, _ = llm.calls[1]
    roles_and_content = [(m["role"], m["content"]) for m in second_turn_messages]
    assert ("user", "first message") in roles_and_content
    assert ("assistant", "first reply") in roles_and_content
    assert ("user", "second message") in roles_and_content

    # The default-keyed history was never touched.
    assert await load_chain(services, "chat-8", "chat_history") == []


async def test_history_is_not_capped_and_replays_whole():
    """M20 A2 DELETED the 20-message sliding window rather than raising it.

    The window dropped its front message every turn once at the cap, so no downstream
    cache prefix could ever be stable — the exact cost the milestone set out to remove.
    Truncation now happens at ONE place, the chronicle fold; the oracle for that lives in
    `tests/agent/test_prompt_cache_layout.py`.
    """
    llm = FakeLLM(script=[assistant_text("newest reply")])
    services = _services(llm)
    chat_key = "chat-9"

    # Seed 30 already-persisted messages (well past the old cap), as the pre-M20 blob —
    # which also exercises the one-way adoption into the append-only tree.
    seeded = [{"role": "user", "content": f"msg-{i}"} for i in range(30)]
    await services.store.state_set(chat_key, "chat_history", json.dumps(seeded))

    await run_kp_turn(_ctx(chat_key), services, _toolset(), "newest message")

    outgoing_messages, _ = llm.calls[0]
    assert any(message.get("content") == "msg-0" for message in outgoing_messages), "nothing is dropped"
    assert sum(1 for message in outgoing_messages if str(message.get("content", "")).startswith("msg-")) == 30

    persisted = await load_chain(services, chat_key, "chat_history")
    assert len(persisted) == 32
    assert persisted[-1].pop("_lw_id")
    assert persisted[-1] == {"role": "assistant", "content": "newest reply", "_lw_turn": 1}


# ---------------------------------------------------------------------------
# F9: a real provider error becomes a friendly localized reply, never a crash
# ---------------------------------------------------------------------------


async def test_run_kp_turn_survives_a_provider_error_with_a_localized_reply():
    def _boom(messages, tools):
        raise RuntimeError("provider exploded (network/rate-limit/auth)")

    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(_ctx("chat-boom"), services, _toolset(), "What do I see?")

    assert isinstance(result, KPTurnResult)
    assert result.reply == services.i18n.with_locale("en").t("loop.unavailable")
    assert result.tool_trace == []
    # A failed turn persists nothing (nothing useful happened this turn).
    assert await load_chain(services, "chat-boom", "chat_history") == []


async def test_provider_error_fallback_is_localized_and_goes_through_output_review():
    def _boom(messages, tools):
        raise RuntimeError("boom")

    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(
        _ctx("chat-boom-zh", locale="zh"), services, _toolset(), "hi", output_review=str.upper
    )

    assert result.reply == services.i18n.with_locale("zh").t("loop.unavailable").upper()


@pytest.mark.parametrize(
    ("category", "message_key"),
    [
        ("transient", "loop.provider_transient"),
        ("auth", "loop.provider_auth"),
        ("quota", "loop.provider_quota"),
        ("content", "loop.provider_content"),
    ],
)
@pytest.mark.parametrize("locale", ["en", "zh"])
async def test_run_kp_turn_maps_provider_error_categories_to_distinct_localized_replies(
    category: str,
    message_key: str,
    locale: str,
):
    class _CategorizedProviderError(RuntimeError):
        def __init__(self) -> None:
            super().__init__(category)
            self.category = category

    def _boom(messages, tools):
        raise _CategorizedProviderError

    chat_key = f"chat-provider-{category}-{locale}"
    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(_ctx(chat_key, locale=locale), services, _toolset(), "What happens?")

    assert result.reply == services.i18n.with_locale(locale).t(message_key)
    assert await load_chain(services, chat_key, "chat_history") == []


async def test_run_kp_turn_maps_subscription_relogin_required_to_auth_reply():
    def _boom(messages, tools):
        raise OAuthError("subscription_relogin_required")

    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(_ctx("chat-provider-relogin"), services, _toolset(), "What happens?")

    assert result.reply == services.i18n.with_locale("en").t("loop.provider_auth")


# ---------------------------------------------------------------------------
# Structural dice-first enforcement: a check narrated/asked-for but never rolled
# triggers exactly one bounded corrective round that DOES roll (iron rule #2)
# ---------------------------------------------------------------------------


async def test_empty_player_actor_defaults_are_removed_before_dispatch_and_trace():
    provider = _AttributionDiceProvider()
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call(
                    "skill_check",
                    skill_name="Spot Hidden",
                    actor="",
                    npc_target=0,
                )
            ),
            assistant_text("The check is resolved."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(
        _ctx("chat-normalize-player-actor"),
        services,
        Toolset(provider),
        "I search the uncertain desk.",
    )

    assert provider.calls == [{"skill_name": "Spot Hidden", "actor": None, "npc_target": None}]
    assert result.tool_trace[0]["arguments"] == {"skill_name": "Spot Hidden"}


async def test_malformed_player_npc_target_reaches_tool_validation_without_crashing():
    provider = _AttributionDiceProvider()
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call(
                    "skill_check",
                    skill_name="Spot Hidden",
                    actor="",
                    npc_target=[65],
                )
            ),
            assistant_text("The malformed check was rejected safely."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(
        _ctx("chat-normalize-malformed-target"),
        services,
        Toolset(provider),
        "I search the uncertain desk.",
    )

    assert provider.calls == []
    assert result.tool_trace[0]["arguments"] == {"skill_name": "Spot Hidden", "npc_target": [65]}
    assert "Invalid arguments" in result.tool_trace[0]["result"]


async def test_usage_accumulates_completion_sums_and_prompt_last_wins_across_rounds():
    """A tool-call round + a final text round, each carrying `Usage`: completion
    SUMS across both rounds, while prompt/total/cache_hit/cache_miss are LAST-WINS
    (the final round's numbers, which describe the full current context)."""
    llm = FakeLLM(
        script=[
            ChatResult(
                content=None,
                tool_calls=[tool_call("lookup_time")],
                usage=Usage(prompt_tokens=100, completion_tokens=10, total_tokens=110, cache_hit_tokens=20, cache_miss_tokens=80),
            ),
            ChatResult(
                content="It is a moonless midnight in Innsmouth.",
                tool_calls=[],
                usage=Usage(prompt_tokens=140, completion_tokens=25, total_tokens=165, cache_hit_tokens=100, cache_miss_tokens=40),
            ),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-usage-1"), services, _toolset(), "What time is it?")

    assert result.reply == "It is a moonless midnight in Innsmouth."
    assert result.usage.completion_tokens == 35  # 10 + 25, summed
    assert result.usage.prompt_tokens == 140  # last-wins
    assert result.usage.total_tokens == 165  # last-wins
    assert result.usage.cache_hit_tokens == 100  # last-wins
    assert result.usage.cache_miss_tokens == 40  # last-wins


async def test_a_turn_the_provider_never_metered_falls_back_to_an_estimate():
    """No provider usage is not "no usage" — it is an unmeasured turn.

    FakeLLM's default `ChatResult` carries `usage=None`, the same thing a streamed
    turn gets from an endpoint that ignores `stream_options`. Reporting all-zero
    there is what disabled the chronicle fold on every streaming provider: a zero
    meter is indistinguishable from an empty room, and the fold's very first check
    is a zero window. So the loop sizes the prompt it just sent — and says so.
    """
    llm = FakeLLM(script=[assistant_text("Ready.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-usage-2"), services, _toolset(), "hi")

    assert result.usage.estimated is True
    assert result.usage.prompt_tokens > 0
    assert result.usage.total_tokens == result.usage.prompt_tokens
    # Nothing is invented about the half the loop cannot see.
    assert result.usage.completion_tokens == 0
    assert (result.usage.cache_hit_tokens, result.usage.cache_miss_tokens) == (0, 0)


async def test_a_measured_turn_is_never_relabelled_as_an_estimate():
    llm = FakeLLM(
        script=[
            ChatResult(
                content="Ready.",
                tool_calls=[],
                usage=Usage(prompt_tokens=140, completion_tokens=10, total_tokens=150),
            )
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-usage-measured"), services, _toolset(), "hi")

    assert result.usage.estimated is False
    assert result.usage.prompt_tokens == 140


async def test_the_estimate_prices_the_tool_catalog_as_well_as_the_messages():
    """The schemas are a large fixed share of every KP prompt, and the provider counts
    them. An estimate that only weighed the conversation would under-report the room's
    fullness by that whole block, and under-reporting is what makes a fold run late."""
    llm = FakeLLM(script=[assistant_text("Ready."), assistant_text("Ready.")])
    services = _services(llm)

    with_tools = await run_kp_turn(_ctx("chat-usage-tools"), services, _toolset(), "hi")
    without_tools = await run_kp_turn(_ctx("chat-usage-no-tools"), services, Toolset(), "hi")

    assert with_tools.usage.prompt_tokens > without_tools.usage.prompt_tokens


async def test_usage_merges_main_rounds_and_max_rounds_finalizer():
    calls = 0

    def responder(_messages, tools):
        nonlocal calls
        calls += 1
        if tools == []:
            return ChatResult(
                content="The clock settles at two.",
                tool_calls=[],
                usage=Usage(prompt_tokens=80, completion_tokens=9, total_tokens=89),
            )
        return ChatResult(
            content=None,
            tool_calls=[tool_call("lookup_time")],
            usage=Usage(
                prompt_tokens=40 + calls * 5,
                completion_tokens=5,
                total_tokens=45 + calls * 5,
            ),
        )

    llm = FakeLLM(responder=responder)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-usage-3"), services, _toolset(), "hi", max_rounds=2)

    assert result.reply == "The clock settles at two."
    assert result.usage == Usage(prompt_tokens=80, completion_tokens=19, total_tokens=89)


async def test_usage_keeps_main_rounds_when_max_rounds_finalizer_fails():
    calls = 0

    def responder(_messages, tools):
        nonlocal calls
        calls += 1
        if tools == []:
            raise RuntimeError("finalizer failed")
        return ChatResult(
            content=None,
            tool_calls=[tool_call("lookup_time")],
            usage=Usage(prompt_tokens=50 + calls, completion_tokens=5, total_tokens=55 + calls),
        )

    services = _services(FakeLLM(responder=responder))

    result = await run_kp_turn(_ctx("chat-usage-finalizer-failed"), services, _toolset(), "hi", max_rounds=2)

    assert result.usage == Usage(prompt_tokens=52, completion_tokens=10, total_tokens=57)


async def test_usage_is_zeroed_on_provider_error():
    def _boom(messages, tools):
        raise RuntimeError("boom")

    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(_ctx("chat-usage-4"), services, _toolset(), "hi")

    assert result.usage == Usage()
