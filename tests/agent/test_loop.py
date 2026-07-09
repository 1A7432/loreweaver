"""Tests for agent.loop.run_kp_turn: the multi-round AI-KP function-calling
loop (per docs/specs/M1.md §6.5), driven against a tiny inline Toolset with
a scripted/`responder`-driven FakeLLM so everything stays deterministic and
offline.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.loop import (
    KPTurnResult,
    _dice_rolled,
    _player_attempts_checkable_action,
    _reply_requests_or_resolves_check,
    _scene_title_lines,
    run_kp_turn,
)
from agent.services import build_services
from agent.tools import Toolset, tool
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, Usage, assistant_text, assistant_tools, tool_call

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


class _MixedProvider:
    """A provider with a dice tool AND a non-dice (sheet-reading) tool.

    Lets a test drive the forced corrective round into calling a NON-dice tool,
    exercising the "no real dice rolled -> keep the reply, don't loop" ceiling.
    """

    @tool
    async def skill_check(self, ctx: AgentCtx, skill_name: str) -> str:
        """Roll a skill check. Returns a fake rolled result string."""
        return f"{skill_name}: rolled 42 vs 65 -> hard success"

    @tool
    async def get_character_sheet(self, ctx: AgentCtx) -> str:
        """Read the investigator's character sheet (rolls no dice)."""
        return "STR 50, DEX 60, Spot Hidden 65"


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


# ---------------------------------------------------------------------------
# Structural dice-first enforcement: a check narrated/asked-for but never rolled
# triggers exactly one bounded corrective round that DOES roll (iron rule #2)
# ---------------------------------------------------------------------------


async def test_narrating_a_check_without_rolling_triggers_one_corrective_dice_round():
    # The KP asks the player to roll (".ra") and calls no dice tool, so exactly
    # one corrective round fires -- and THIS time the model rolls skill_check.
    llm = FakeLLM(
        script=[
            assistant_text("Make a Spot Hidden check — please roll .ra Spot Hidden."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Your fingers brush a hidden latch beneath the desk."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-dice-fix"), services, _dice_toolset(), "I search the desk.")

    # The corrective round rolled real dice, then re-narrated per the result.
    assert [t["name"] for t in result.tool_trace] == ["skill_check"]
    assert result.reply == "Your fingers brush a hidden latch beneath the desk."
    assert len(llm.calls) == 3  # initial reply + one corrective tool round + re-narration


class _RequiredRejectingLLM(FakeLLM):
    """DeepSeek v4-pro's thinking-mode shape: tool_choice="required" 400s outright (thinking is
    the server-side default there); every other call behaves like a normal FakeLLM."""

    async def chat(self, messages, *, tools=None, tool_choice=None, temperature=None, model=None):
        if tool_choice == "required":
            self.calls.append((messages, tools))
            self.tool_choices.append(tool_choice)
            raise RuntimeError("Error code: 400 - Thinking mode does not support this tool_choice")
        return await super().chat(messages, tools=tools, tool_choice=tool_choice, temperature=temperature, model=model)


async def test_corrective_round_falls_back_to_auto_when_required_is_rejected():
    # The recommended default Keeper (deepseek-v4-pro, thinking ON server-side) rejects the
    # forced round's tool_choice="required" with a 400. The corrective must degrade to ONE
    # plain "auto" retry — never silently drop dice-first enforcement. (Deliberately NOT
    # worked around by disabling thinking per-call: the models that reject "required" are
    # the strong ones that roll voluntarily; see _run_dice_correction's comment.)
    llm = _RequiredRejectingLLM(
        script=[
            assistant_text("Make a Spot Hidden check — please roll .ra Spot Hidden."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Your fingers brush a hidden latch beneath the desk."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-dice-400"), services, _dice_toolset(), "I search the desk.")

    assert [t["name"] for t in result.tool_trace] == ["skill_check"]
    assert result.reply == "Your fingers brush a hidden latch beneath the desk."
    # main reply + rejected "required" + "auto" retry (which rolls) + re-narration
    assert llm.tool_choices == ["auto", "required", "auto", "auto"]


async def test_a_check_that_already_rolled_triggers_no_corrective_round():
    # skill_check already fired this turn, so even a success-level narration must
    # NOT trigger a corrective round (the script would be exhausted if it did).
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("A hard success — you spot the faint scratches immediately."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-dice-ok"), services, _dice_toolset(), "I search the desk.")

    assert [t["name"] for t in result.tool_trace] == ["skill_check"]
    assert len(llm.calls) == 2
    assert result.reply.startswith("A hard success")


async def test_plain_narration_without_a_check_triggers_no_corrective_round():
    # Neither the reply (no dice-command / roll-request / success-level vocabulary)
    # nor the player's action (no skill-attempt lexicon) signals a check -> no
    # correction. The inbound is deliberately non-checkable dialogue/movement.
    llm = FakeLLM(script=[assistant_text("The corridor stretches on into darkness, silent and cold.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-plain"), services, _dice_toolset(), "I wait quietly for a moment.")

    assert result.tool_trace == []
    assert len(llm.calls) == 1
    assert result.reply.startswith("The corridor stretches on")


async def test_corrective_round_is_bounded_when_the_model_still_will_not_roll():
    # KP asks for a roll; the forced corrective round is entered exactly ONCE. If
    # the model ignores tool_choice="required" and returns prose instead of a dice
    # tool, we keep the ORIGINAL reply and stop (the ceiling -- never loop).
    llm = FakeLLM(
        script=[
            assistant_text("Please roll .ra Spot Hidden to search the desk."),
            assistant_text("Very well, you find nothing of note."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-dice-ceiling"), services, _dice_toolset(), "I search.")

    assert result.tool_trace == []  # never rolled
    assert len(llm.calls) == 2  # exactly one corrective attempt, then it stops
    # The forced round produced no tool call, so the original reply is kept as-is.
    assert result.reply == "Please roll .ra Spot Hidden to search the desk."
    # The corrective round asked the model with tool_choice="required".
    assert llm.tool_choices == ["auto", "required"]


# ---------------------------------------------------------------------------
# Broadened trigger: the PLAYER's action attempts a skill-checkable thing and
# the Keeper resolves it in plain prose (no dice-command / roll-request /
# success-level vocabulary of its own) -> the same one bounded corrective fires.
# ---------------------------------------------------------------------------


async def test_player_action_attempts_a_check_but_reply_never_rolls_triggers_one_corrective_round():
    # The player attempts a Spot Hidden ("search ... for hidden clues"); the KP
    # resolves it in plain prose carrying NONE of the reply-side vocabulary, so
    # only the player-action detector fires. Exactly one corrective round runs and
    # THIS time the model rolls skill_check.
    llm = FakeLLM(
        script=[
            assistant_text("You rifle through the drawers and turn up an old photograph."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Behind a false bottom, your fingers close on a brass key."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(
        _ctx("chat-player-attempt"), services, _dice_toolset(), "I search the desk for hidden clues."
    )

    assert [t["name"] for t in result.tool_trace] == ["skill_check"]
    assert result.reply == "Behind a false bottom, your fingers close on a brass key."
    assert len(llm.calls) == 3  # initial reply + one corrective tool round + re-narration


async def test_pure_dialogue_player_action_triggers_no_corrective_round():
    # Pure roleplay/dialogue: no skill-attempt lexicon in the player's action and
    # no reply-side check vocabulary -> the corrective never fires (the single-entry
    # script would be exhausted, and llm.calls would exceed 1, if it did).
    llm = FakeLLM(script=[assistant_text("Martha beams and clasps your hand in both of hers.")])
    services = _services(llm)

    result = await run_kp_turn(
        _ctx("chat-dialogue"), services, _dice_toolset(), "I nod and greet Martha warmly."
    )

    assert result.tool_trace == []
    assert len(llm.calls) == 1
    assert result.reply == "Martha beams and clasps your hand in both of hers."


async def test_player_action_trigger_forced_round_returning_prose_keeps_reply():
    # The player-action detector fires (via the broadened PLAYER-side trigger) and
    # forces the corrective round. If the model returns prose instead of obeying
    # tool_choice="required" (provider ignored "required"), we keep the ORIGINAL
    # reply and stop -- so a forced round that produces no dice can't corrupt it.
    narration = "You glance over the tidy desk; nothing seems out of place."
    llm = FakeLLM(script=[assistant_text(narration), assistant_text("...restated...")])
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-escape"), services, _dice_toolset(), "I search the desk.")

    assert result.tool_trace == []  # never rolled -- the forced round returned prose
    assert len(llm.calls) == 2  # exactly one corrective attempt, then it stops
    assert result.reply == narration  # original reply kept (the ceiling)
    assert llm.tool_choices == ["auto", "required"]  # player-side trigger forced a tool


# ---------------------------------------------------------------------------
# Forced dice-first correction: the corrective round FORCES a tool call via
# tool_choice="required" (a soft nudge let the real Keeper decline every time).
# ---------------------------------------------------------------------------


async def test_corrective_round_forces_tool_choice_required_then_narrates():
    # The KP asks for a roll but calls no dice tool. The corrective phase now
    # FORCES a tool call (tool_choice="required"); the model complies with a real
    # skill_check (dispatched + recorded), then a normal "auto" round narrates.
    llm = FakeLLM(
        script=[
            assistant_text("Make a Spot Hidden check — please roll .ra Spot Hidden."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Your fingers brush a hidden latch beneath the desk."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-forced"), services, _dice_toolset(), "I search the desk.")

    # The dice tool the forced round called was dispatched for real and recorded.
    assert [t["name"] for t in result.tool_trace] == ["skill_check"]
    assert result.tool_trace[0]["result"].endswith("hard success")
    assert result.reply == "Your fingers brush a hidden latch beneath the desk."
    # main "auto" round, then the FORCED "required" round, then the "auto" narration.
    assert llm.tool_choices == ["auto", "required", "auto"]


async def test_forced_round_non_dice_tool_keeps_reply_and_does_not_loop():
    # The forced round obeys tool_choice="required" but calls a NON-dice tool
    # (get_character_sheet). No real dice rolled -> ceiling: dispatch it, keep the
    # ORIGINAL reply, and do NOT loop for a narration round.
    llm = FakeLLM(
        script=[
            assistant_text("Please roll .ra Spot Hidden to search the desk."),
            assistant_tools(tool_call("get_character_sheet")),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-nondice"), services, Toolset(_MixedProvider()), "I search the desk.")

    assert [t["name"] for t in result.tool_trace] == ["get_character_sheet"]  # dispatched...
    assert not _dice_rolled(result.tool_trace)  # ...but no real dice rolled
    assert result.reply == "Please roll .ra Spot Hidden to search the desk."  # original kept
    assert len(llm.calls) == 2  # main + one forced round, then it stops (no loop)
    assert llm.tool_choices == ["auto", "required"]


async def test_forced_correction_round_provider_error_keeps_original_reply():
    # A provider that raises on the forced round (e.g. it rejects
    # tool_choice="required") must be non-fatal: keep the original reply intact.
    calls = {"n": 0}

    def _responder(messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            return assistant_text("Please roll .ra Spot Hidden to search the desk.")
        raise RuntimeError("provider rejects tool_choice='required'")

    services = _services(FakeLLM(responder=_responder))

    result = await run_kp_turn(_ctx("chat-forced-boom"), services, _dice_toolset(), "I search the desk.")

    assert result.tool_trace == []  # nothing rolled
    assert result.reply == "Please roll .ra Spot Hidden to search the desk."  # original kept
    # main round + the forced attempt that raised + its single "auto" fallback that also raised
    assert calls["n"] == 3
    # The turn still persisted (the corrective error is best-effort, not a turn crash).
    assert await services.store.get(user_key="", store_key="chat_history.chat-forced-boom") is not None


async def test_dice_correction_nudge_binds_to_the_current_player_action():
    # A real play-test bug: a forced corrective roll narrated the PREVIOUS player's action. The
    # nudge must quote THIS turn's just-submitted action verbatim, so the forced roll +
    # re-narration bind to it rather than drifting onto a stale action still in the replay window.
    action = "I pry open the rusted strongbox with my crowbar."
    llm = FakeLLM(
        script=[
            assistant_text("You crouch beside the strongbox."),  # initial reply -- rolls nothing
            assistant_tools(tool_call("skill_check", skill_name="Locksmith")),  # forced round rolls
            assistant_text("The lid groans open on a nest of oilcloth bundles."),  # narration round
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-bind"), services, _dice_toolset(), action)

    # The corrective nudge is built by quoting THIS turn's action into loop.dice_correction; that
    # exact user message must appear in the conversation the corrective round saw.
    expected_nudge = services.i18n.with_locale("en").t("loop.dice_correction", action=action)
    assert action in expected_nudge  # sanity: the action really is quoted in the nudge
    corrective_convo = llm.calls[-1][0]
    assert any(m.get("role") == "user" and m.get("content") == expected_nudge for m in corrective_convo)
    # ...and the forced roll actually fired + re-narrated per the result.
    assert [t["name"] for t in result.tool_trace] == ["skill_check"]
    assert result.reply == "The lid groans open on a nest of oilcloth bundles."
    assert llm.tool_choices == ["auto", "required", "auto"]


def test_player_action_detector_catches_attempts_but_not_dialogue():
    # Positives: the player's action plausibly attempts a skill-checkable thing.
    for positive in [
        "I search the desk for hidden clues.",
        "I listen at the door.",
        "I try to sneak past the guard.",
        "I climb the drainpipe to the window.",
        "I persuade the clerk to hand over the ledger.",
        "I attack the cultist with my knife.",
        "I pick the lock on the cabinet.",
        "I look around the room for another way out.",
        "I use first aid on the wounded man.",
        "I want to spot any hidden traps.",
        "我搜查这张书桌。",
        "我想潜行绕到他背后。",
        "我说服他放我们离开。",
        "我尝试撬开这把锁。",
        "我躲避扑过来的怪物。",
        "我去图书馆查阅相关资料。",
        "我聆听门后的动静。",
        "我攻击那个邪教徒。",
    ]:
        assert _player_attempts_checkable_action(positive), positive

    # Negatives: pure dialogue/roleplay/movement, incl. dialogue-dominant words
    # (look-at / see / 看 / 打招呼) that are deliberately excluded.
    for negative in [
        "",
        "I nod and greet Martha warmly.",
        "I say hello to the man behind the counter.",
        "I look at Martha and smile.",
        "I walk into the parlor and sit down.",
        "I tell her my name is Harvey.",
        "I wait quietly for a moment.",
        "我向玛莎打招呼。",
        "我对他微笑着点点头。",
        "我看着窗外，一言不发。",
    ]:
        assert not _player_attempts_checkable_action(negative), negative


def test_reply_check_detector_catches_the_violation_but_not_plain_narration():
    # Positives: the reply asks the player to roll, or narrates a graded outcome.
    for positive in [
        "Please roll .ra Spot Hidden.",
        "Make a Spot Hidden check to see what you find.",
        "Roll a d100 for Luck.",
        "That's a hard success — you notice the scratch.",
        "It's a critical failure; the lock jams.",
        "请投掷侦察检定，输入 .ra 侦察",
        "请进行一次侦查检定。",
        "这是一次大成功，你看清了墙上的划痕。",
        "自己掷一个理智检定吧。",
    ]:
        assert _reply_requests_or_resolves_check(positive), positive

    # Negatives: ordinary narration, incl. bare "check"/"roll"/"success" words.
    for negative in [
        "",
        "It is a moonless midnight in Innsmouth.",
        "The investigators sense something is deeply wrong here.",
        "The corridor stretches on into darkness, silent and cold.",
        "You step into the fog. What do you do?",
        "You check the desk and the walls but find nothing.",
        "The ritual was a success.",
        "You roll the heavy barrel aside.",
        "你走进浓雾，四周一片死寂。",
    ]:
        assert not _reply_requests_or_resolves_check(negative), negative

    # `_dice_rolled` keys off the real dice-rolling tools only.
    assert _dice_rolled([{"name": "skill_check"}])
    assert _dice_rolled([{"name": "lookup_time"}, {"name": "sanity_check"}])
    assert not _dice_rolled([{"name": "lookup_time"}, {"name": "get_module_summary"}])
    assert not _dice_rolled([])


# ---------------------------------------------------------------------------
# Token/cache usage accumulation (KPTurnResult.usage)
# ---------------------------------------------------------------------------


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


async def test_usage_stays_all_zero_when_the_llm_reports_no_usage():
    # FakeLLM's default ChatResult carries usage=None -- the ordinary path every
    # other test in this file (and every test in the whole suite) exercises.
    llm = FakeLLM(script=[assistant_text("Ready.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-usage-2"), services, _toolset(), "hi")

    assert result.usage == Usage()


async def test_usage_is_zeroed_on_max_rounds_fallback_even_when_rounds_carried_real_usage():
    def _always_tool_calls_with_usage(messages, tools):
        return ChatResult(
            content=None,
            tool_calls=[tool_call("lookup_time")],
            usage=Usage(prompt_tokens=50, completion_tokens=5, total_tokens=55),
        )

    llm = FakeLLM(responder=_always_tool_calls_with_usage)
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-usage-3"), services, _toolset(), "hi", max_rounds=2)

    assert result.reply == services.i18n.with_locale("en").t("loop.max_rounds")
    assert result.usage == Usage()


async def test_usage_is_zeroed_on_provider_error():
    def _boom(messages, tools):
        raise RuntimeError("boom")

    services = _services(FakeLLM(responder=_boom))

    result = await run_kp_turn(_ctx("chat-usage-4"), services, _toolset(), "hi")

    assert result.usage == Usage()


# ---------------------------------------------------------------------------
# Structural scene/time HUD enforcement (mirrors the dice-first suite above)
# ---------------------------------------------------------------------------


class _StateProvider:
    """A provider exposing the HUD bookkeeping tools the state corrective forces."""

    @tool
    async def kp_note(self, ctx: AgentCtx, action: str, category: str = "", content: str = "") -> str:
        """Set or add a KP note (current_scene / current_focus / world_changes)."""
        return f"note {action} {category}: {content}"

    @tool
    async def game_clock(self, ctx: AgentCtx, action: str, value: str = "") -> str:
        """Show, set, or advance the in-game clock."""
        return f"clock {action} {value}"


def _state_toolset() -> Toolset:
    return Toolset(_StateProvider())


_TITLE_REPLY = "🌉 Tokyo Port · Pier 5 | 10:15 pm\nThe sea wind mixes diesel and rust as the cranes sweep overhead."


def test_scene_title_detector_hits_and_misses():
    # Hits: a short title-like line with a |/｜ separator AND a time marker.
    assert _scene_title_lines("🌉 東京港·大井埠頭五号泊位 | 晚 10:15")
    assert _scene_title_lines("码头仓库区 ｜ 深夜")
    assert _scene_title_lines("## 東京港 | 凌晨 2:00\n正文继续。")
    assert _scene_title_lines(_TITLE_REPLY)
    # Misses: prose mentioning a time (no separator), a separator with no time
    # marker, and an over-long line are all left alone.
    assert not _scene_title_lines("你们在晚上10:15到达了码头,海风很冷,吊机在夜空里摆动。")
    assert not _scene_title_lines("东京港 | 五号泊位")
    assert not _scene_title_lines("东京港 | 深夜," + "很" * 140 + "冷")
    assert not _scene_title_lines("The corridor stretches on, silent and cold.")


async def test_scene_title_without_bookkeeping_triggers_a_state_correction():
    # The KP draws a scene/time card in prose but calls no bookkeeping tool, so
    # the corrective phase forces kp_note + game_clock, then allows a narration.
    llm = FakeLLM(
        script=[
            assistant_text(_TITLE_REPLY),
            assistant_tools(tool_call("kp_note", action="set", category="current_scene", content="Tokyo Port Pier 5")),
            assistant_tools(tool_call("game_clock", action="advance", value="75m")),
            assistant_text("The pier waits below, half-lit and quiet."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-state-fix"), services, _state_toolset(), "We take the train to the docks.")

    assert [t["name"] for t in result.tool_trace] == ["kp_note", "game_clock"]
    assert result.reply == "The pier waits below, half-lit and quiet."
    # main reply + two forced bookkeeping rounds + one free narration round
    assert len(llm.calls) == 4


async def test_scene_title_with_bookkeeping_already_done_triggers_no_correction():
    # Both bookkeeping tools already fired this turn, so the self-drawn title is
    # fine as-is (the script would be exhausted if a correction fired).
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("kp_note", action="set", category="current_scene", content="Pier 5")),
            assistant_tools(tool_call("game_clock", action="set", value="22:15")),
            assistant_text(_TITLE_REPLY),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-state-ok"), services, _state_toolset(), "We take the train to the docks.")

    assert [t["name"] for t in result.tool_trace] == ["kp_note", "game_clock"]
    assert result.reply == _TITLE_REPLY
    assert len(llm.calls) == 3


async def test_plain_prose_without_a_scene_title_triggers_no_state_correction():
    llm = FakeLLM(script=[assistant_text("The train rattles on through the dark suburbs.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-state-plain"), services, _state_toolset(), "We take the train to the docks.")

    assert result.tool_trace == []
    assert len(llm.calls) == 1


async def test_state_correction_is_bounded_and_keeps_the_original_reply():
    # The forced round returns prose instead of a bookkeeping tool call: keep
    # the ORIGINAL reply and stop -- never loop, never replace with the refusal.
    llm = FakeLLM(
        script=[
            assistant_text(_TITLE_REPLY),
            assistant_text("I would rather not do bookkeeping."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-state-stubborn"), services, _state_toolset(), "We take the train to the docks.")

    assert result.tool_trace == []
    assert result.reply == _TITLE_REPLY
    assert len(llm.calls) == 2


async def test_state_correction_falls_back_to_auto_when_required_is_rejected():
    # Same provider shape as the dice suite: tool_choice="required" 400s
    # (deepseek v4-pro thinking), so each forced round degrades to ONE "auto"
    # retry instead of silently dropping HUD enforcement.
    llm = _RequiredRejectingLLM(
        script=[
            assistant_text(_TITLE_REPLY),
            assistant_tools(tool_call("kp_note", action="set", category="current_scene", content="Pier 5")),
            assistant_tools(tool_call("game_clock", action="advance", value="75m")),
            assistant_text("The pier waits below."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx("chat-state-400"), services, _state_toolset(), "We take the train to the docks.")

    assert [t["name"] for t in result.tool_trace] == ["kp_note", "game_clock"]
    assert result.reply == "The pier waits below."
    # main + (required rejected, auto) x2 forced rounds + free narration round
    assert llm.tool_choices == ["auto", "required", "auto", "required", "auto", "auto"]
