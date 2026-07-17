"""The AI-KP multi-round function-calling loop.

Per the M1 spec (``docs/specs/M1.md`` §6.5), one player turn is driven as:
build the system prompt, replay a capped window of prior turn history from
the store, then repeatedly call ``services.llm.chat(...)`` with the
toolset's schemas attached. Every round that comes back with tool calls is
dispatched through ``toolset.dispatch`` and fed back as ``role="tool"``
messages (recorded to ``tool_trace`` for auditing/tests); the first round
that comes back with no tool calls supplies the final reply. If
``max_rounds`` is exhausted without ever reaching a plain-text reply, a
localized fallback (``loop.max_rounds``) is used instead.

Only the user message and the final assistant reply are persisted back to
history — never the intermediate tool-call chatter — so replayed history
stays lean across turns. A keeper-only tool's raw result is recorded in
``tool_trace`` for inspection, but it only ever enters the conversation as a
``role="tool"`` message; it is never surfaced as-is as ``reply`` (the model
must transform it first, per the keeper-secrecy discipline block the system
prompt carries — see ``agent/prompt_builder.py``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field

from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt
from agent.services import Services
from agent.session_recap import maybe_refresh_session_recap
from agent.tools import Toolset
from core.skills import unlocked_tools_for
from infra.llm import ChatResult, Usage

logger = logging.getLogger(__name__)

# Prior-turn history is capped to roughly the last 20 messages (~10 user/
# assistant exchanges) both on load and after persisting a new exchange, so
# replayed history can't grow unbounded across a long session.
_HISTORY_CAP = 20

# --- Structural runtime enforcement ----------------------------------------
# Iron rule #2 is "dice-first": a check rolls REAL dice, then narrates per the
# success level. Play-testing showed a model routinely ignoring the prompt's
# roll-first guidance -- telling the player to type ".ra X" and then narrating a
# clean success/failure without ever calling a dice tool. Prompt-tuning alone
# only fixed ~2/8 cases, and a SOFT nudge fared no better: the real Keeper
# (DeepSeek) took the escape-hatch nudge EVERY time across fresh 16- and 24-turn
# play-tests -- the corrective fired but rolled a skill_check on 0 turns. So we
# enforce it structurally AND compulsorily: after the loop, if NO dice-rolling
# tool fired this turn yet a check plausibly should have, we run one bounded
# corrective phase whose first round FORCES a tool call (`tool_choice="required"`)
# so the Keeper MUST resolve the pending check with a dice tool, then a second
# normal round narrates the graded result. It is entered at most once per turn
# and hard-capped, so it can never loop; a provider error (or a provider that
# rejects `tool_choice="required"`) inside it is non-fatal (we keep the original
# reply). See `_run_dice_correction`.
#
# We fire on EITHER of two signals:
#   (a) a conservative REPLY-side detector -- the model's own reply uses tabletop
#       dice commands / roll-request phrasing / success-LEVEL result vocabulary
#       (never bare "success"/"成功"); or
#   (b) a broadened PLAYER-side detector -- the player's inbound action plausibly
#       attempts a skill-checkable thing (search / listen / sneak / persuade /
#       climb / attack / pick a lock / ...; see the lexicon below).
# (b) is what catches the real DeepSeek failure mode: it resolves a player's
# skill attempt in plain prose carrying none of the (a) vocabulary, so (a) alone
# fired ~0-1x across 24- and 100-turn play-tests while real dice never rolled.
# Because the forced round has no escape hatch, a false-positive detection now
# forces a (possibly minor/irrelevant) roll -- that is the accepted trade for
# dice-first actually happening. The detectors already exclude dialogue-dominant
# terms so pure roleplay stays inert, and the `_dice_rolled` gate keeps
# already-resolved turns (and the exact-call-count FakeLLM scripts) inert. It is
# a heuristic that trades some extra (now non-decline-able) corrective rolls for
# real dice discipline.

# Chat calls the corrective phase may make: one to roll the dice + one to
# re-narrate (plus at most one extra "auto" retry when a provider rejects
# tool_choice="required" — see _run_dice_correction). Hard bound -- the phase
# is also entered at most once per turn.
_CORRECTIVE_MAX_ROUNDS = 2
_STATE_CORRECTIVE_MAX_ROUNDS = 3

# Tools that resolve real dice outcomes. If any fired this turn, the check was
# rolled or deterministically adjusted, so no correction is needed.
_DICE_TOOL_NAMES = frozenset(
    {
        "skill_check",
        "sanity_check",
        "roll_dice",
        "opposed_check",
        "skill_growth",
        "wod_check",
        "spend_luck",
    }
)

# Tools that update the deterministic HUD/world-state fields. A scene transition
# narrated only in prose leaves the HUD reading stale `kp_notes` / `game_clock`
# values, so a high-confidence self-drawn scene title triggers a bounded repair
# pass unless one of these bookkeeping calls already fired this turn.
_STATE_BOOKKEEPING_TOOL_NAMES = frozenset({"kp_note", "game_clock"})

# Dot-/slash-prefixed dice commands (".ra Spot Hidden", ".sc 1/1d6", "/roll") are
# unique to tabletop play; in a player-facing reply they mean the Keeper is
# telling the player to type the command instead of rolling it via a tool.
_DICE_COMMAND_RE = re.compile(
    r"(?<![0-9A-Za-z])[./](?:ra|rah|rav|rab|rap|rc|sc|sca|en|ti|li|rd|ww|wod|roll)\b",
    re.IGNORECASE,
)
# English "you (the player) roll it" imperatives.
_ROLL_REQUEST_EN_RE = re.compile(
    r"\b(?:please\s+(?:roll|make)"
    r"|make\s+an?\b[^.!?\n]{0,40}\b(?:check|roll|test|saving|save)\b"
    r"|roll\s+(?:an?|for|your|to|1?d\d)\b"
    r"|give\s+(?:it|me)\b[^.!?\n]{0,20}\broll\b"
    r"|go\s+ahead\s+and\s+roll)",
    re.IGNORECASE,
)
# Chinese "you roll it" imperatives.
_ROLL_REQUEST_ZH_RE = re.compile(
    r"请(?:你)?(?:自己)?(?:掷|投|骰|进行|做)"
    r"|自己(?:来)?(?:掷|投|骰)"
    r"|投掷|掷骰|骰一下"
    r"|进行(?:一次|一个)?[^。！？\n]{0,10}检定"
    r"|做(?:一次|一个|个)?检定"
    r"|掷出你的"
)
# Success-LEVEL result vocabulary. These grade a resolved check and essentially
# never appear in pure flavour prose, so they signal the model already DECIDED a
# check's outcome. Bare "success"/"成功" is intentionally excluded (too common in
# ordinary narration to trigger on).
_CHECK_OUTCOME_MARKERS = (
    "critical success",
    "extreme success",
    "hard success",
    "regular success",
    "critical failure",
    "极难成功",
    "困难成功",
    "常规成功",
    "普通成功",
    "大成功",
    "大失败",
)

# --- Player-action skill-attempt lexicon (the broadened trigger) -------------
# Curated verbs/nouns a player uses when ATTEMPTING a skill-checkable action. If
# the inbound action matches one and no dice tool fired, the same bounded
# corrective runs (the model is nudged to roll, and can always decline via the
# escape hatch, so a false positive is harmless). English is matched on \b word
# boundaries with a light suffix tolerance; CJK -- which has no word boundaries --
# uses curated multi-character terms (plus a few unambiguous single chars) so it
# doesn't fire on incidental substrings. Intentionally EXCLUDES words that
# dominate ordinary dialogue (look-at / see / watch / read / 看 / 听 / 找 / 打 / ...)
# to keep pure roleplay from tripping it.
_PLAYER_SKILL_EN_WORDS = (
    "search", "rummage", "ransack", "scour", "frisk", "investigate", "examine",
    "inspect", "scrutinize", "scrutinise", "appraise", "scan", "listen",
    "eavesdrop", "overhear", "peek", "sneak", "creep", "tiptoe", "skulk",
    "prowl", "hide", "conceal", "climb", "clamber", "jump", "leap", "vault",
    "swim", "dodge", "evade", "duck", "persuade", "convince", "coax", "cajole",
    "plead", "intimidate", "threaten", "menace", "coerce", "charm", "seduce",
    "flatter", "bluff", "deceive", "negotiate", "bargain", "haggle",
    "interrogate", "bandage", "stabilize", "psychoanalyze", "decipher",
    "attack", "strike", "punch", "stab", "slash", "shoot", "grapple", "wrestle",
    "tackle", "strangle", "choke", "fight", "pickpocket", "disarm", "track",
    "pry", "spot", "library", "psychology",
)
_PLAYER_SKILL_EN_PHRASES = (
    r"first[-\s]?aid",
    r"fast[-\s]?talk",
    r"sleight\s+of\s+hand",
    r"pick(?:s|ing|ed)?\s+(?:the\s+)?lock",
    r"lock[-\s]?pick\w*",
    r"look(?:s|ing|ed)?\s+(?:for|around|behind|underneath|under|inside|through|over|about|beneath)",
)
_PLAYER_SKILL_EN_RE = re.compile(
    r"\b(?:"
    + "|".join([rf"{w}(?:s|es|ed|ing)?" for w in _PLAYER_SKILL_EN_WORDS] + list(_PLAYER_SKILL_EN_PHRASES))
    + r")\b",
    re.IGNORECASE,
)
_PLAYER_SKILL_ZH_TERMS = (
    "搜", "搜查", "搜索", "搜身", "翻找", "翻查", "查看", "察看", "检查", "调查",
    "侦查", "侦察", "观察", "寻找", "找寻", "探查", "探索", "摸索",
    "聆听", "倾听", "偷听", "窃听",
    "潜行", "潜入", "蹑手蹑脚", "溜进", "溜走",
    "躲避", "躲藏", "藏身", "隐藏", "躲闪",
    "攀爬", "爬", "攀登", "翻越", "跳跃",
    "游泳", "潜水",
    "闪避", "闪躲", "格挡",
    "开锁", "撬锁", "撬开", "撬",
    "追踪", "跟踪", "追赶",
    "说服", "劝说", "劝阻", "规劝", "劝",
    "威吓", "恐吓", "威胁", "恫吓",
    "交涉", "谈判", "讲价", "砍价",
    "欺骗", "哄骗", "花言巧语", "说谎", "撒谎",
    "攻击", "袭击", "揍", "殴打", "射击", "开枪", "扭打", "擒抱",
    "急救", "包扎", "止血",
    "图书馆", "查资料", "查阅",
    "心理学", "鉴定", "估价", "伪装", "乔装",
)

# High-confidence "self-drawn scene card" detector: short title-like lines with
# a location/time separator and an explicit time marker, e.g.
# "🌉 東京港·大井埠頭五号泊位 | 晚 10:15". Ordinary prose can mention places or
# times freely; the separator + time marker shape is what flags "the model knew
# this was a HUD transition but forgot to update deterministic state".
_SCENE_TITLE_TIME_RE = re.compile(
    r"(?:\b\d{1,2}[:：]\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|上午|下午|早上|清晨|凌晨|"
    r"傍晚|黄昏|晚上|晚间|夜里|深夜|午夜|正午|morning|afternoon|evening|night|midnight|dawn|dusk|noon)",
    re.IGNORECASE,
)


def _dice_rolled(tool_trace: list[dict]) -> bool:
    """True if any real dice-rolling tool fired during this turn."""
    return any(entry.get("name") in _DICE_TOOL_NAMES for entry in tool_trace)


def _state_bookkeeping_done(tool_trace: list[dict]) -> bool:
    """True if this turn updated both HUD-backed scene/focus and game-clock state."""
    scene_updated = False
    clock_updated = False
    for entry in tool_trace:
        name = entry.get("name")
        if name not in _STATE_BOOKKEEPING_TOOL_NAMES:
            continue
        arguments = entry.get("arguments") or {}
        if name == "kp_note" and arguments.get("action") == "set":
            if arguments.get("category") in {"current_scene", "current_focus"}:
                scene_updated = True
        if name == "game_clock" and arguments.get("action") in {"set", "advance"}:
            clock_updated = True
    return scene_updated and clock_updated


def _scene_title_lines(reply: str) -> list[str]:
    """Return high-confidence self-drawn scene/time title lines from `reply`."""
    lines: list[str] = []
    for raw_line in (reply or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        while line.startswith("#"):
            line = line[1:].lstrip()
        if not (6 <= len(line) <= 140):
            continue
        if "|" not in line and "｜" not in line:
            continue
        if not _SCENE_TITLE_TIME_RE.search(line):
            continue
        left = re.split(r"[|｜]", line, maxsplit=1)[0].strip(" -:：[]【】")
        if left:
            lines.append(line)
    return lines


def _reply_draws_scene_title(reply: str) -> bool:
    """Heuristic: does `reply` include a scene/time title that requires HUD bookkeeping?"""
    return bool(_scene_title_lines(reply))


def _reply_requests_or_resolves_check(reply: str) -> bool:
    """Heuristic: does `reply` ask the player to roll, or narrate a check's graded outcome?

    Conservative by design (see the enforcement note above): keys off
    tabletop-specific dice commands, explicit roll-request phrasing, and
    success-LEVEL result vocabulary -- not bare "success"/"check"/"roll" -- so it
    fires on the real dice-first violation without tripping on ordinary prose.
    """
    if not reply:
        return False
    if _DICE_COMMAND_RE.search(reply) or _ROLL_REQUEST_EN_RE.search(reply) or _ROLL_REQUEST_ZH_RE.search(reply):
        return True
    lowered = reply.lower()
    return any(marker in lowered for marker in _CHECK_OUTCOME_MARKERS)


def _player_attempts_checkable_action(text: str) -> bool:
    """Heuristic: does the player's inbound `text` plausibly attempt a skill-checkable action?

    Broad but curated (see the enforcement note above): a whole-word/boundary
    match against the EN skill-attempt lexicon, or a curated CJK term. Deliberately
    excludes dialogue-dominant words so pure roleplay stays inert. A hit triggers
    the SAME bounded corrective, whose forced round now compels a real roll.
    """
    if not text:
        return False
    if _PLAYER_SKILL_EN_RE.search(text):
        return True
    return any(term in text for term in _PLAYER_SKILL_ZH_TERMS)


@dataclass
class KPTurnResult:
    """One AI-KP turn's outcome."""

    reply: str  # final player-visible text (already `output_review`-ed)
    tool_trace: list[dict]  # [{name, arguments, keeper_only, result}, ...] in call order
    rounds: int  # how many function-calling rounds this turn took
    # Token/cache usage accumulated across this turn's MAIN loop rounds (see
    # `_accumulate_usage` and the `run_kp_turn` docstring below) -- all-zero on the
    # provider-error early return and the `max_rounds`-exhausted fallback, and always
    # all-zero against `FakeLLM` (which never sets `ChatResult.usage`), so every
    # existing test's behavior is unchanged.
    usage: Usage = field(default_factory=Usage)


async def run_kp_turn(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    user_message: str,
    *,
    history_key: str | None = None,
    max_rounds: int = 12,
    output_review: Callable[[str], str] | None = None,
) -> KPTurnResult:
    """Drive one AI-KP turn to completion and return its `KPTurnResult`.

    `history_key` defaults to `f"chat_history.{ctx.chat_key}"` (room-scoped,
    like the other conversation-level store keys `core.prompt_sections`
    reads). `output_review`, if given, post-processes the final reply (e.g.
    an M2 output censor) — it runs on the fallback text too, if `max_rounds`
    was exhausted.
    """
    i18n = services.i18n.with_locale(ctx.locale)
    # AgentCtx instances may be reused by gateways. Never let a direct tool call
    # or an earlier turn's unconsumed dice payload attach to this turn's trace.
    ctx.consume_dice()
    system_prompt = await build_system_prompt(ctx, services)
    # Layer B.2 -- allowed-tools enforcement (docs/plugins.md "Layer B"): the union
    # of `allowed_tools` across every KP skill enabled for this room. With no
    # skills enabled (or none of them declaring gated tools) this is `set()`, so
    # `toolset.schemas()`/`toolset.dispatch()` behave exactly as before gating
    # existed -- see `Toolset.schemas`'s docstring.
    unlocked = await unlocked_tools_for(services.store, ctx.chat_key)

    key = history_key or f"chat_history.{ctx.chat_key}"
    history = await _load_history(services, key)

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        *history,
        {"role": "user", "content": user_message},
    ]

    tool_trace: list[dict] = []
    reply: str | None = None
    rounds = 0
    # Accumulated across MAIN loop rounds only -- the dice-first corrective phase
    # (`_run_dice_correction`, below) makes its own `services.llm.chat` calls but
    # deliberately does NOT fold them in here (see its docstring): the corrective
    # is a bounded, best-effort repair pass, not part of what a context% meter
    # should describe as "this turn's usage".
    turn_usage = Usage()

    for round_index in range(1, max_rounds + 1):
        rounds = round_index
        try:
            result = await _chat_with_continuation_cleanup(
                services,
                messages,
                tools=toolset.schemas(unlocked),
                tool_choice="auto",
                temperature=services.settings.llm.temperature,
            )
        except Exception as exc:
            # A real provider error (network/rate-limit/auth/SDK) must degrade to a friendly,
            # localized diagnosis (or the generic unavailable fallback), never crash the turn.
            # We return early WITHOUT persisting history or refreshing the recap (nothing useful
            # happened this turn, and the summarizer LLM would just fail again). `usage` stays
            # the default all-zero `Usage()` -- nothing usable came back.
            logger.warning("KP turn aborted: LLM chat failed", exc_info=True)
            category = getattr(exc, "category", "")
            code = getattr(exc, "code", "")
            if code in {"subscription_relogin_required", "subscription_refresh_failed"}:
                category = "auth"
            message_key = {
                "transient": "loop.provider_transient",
                "auth": "loop.provider_auth",
                "quota": "loop.provider_quota",
                "content": "loop.provider_content",
            }.get(category, "loop.unavailable")
            reply = i18n.t(message_key)
            _clear_llm_continuation(services, messages)
            if output_review is not None:
                reply = output_review(reply)
            return KPTurnResult(reply=reply, tool_trace=tool_trace, rounds=rounds)

        _accumulate_usage(turn_usage, result)

        if result.tool_calls:
            try:
                await _dispatch_and_record(toolset, ctx, result, messages, tool_trace, unlocked)
            except (asyncio.CancelledError, Exception):
                _clear_llm_continuation(services, messages)
                raise
            continue

        reply = result.content or ""
        break

    # `reply` is still `None` here exactly when every round returned tool calls and
    # `max_rounds` ran out without ever reaching a plain-text reply -- captured BEFORE
    # the dice-first correction below (which may itself set `reply`) so the usage
    # decision reflects whether THIS turn ever produced a real reply, not whatever the
    # corrective phase did afterwards.
    max_rounds_exhausted = reply is None

    # Dice-first enforcement: if no real dice were rolled this turn yet a check
    # plausibly should have -- either the model's reply narrates/asks for one, OR
    # the player's action plausibly attempts a skill-checkable thing -- run one
    # bounded corrective round (see the enforcement note above). Cheap
    # `_dice_rolled` gate first so the detectors only run when it might matter;
    # skipped entirely on the max_rounds fallback (reply is still None) and after
    # a provider error (returned early above).
    pre_correction_reply = reply

    if (
        reply is not None
        and not _dice_rolled(tool_trace)
        and (_reply_requests_or_resolves_check(reply) or _player_attempts_checkable_action(user_message))
    ):
        reply = await _run_dice_correction(
            ctx,
            services,
            toolset,
            messages,
            tool_trace,
            reply,
            user_message,
            i18n,
            unlocked,
            temperature=services.settings.llm.temperature,
        )

    # Scene/time HUD enforcement: a self-drawn scene title is a high-confidence
    # sign that the Keeper changed scene/time in prose but skipped the
    # deterministic bookkeeping tools. Run after dice correction but key off the
    # original plain-text reply too, so a dice repair cannot hide a stale-HUD
    # transition that was present in the first reply.
    if pre_correction_reply is not None and _reply_draws_scene_title(pre_correction_reply) and not _state_bookkeeping_done(tool_trace):
        reply = await _run_state_correction(
            ctx,
            services,
            toolset,
            messages,
            tool_trace,
            reply or pre_correction_reply,
            pre_correction_reply,
            i18n,
            unlocked,
            temperature=services.settings.llm.temperature,
        )

    if reply is None:  # max_rounds exhausted without ever reaching a plain-text reply
        reply = i18n.t("loop.max_rounds")

    _clear_llm_continuation(services, messages)
    if output_review is not None:
        reply = output_review(reply)

    await _persist_history(services, key, history, user_message, reply)
    # Fold this turn into the rolling "story so far" recap when one is due, so
    # the KP keeps facts established far earlier in the session even after they
    # scroll out of the ~20-message replay window. Best-effort: never fatal.
    await maybe_refresh_session_recap(ctx, services, history_key=key)

    return KPTurnResult(
        reply=reply,
        tool_trace=tool_trace,
        rounds=rounds,
        usage=Usage() if max_rounds_exhausted else turn_usage,
    )


def _accumulate_usage(turn_usage: Usage, result: ChatResult) -> None:
    """Fold one main-loop round's `ChatResult.usage` into the turn's running total, in place.

    `completion_tokens` SUMS across rounds (each round produced genuinely new
    completion tokens). `prompt_tokens`/`total_tokens`/`cache_hit_tokens`/
    `cache_miss_tokens` are LAST-WINS -- the latest round's numbers describe the
    full current context (prior turns + this round's tool chatter), which is what
    a context% meter wants, not a sum. A no-op when `result.usage` is `None`
    (every `FakeLLM` result, and any real provider call `parse_usage` couldn't
    make sense of), so `turn_usage` stays all-zero exactly like before this
    feature existed.
    """
    if result.usage is None:
        return
    turn_usage.completion_tokens += result.usage.completion_tokens
    turn_usage.prompt_tokens = result.usage.prompt_tokens
    turn_usage.total_tokens = result.usage.total_tokens
    turn_usage.cache_hit_tokens = result.usage.cache_hit_tokens
    turn_usage.cache_miss_tokens = result.usage.cache_miss_tokens


def _clear_llm_continuation(services: Services, messages: list[dict]) -> None:
    """Release optional provider state after a conversation list is retired."""
    clear = getattr(services.llm, "clear_continuation", None)
    if callable(clear):
        try:
            clear(messages)
        except Exception:
            logger.debug("LLM continuation cleanup failed", exc_info=True)


async def _chat_with_continuation_cleanup(
    services: Services,
    messages: list[dict],
    *,
    tools: list[dict],
    tool_choice: str | dict,
    temperature: float | None,
) -> ChatResult:
    """Call the LLM and release list-owned state if the turn is cancelled."""
    try:
        return await services.llm.chat(
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
        )
    except asyncio.CancelledError:
        _clear_llm_continuation(services, messages)
        raise


def _correction_base_messages(messages: list[dict]) -> list[dict]:
    """Copy durable context without this turn's provider-specific tool chatter."""
    return [
        message
        for message in messages
        if message.get("role") != "tool"
        and not (message.get("role") == "assistant" and message.get("tool_calls"))
    ]


def _assistant_tool_call_message(result: ChatResult) -> dict:
    """Render an assistant turn's tool calls in the OpenAI message shape."""
    return {
        "role": "assistant",
        "content": result.content,
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": json.dumps(call.arguments, ensure_ascii=False)},
            }
            for call in result.tool_calls
        ],
    }


def _schemas_for_tool_names(toolset: Toolset, unlocked: set[str] | None, names: frozenset[str]) -> list[dict]:
    """Return schemas for the named tools that are available in this turn."""
    schemas = []
    for schema in toolset.schemas(unlocked):
        try:
            name = schema["function"]["name"]
        except (KeyError, TypeError):
            continue
        if name in names:
            schemas.append(schema)
    return schemas


async def _dispatch_and_record(
    toolset: Toolset,
    ctx: AgentCtx,
    result: ChatResult,
    conversation: list[dict],
    tool_trace: list[dict],
    unlocked: set[str] | None = None,
) -> None:
    """Dispatch one assistant round's tool calls, feeding results back into `conversation` + `tool_trace`.

    Shared by the main loop and the dice-first corrective round so both record
    the trace identically. Mutates `conversation` and `tool_trace` in place.
    `unlocked` (Layer B.2 -- see `Toolset.dispatch`) is the room's set of
    unlocked gated-tool names; `None`/empty means no gated tool is callable.
    """
    conversation.append(_assistant_tool_call_message(result))
    for call in result.tool_calls:
        tool_result = await toolset.dispatch(call.name, ctx, call.arguments, unlocked)
        trace_entry = {
            "name": call.name,
            "arguments": call.arguments,
            "keeper_only": toolset.is_keeper_only(call.name),
            "result": tool_result,
        }
        dice_payloads = ctx.consume_dice()
        if dice_payloads:
            trace_entry["dice_payloads"] = dice_payloads
        tool_trace.append(trace_entry)
        conversation.append({"role": "tool", "tool_call_id": call.id, "content": tool_result})


async def _run_dice_correction(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    messages: list[dict],
    tool_trace: list[dict],
    prior_reply: str,
    user_message: str,
    i18n,
    unlocked: set[str] | None = None,
    *,
    temperature: float | None,
) -> str:
    """One bounded, one-shot corrective phase that FORCES a dice resolution, then re-narrates.

    A SOFT nudge did not work: play-testing showed the real Keeper (DeepSeek)
    took the old escape-hatch nudge EVERY time -- the corrective fired but rolled
    on 0 turns. So the FIRST corrective round now compels a tool call via
    `tool_choice="required"` (the OpenAI-compatible "must call some tool" value):
    the model MUST call a tool, and the accompanying instruction directs it to
    skill_check / sanity_check / roll_dice / opposed_check to resolve the pending
    check. If a real dice tool fires, one more NORMAL (`tool_choice="auto"`) round
    narrates the graded outcome.

    The nudge quotes `user_message` -- THE CURRENT player's just-submitted action --
    verbatim, so the forced roll and its re-narration bind to *this* turn's action
    rather than drifting onto a stale earlier one still in the replayed window
    (a real play-test failure: a forced roll narrated the previous player's action).

    Bounded to at most `_CORRECTIVE_MAX_ROUNDS` chat calls (one forced + one
    narration) and entered at most once per turn, so it can never loop.
    Non-recursive. Non-fatal / best-effort -- ALL of these fall back to keeping
    `prior_reply` (that is the ceiling; we never loop chasing a roll):
      * a provider error, OR a provider that rejects `tool_choice="required"`;
      * the forced round returning prose instead of a tool call (provider ignored
        "required");
      * the forced round calling a NON-dice tool (e.g. get_character_sheet) -- so
        no real dice were rolled.
    Any dice tool the model does call is dispatched for real and recorded into
    `tool_trace`.
    """
    convo = [
        *_correction_base_messages(messages),
        {"role": "assistant", "content": prior_reply},
        {"role": "user", "content": i18n.t("loop.dice_correction", action=user_message)},
    ]
    reply = prior_reply
    for round_index in range(_CORRECTIVE_MAX_ROUNDS):
        # Round 0 FORCES a tool call ("required"); the follow-up narration round is
        # a normal "auto" call.
        forced = round_index == 0
        try:
            # Deliberately NOT folded into `turn_usage`/`KPTurnResult.usage` (see
            # `run_kp_turn`'s comment where `turn_usage` is declared): this corrective
            # phase is a bounded repair pass, not part of the turn's headline usage.
            result = await _chat_with_continuation_cleanup(
                services,
                convo,
                tools=toolset.schemas(unlocked),
                tool_choice="required" if forced else "auto",
                temperature=temperature,
            )
        except Exception:
            if not forced:
                # Best-effort: a provider error on the narration round keeps the original reply.
                logger.warning("dice-first correction skipped: LLM chat failed", exc_info=True)
                _clear_llm_continuation(services, convo)
                return prior_reply
            # DeepSeek v4-pro's thinking mode (server-side DEFAULT, and the recommended Keeper)
            # rejects tool_choice="required" with a 400 — caught live by the nightly red-line
            # gate. Deliberately NOT worked around by disabling thinking per-call: the models
            # that reject "required" are exactly the strong thinking models that already roll
            # voluntarily (first gate run: dice-miss 0.0 even with every forced round erroring),
            # while the weak models that DO need compulsion don't run thinking mode and never
            # take this path. So one plain "auto" retry — the corrective nudge alone — is the
            # whole fallback; the nightly dice-miss metric watches for that assumption ever
            # going stale. Bounded: at most one extra chat call, once per turn.
            try:
                result = await _chat_with_continuation_cleanup(
                    services,
                    convo,
                    tools=toolset.schemas(unlocked),
                    tool_choice="auto",
                    temperature=temperature,
                )
            except Exception:
                logger.warning("dice-first correction skipped: LLM chat failed", exc_info=True)
                _clear_llm_continuation(services, convo)
                return prior_reply
        if result.tool_calls:
            try:
                await _dispatch_and_record(toolset, ctx, result, convo, tool_trace, unlocked)
            except (asyncio.CancelledError, Exception):
                _clear_llm_continuation(services, convo)
                raise
            if forced and not _dice_rolled(tool_trace):
                # Forced a NON-dice tool (e.g. get_character_sheet): no real dice
                # rolled -- that's the ceiling, keep the reply, do not loop.
                _clear_llm_continuation(services, convo)
                return prior_reply
            continue
        if forced:
            # Provider ignored "required" and returned prose instead of a tool
            # call: ceiling, keep the original reply.
            _clear_llm_continuation(services, convo)
            return prior_reply
        # Narration round: the model re-narrated per the freshly rolled dice.
        reply = result.content or prior_reply
        break
    _clear_llm_continuation(services, convo)
    return reply


async def _run_state_correction(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    messages: list[dict],
    tool_trace: list[dict],
    prior_reply: str,
    observed_reply: str,
    i18n,
    unlocked: set[str] | None = None,
    *,
    temperature: float | None,
) -> str:
    """One bounded repair pass for prose-only scene/time transitions.

    The model sometimes draws a scene card in text ("Place | time") while
    forgetting that the actual HUD reads deterministic `kp_notes` and
    `game_clock` state. This mirrors the dice-first repair shape: force one tool
    round, accept it only if it performs relevant bookkeeping, then allow one
    normal narration round. Best-effort and non-fatal; failure keeps
    `prior_reply`.
    """
    title_lines = _scene_title_lines(observed_reply)
    title = title_lines[0] if title_lines else observed_reply[:160]
    state_tools = _schemas_for_tool_names(toolset, unlocked, _STATE_BOOKKEEPING_TOOL_NAMES)
    if not state_tools:
        return prior_reply
    convo = [
        *_correction_base_messages(messages),
        {"role": "assistant", "content": prior_reply},
        {"role": "user", "content": i18n.t("loop.state_correction", title=title)},
    ]
    reply = prior_reply
    correction_start = len(tool_trace)
    for _round_index in range(_STATE_CORRECTIVE_MAX_ROUNDS):
        forced = not _state_bookkeeping_done(tool_trace[correction_start:])
        try:
            result = await _chat_with_continuation_cleanup(
                services,
                convo,
                tools=state_tools,
                tool_choice="required" if forced else "auto",
                temperature=temperature,
            )
        except Exception:
            if not forced:
                logger.warning("state correction skipped: LLM chat failed", exc_info=True)
                _clear_llm_continuation(services, convo)
                return prior_reply
            try:
                result = await _chat_with_continuation_cleanup(
                    services,
                    convo,
                    tools=state_tools,
                    tool_choice="auto",
                    temperature=temperature,
                )
            except Exception:
                logger.warning("state correction skipped: LLM chat failed", exc_info=True)
                _clear_llm_continuation(services, convo)
                return prior_reply
        if result.tool_calls:
            try:
                await _dispatch_and_record(toolset, ctx, result, convo, tool_trace, unlocked)
            except (asyncio.CancelledError, Exception):
                _clear_llm_continuation(services, convo)
                raise
            continue
        if forced:
            _clear_llm_continuation(services, convo)
            return prior_reply
        reply = result.content or prior_reply
        break
    _clear_llm_continuation(services, convo)
    return reply


async def _load_history(services: Services, key: str) -> list[dict]:
    """Load the last `_HISTORY_CAP` persisted history messages for `key` (`[]` if unset/invalid)."""
    raw = await services.store.get(user_key="", store_key=key)
    if not raw:
        return []
    try:
        history = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(history, list):
        return []
    return history[-_HISTORY_CAP:]


async def _persist_history(services: Services, key: str, prior: list[dict], user_message: str, reply: str) -> None:
    """Append this turn's user message + final reply (NOT tool chatter) to history, capped."""
    updated = [*prior, {"role": "user", "content": user_message}, {"role": "assistant", "content": reply}]
    updated = updated[-_HISTORY_CAP:]
    await services.store.set(user_key="", store_key=key, value=json.dumps(updated, ensure_ascii=False))
