"""Tests for agent.loop.run_kp_turn: the multi-round AI-KP function-calling
loop (per docs/specs/M1.md §6.5), driven against a tiny inline Toolset with
a scripted/`responder`-driven FakeLLM so everything stays deterministic and
offline.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.loop import KPTurnResult, run_kp_turn
from agent.services import build_services
from agent.tools import Toolset, tool
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call

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


def _toolset() -> Toolset:
    return Toolset(_SampleProvider())


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


async def test_tool_result_is_fed_back_as_a_role_tool_message_with_matching_call_id():
    llm = FakeLLM(script=[assistant_tools(tool_call("lookup_time")), assistant_text("narration")])
    services = _services(llm)

    await run_kp_turn(_ctx("chat-2"), services, _toolset(), "hello")

    # The second `.chat()` call must have received the assistant's tool_calls
    # message plus a matching role="tool" reply appended to the conversation.
    assert len(llm.calls) == 2
    second_call_messages, second_call_tools = llm.calls[1]
    assert second_call_tools == _toolset().schemas()

    assistant_msg = next(m for m in second_call_messages if m.get("role") == "assistant" and "tool_calls" in m)
    tool_msg = next(m for m in second_call_messages if m.get("role") == "tool")

    assert assistant_msg["tool_calls"][0]["type"] == "function"
    assert assistant_msg["tool_calls"][0]["function"]["name"] == "lookup_time"
    assert json.loads(assistant_msg["tool_calls"][0]["function"]["arguments"]) == {}
    assert tool_msg["tool_call_id"] == assistant_msg["tool_calls"][0]["id"]
    assert tool_msg["content"] == "1926-03-15 14:00"


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
# max_rounds fallback
# ---------------------------------------------------------------------------


async def test_max_rounds_fallback_triggers_when_the_llm_always_returns_tool_calls():
    def _always_tool_calls(messages, tools):
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=_always_tool_calls)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-5"), services, _toolset(), "hi", max_rounds=3)

    assert result.rounds == 3
    assert len(result.tool_trace) == 3
    assert result.reply == services.i18n.with_locale("en").t("loop.max_rounds")


async def test_max_rounds_fallback_is_localized_per_ctx_locale():
    def _always_tool_calls(messages, tools):
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=_always_tool_calls)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-5-zh", locale="zh"), services, _toolset(), "hi", max_rounds=2)

    assert result.reply == services.i18n.with_locale("zh").t("loop.max_rounds")
    assert result.reply != services.i18n.with_locale("en").t("loop.max_rounds")


async def test_max_rounds_fallback_also_goes_through_output_review():
    def _always_tool_calls(messages, tools):
        return assistant_tools(tool_call("lookup_time"))

    llm = FakeLLM(responder=_always_tool_calls)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-6"), services, _toolset(), "hi", max_rounds=2, output_review=str.upper)

    assert result.reply == services.i18n.with_locale("en").t("loop.max_rounds").upper()


# ---------------------------------------------------------------------------
# History persistence: user + final reply only, never tool chatter
# ---------------------------------------------------------------------------


async def test_history_persists_only_the_user_message_and_final_reply():
    llm = FakeLLM(script=[assistant_tools(tool_call("lookup_time")), assistant_text("It is midnight.")])
    services = _services(llm)

    await run_kp_turn(_ctx("chat-7"), services, _toolset(), "What time is it?")

    raw = await services.store.get(user_key="", store_key="chat_history.chat-7")
    history = json.loads(raw)
    assert history == [
        {"role": "user", "content": "What time is it?"},
        {"role": "assistant", "content": "It is midnight."},
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

    # A default-keyed history (`chat_history.{chat_key}`) was never touched.
    default_raw = await services.store.get(user_key="", store_key="chat_history.chat-8")
    assert default_raw is None


async def test_history_is_capped_to_the_last_twenty_messages():
    llm = FakeLLM(script=[assistant_text("newest reply")])
    services = _services(llm)
    chat_key = "chat-9"

    # Seed 30 already-persisted messages (well past the cap).
    seeded = [{"role": "user", "content": f"msg-{i}"} for i in range(30)]
    await services.store.set(user_key="", store_key=f"chat_history.{chat_key}", value=json.dumps(seeded))

    await run_kp_turn(_ctx(chat_key), services, _toolset(), "newest message")

    outgoing_messages, _ = llm.calls[0]
    # system + <=20 history + the new user message.
    assert len(outgoing_messages) <= 1 + 20 + 1
    assert {"role": "user", "content": "msg-0"} not in outgoing_messages  # oldest entries dropped

    raw = await services.store.get(user_key="", store_key=f"chat_history.{chat_key}")
    persisted = json.loads(raw)
    assert len(persisted) <= 20
    assert persisted[-1] == {"role": "assistant", "content": "newest reply"}


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
    assert await services.store.get(user_key="", store_key="chat_history.chat-boom") is None


async def test_provider_error_fallback_is_localized_and_goes_through_output_review():
    def _boom(messages, tools):
        raise RuntimeError("boom")

    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(
        _ctx("chat-boom-zh", locale="zh"), services, _toolset(), "hi", output_review=str.upper
    )

    assert result.reply == services.i18n.with_locale("zh").t("loop.unavailable").upper()
