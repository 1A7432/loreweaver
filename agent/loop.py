"""The AI-KP multi-round function-calling loop.

Per the M1 spec (``docs/specs/M1.md`` §6.5), one player turn is driven as:
build the system prompt, replay a capped window of prior turn history from
the store, then repeatedly call ``services.llm.chat(...)`` with the
toolset's schemas attached. Every round that comes back with tool calls is
dispatched through ``toolset.dispatch`` and fed back as ``role="tool"``
messages (recorded to ``tool_trace`` for auditing/tests); the first round
that comes back with no tool calls supplies the final reply. If
``max_rounds`` is exhausted without ever reaching a plain-text reply, one
tools-disabled finalizer narrates the already-committed public tool results.
Only if that finalizer fails is a localized deterministic fallback used.

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
import functools
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from functools import lru_cache

from agent.chronicle import advance_chronicle_turn, chronicle_turn, maybe_fold_chronicle, summary_through_turn
from agent.context import AgentCtx
from agent.hook_runtime import apply_hook_writes, load_room_hook_engine
from agent.kp_tools_subsystems import dispatch_subsystem, room_rulepack, subsystem_schemas
from agent.prompt_builder import build_system_prompt_parts
from agent.services import Services
from agent.session_recap import maybe_refresh_session_recap
from agent.tools import Toolset
from core.hooks import MAX_PANEL_EVENTS_PER_TURN
from core.mvu_compat import mvu_apply_text
from core.rulepacks import (
    RulePack,
    all_check_terms,
    all_command_words,
    all_outcome_labels,
    all_subsystem_tool_names,
)
from core.skills import unlocked_tools_for
from infra.i18n import t
from infra.llm import CACHE_BREAKPOINT_KEY, HISTORY_TURN_KEY, ChatResult, Usage

logger = logging.getLogger(__name__)

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
# rolled or deterministically adjusted, so no correction is needed. The engine
# names only its own generic tools; every pack-declared subsystem tool joins
# at runtime (`core.rulepacks.all_subsystem_tool_names` — the same union
# pattern as `all_check_terms`).
_BASE_DICE_TOOL_NAMES = frozenset({"skill_check", "roll_dice"})


def _dice_tool_names() -> frozenset[str]:
    return _BASE_DICE_TOOL_NAMES | all_subsystem_tool_names()

# Tools that update the deterministic HUD/world-state fields. A scene transition
# narrated only in prose leaves the HUD reading stale `kp_notes` / `game_clock`
# values, so a high-confidence self-drawn scene title triggers a bounded repair
# pass unless one of these bookkeeping calls already fired this turn.
_STATE_BOOKKEEPING_TOOL_NAMES = frozenset({"kp_note", "game_clock"})

# Dot-/slash-prefixed dice commands (".ra Spot Hidden", ".sc 1/1d6", "/roll") are
# unique to tabletop play; in a player-facing reply they mean the Keeper is
# telling the player to type the command instead of rolling it via a tool.
# A model occasionally writes a TOOL CALL as literal text instead of using the
# function-calling channel — foreign-harness XML dialects were observed live
# (2026-08-06: a `<Deep><use><name>mcp__…` block, its fake kp_note args carrying
# keeper-side meta into the player-visible reply). Machinery-shaped blocks are
# never legitimate narration and their payloads can hold keeper-only reasoning,
# so any wrapper that contains tool-call markers is stripped WHOLE, content
# unseen — the same fail-closed stance as the ST template scrub.
_TEXT_TOOL_CALL_WRAPPER_RE = re.compile(
    r"<(Deep|use|tool_call|tool_use|function_call|function_calls|invoke)\b[^>]*>.*?</\1\s*>",
    re.DOTALL | re.IGNORECASE,
)
_TEXT_TOOL_CALL_MARKER_RE = re.compile(
    r"<\s*(?:name|tool_name|args|arguments|parameter)\b|mcp__", re.IGNORECASE
)


def _strip_text_tool_calls(reply: str) -> str:
    """Remove tool-call-shaped machinery blocks a model wrote as plain text."""

    def _drop_if_machinery(match: re.Match[str]) -> str:
        return "" if _TEXT_TOOL_CALL_MARKER_RE.search(match.group(0)) else match.group(0)

    cleaned = _TEXT_TOOL_CALL_WRAPPER_RE.sub(_drop_if_machinery, reply)
    if cleaned == reply:
        return reply
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


# Tag-name prefixes that may open a machinery block (`_TEXT_TOOL_CALL_WRAPPER_RE`) or an
# MVU update block — while streaming, text is held from such an opener until it resolves.
_STREAM_SUSPECT_PREFIXES = (
    "deep", "use", "tool_call", "tool_use", "function_call", "function_calls", "invoke", "updatevariable",
)
_STREAM_TAG_RE = re.compile(r"\s*/?\s*([A-Za-z_][\w-]*)")


class _ReplyStreamGate:
    """Fail-closed incremental release of the in-progress reply.

    A leak cannot be streamed first and stripped later, so text leaves for the client
    only once it can no longer become part of a machinery/MVU block: everything from a
    plausible suspicious opener onward is HELD until the block closes (then dropped
    whole via `_strip_text_tool_calls`) or the round ends (unclosed suspicious tail
    dropped). The final `narrative` frame remains authoritative — clients replace the
    whole draft with it. Emission is coalesced and scheduled as ordered tasks so the
    provider's sync callback can feed the async transport."""

    def __init__(self, emit: Callable[[dict], Awaitable[None]]) -> None:
        self._emit = emit
        self._epoch = 0
        self._seq = 0
        self._pending = ""
        self._held = ""
        self._tasks: list[asyncio.Task] = []

    def begin_round(self) -> None:
        self._epoch += 1
        self._seq = 0
        self._pending = ""
        self._held = ""

    def feed(self, delta: str) -> None:
        self._held += delta
        self._release_safe()
        if len(self._pending) >= 48 or "\n" in self._pending:
            self._flush()

    def finish_round(self, *, discard: bool) -> None:
        """Round over: a tool round discards its draft (the client clears on the next
        epoch); a final round releases the held remainder through the full strip."""
        if discard:
            self._pending = ""
            self._held = ""
            return
        remainder = _strip_text_tool_calls(self._held)
        cut = self._suspect_hold_index(remainder)
        self._held = ""
        self._pending += remainder[:cut]
        self._flush()

    async def drain(self) -> None:
        for task in self._tasks:
            try:
                await task
            except Exception:
                logger.debug("reply-delta emit failed", exc_info=True)
        self._tasks.clear()

    def _suspect_hold_index(self, text: str) -> int:
        search = 0
        while True:
            idx = text.find("<", search)
            if idx == -1:
                return len(text)
            rest = text[idx + 1 :]
            if not rest.strip():
                return idx  # a trailing '<' could still become anything
            tag = _STREAM_TAG_RE.match(rest)
            if tag is None:
                search = idx + 1  # '<' into non-tag prose
                continue
            name = tag.group(1).lower()
            if any(name.startswith(p) or p.startswith(name) for p in _STREAM_SUSPECT_PREFIXES):
                return idx
            search = idx + 1

    def _release_safe(self) -> None:
        cut = self._suspect_hold_index(self._held)
        if cut < len(self._held):
            stripped = _strip_text_tool_calls(self._held)
            if stripped != self._held:
                self._held = stripped  # a machinery block completed and was dropped whole
                self._release_safe()
                return
        self._pending += self._held[:cut]
        self._held = self._held[cut:]

    def _flush(self) -> None:
        if not self._pending:
            return
        frame = {"epoch": self._epoch, "seq": self._seq, "text": self._pending}
        self._seq += 1
        self._pending = ""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._tasks.append(asyncio.ensure_future(self._emit(frame)))


# Generic dice-bot ecosystem command forms the model may emit as text (language,
# not rules); every pack-declared dialect word joins at runtime.
_BASE_DICE_COMMAND_WORDS = ("rah", "rav", "rab", "rap", "rd", "sca", "roll", "r")


def _dice_command_re() -> re.Pattern[str]:
    words = sorted({*_BASE_DICE_COMMAND_WORDS, *all_command_words()}, key=len, reverse=True)
    return _compiled_dice_command_re(tuple(words))


@functools.lru_cache(maxsize=4)
def _compiled_dice_command_re(words: tuple[str, ...]) -> re.Pattern[str]:
    return re.compile(
        r"(?<![0-9A-Za-z])[./](?:" + "|".join(re.escape(word) for word in words) + r")\b",
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
# Success-LEVEL result vocabulary: words that grade a resolved check and
# essentially never appear in pure flavour prose, so they signal the model
# already DECIDED a check's outcome. Compiled from every discovered rulepack's
# `labels:` markers (`core.rulepacks.all_outcome_labels`) — the same
# engine-stays-agnostic pattern as `all_check_terms`. Packs keep bare
# "success"/"成功" display-only (not a marker) because ordinary narration would
# trigger on it.


@lru_cache(maxsize=4)
def _compiled_outcome_markers(markers: frozenset[str]) -> tuple[str, ...]:
    return tuple(sorted(markers))


def _outcome_markers() -> tuple[str, ...]:
    return _compiled_outcome_markers(all_outcome_labels())

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
    "analyze", "analyse", "diagnose", "study",
    "attack", "strike", "punch", "stab", "slash", "shoot", "grapple", "wrestle",
    "tackle", "strangle", "choke", "fight", "pickpocket", "disarm", "track",
    "pry", "spot",
)
_PLAYER_SKILL_EN_PHRASES = (
    r"pick(?:s|ing|ed)?\s+(?:the\s+)?lock",
    r"lock[-\s]?pick\w*",
    r"look(?:s|ing|ed)?\s+(?:for|around|behind|underneath|under|inside|through|over|about|beneath)",
)
# English spelling: a silent final `e` is dropped before -ing/-ed, and a final
# consonant after a short stressed vowel is doubled. A single `(?:s|es|ed|ing)?`
# suffix for every entry cannot spell EITHER -- it produces "examineing" and
# "scaning" -- so about half the lexicon silently failed to match its own
# progressive form, and dice-first enforcement never fired on a turn phrased
# "I am scanning the map" / "examining the desk". Declaring an action in the
# progressive is entirely ordinary phrasing, so that was a wide hole. The two
# groups below carry the spelling change; everything else takes base+suffix.
#
# Irregular PAST forms (struck / swam / hid) are deliberately left out: the
# lexicon exists to catch a player DECLARING an action, which is present-tense
# by nature, and a past-tense mention is usually a report of something already
# done -- which `_PLAYER_REPORTED_EN_RE` exempts on purpose.
_PLAYER_SKILL_EN_DROP_E = frozenset(
    {
        "rummage", "investigate", "examine", "scrutinize", "scrutinise", "appraise",
        "tiptoe", "hide", "dodge", "evade", "persuade", "convince", "cajole",
        "intimidate", "menace", "coerce", "seduce", "deceive", "negotiate", "haggle",
        "interrogate", "bandage", "stabilize", "psychoanalyze", "analyze", "analyse",
        "diagnose", "strike", "grapple", "wrestle", "tackle", "strangle", "choke",
    }
)
_PLAYER_SKILL_EN_DOUBLE_FINAL = frozenset({"scan", "spot", "stab", "swim", "eavesdrop"})


def _en_verb_pattern(verb: str) -> str:
    """Regex alternative covering `verb` and its real inflected surface forms."""
    if verb in _PLAYER_SKILL_EN_DROP_E:
        # "tiptoe" keeps its `e` before -ing ("tiptoeing"), so allow both stems.
        stem = re.escape(verb[:-1])
        return rf"{stem}(?:e|es|ed|ing|eing)"
    if verb in _PLAYER_SKILL_EN_DOUBLE_FINAL:
        doubled = re.escape(verb + verb[-1])
        return rf"{re.escape(verb)}(?:s)?|{doubled}(?:ed|ing)"
    return rf"{re.escape(verb)}(?:s|es|ed|ing)?"


# Generic ACTION language only — system-specific skill NOUNS live in the rulepack
# layer (`core.rulepacks.all_check_terms`) and join the detectors at runtime, so a
# custom system's skills earn dice-first discipline with zero engine change.
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
    "查资料", "查阅",
    "鉴定", "估价", "伪装", "乔装",
    "分析", "诊断", "研究",
)


@lru_cache(maxsize=4)
def _compiled_skill_detectors(terms: frozenset[str]) -> tuple[re.Pattern[str], tuple[str, ...]]:
    """Detector pair (EN regex, ZH substring terms) for one vocabulary snapshot.

    Cached per snapshot: rulepack discovery is itself cached, so this recompiles
    only when the installed rule systems actually change (e.g. a forged pack)."""
    ascii_extra = sorted({t.lower() for t in terms if t.isascii() and len(t) >= 3}, key=len, reverse=True)
    en = re.compile(
        r"\b(?:"
        + "|".join(
            [_en_verb_pattern(w) for w in _PLAYER_SKILL_EN_WORDS]
            + list(_PLAYER_SKILL_EN_PHRASES)
            + [re.escape(t) for t in ascii_extra]
        )
        + r")\b",
        re.IGNORECASE,
    )
    cjk_extra = sorted((t for t in terms if not t.isascii()), key=len, reverse=True)
    zh = tuple(dict.fromkeys([*cjk_extra, *_PLAYER_SKILL_ZH_TERMS]))
    return en, zh


def _skill_detectors() -> tuple[re.Pattern[str], tuple[str, ...]]:
    return _compiled_skill_detectors(all_check_terms())

_PLAYER_NO_ROLL_RE = re.compile(
    r"(?:\b(?:no|without)\s+(?:a\s+)?(?:roll|check|dice)\b"  # i18n-exempt - detector lexicon
    r"|\b(?:do\s+not|don't|dont)\s+(?:roll\b|(?:make|perform|require|need)\b[^.!?\n]{0,18}"
    r"\b(?:roll|check|dice)\b)"
    r"|\bno\s+(?:roll|check)\s+is\s+(?:needed|required)\b"
    r"|(?:无需|不需|不需要|不要|不用)(?:进行|做|任何)?(?:掷骰|投骰|骰点|检定)"
    r"|不(?:进行|做|任何)?(?:掷骰|投骰|骰点|检定))",
    re.IGNORECASE,
)
_PLAYER_META_HEAD_RE = re.compile(
    r"^(?:\s*(?:ooc|meta(?:\s+request)?|out\s+of\s+character)\s*[:：-]?"
    r"|\s*(?:元请求|元指令|场外|题外)\s*[:：-]?"
    r"|\s*(?:export|audit|summarize|summarise|show|list|review)\b[^.!?\n]{0,32}"
    r"\b(?:log|report|recap|transcript|session)\b"
    r"|\s*(?:add|append|record|restate|update)\b[^.!?\n]{0,36}"
    r"\b(?:log|report|recap|transcript|session)\b"
    r"|\s*(?:导出|审计|汇总|查看|列出|复核)[^。！？\n]{0,20}(?:日志|团报|报告|记录|会话)"
    r"|\s*[^。！？\n]{0,40}(?:补进|加入|写入|补充|更新|重述)[^。！？\n]{0,24}"
    r"(?:回顾|日志|团报|报告|记录|会话))",
    re.IGNORECASE,
)
_PLAYER_OBVIOUS_OR_VOLUNTARY_RE = re.compile(
    r"(?:\b(?:visually\s+)?obvious\b|\bunambiguous\b|\bdirectly\s+visible\b"  # i18n-exempt
    r"|\bvoluntar(?:y|ily)\b|\balready\s+(?:agreed|chose|decided)\b"
    r"|显而易见|毫无遮挡|毫无歧义|直接可见|自愿回答|主动说明|已经同意)",
    re.IGNORECASE,
)
_PLAYER_EN_CLAUSE_SPLIT_RE = re.compile(r"\b(?:and|then|while|because|but)\b|[,.!?;\n]", re.IGNORECASE)
_PLAYER_ZH_CLAUSE_SPLIT_RE = re.compile(r"(?:然后|并且|随后|但是|不过|因为)|[，,。！？；\n]")
_PLAYER_REPORTED_EN_RE = re.compile(
    r"\b(?:mention|say|tell|recall|remember|note|explain|report)\b",
    re.IGNORECASE,
)
_PLAYER_REPORTED_ZH_RE = re.compile(r"(?:提到|说起|告诉|回忆|记得|说明|报告|复述)")  # i18n-exempt

_REPLY_RESOLVED_EN_RE = re.compile(
    r"(?:\byou\s+(?:successfully|clearly|finally)\s+"
    r"(?:find|discover|uncover|spot|notice|identify|determine|confirm|decipher)\b"
    r"|\byou\s+(?:find|discover|uncover|spot|notice|identify|determine|confirm|decipher|"
    r"fail\s+to\s+find|cannot\s+find|can't\s+find)\b[^.!?\n]{0,72}\b"
    r"(?:hidden|concealed|secret|faint|subtle|clue|latch|trace|evidence|pattern|anomaly)\b)",
    re.IGNORECASE,
)
_REPLY_RESOLVED_ZH_RE = re.compile(
    r"(?:(?:你|调查员)(?:终于|成功|清楚地|未能|没能)(?:发现|找到了?|注意到|辨认出|确认|判断出|解读出)"
    r"|(?:你|调查员)(?:发现|找到了?|注意到|辨认出|确认|判断出|解读出)[^。！？\n]{0,36}"
    r"(?:暗门|隐藏|藏着|线索|痕迹|秘密|细微|异常|证据|规律|破绽))"  # i18n-exempt
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


# Structural "a dice result is stated here" detector -- deliberately NOT a
# judgement about whether a check *should* have happened.
#
# Every other detector in this module is a heuristic guess at intent, and a
# heuristic's blind spots are invisible to a gate built on that same heuristic
# (see `scripts/playtest.py`'s forged-dice metric). This one keys off the
# SHAPE dice resolution leaves in prose:
#   - a roll-vs-target pair, "22 vs 25" / "47 vs. 65" / "22 对 25"
#   - a d-notation total, "1d100 = 47"
# A bare "22/25" slash pair is deliberately NOT one: ordinary prose has ratios
# and scores in it ("the odds are 50/50"), and `vs` alone is specific enough.
# Both are what the real dice tools render, so a reply containing one either came
# from a tool call or the model invented the numbers. Bare "success"/"roll"
# deliberately stay inert (they are ordinary prose -- see the negatives in
# tests/agent/test_loop.py).
_REPLY_DICE_RESULT_RE = re.compile(
    r"(?:\b\d{1,3}\s*(?:vs\.?|versus|對|对)\s*\d{1,3}\b"
    r"|\b\d{0,3}d\d{1,3}(?:\s*[+-]\s*\d{1,3})?\s*(?:=|＝|->|→|:|：)\s*\d{1,4}\b)",
    re.IGNORECASE,
)


# A die emoji next to a result word is the OTHER shape a stated outcome takes --
# "🎲 **Intimidate — Fumble.**" with the numbers omitted. 🎲 essentially never
# appears in ordinary narration, which is what lets the bare result words
# ("fumble", "success", 成功/失败) be trusted here while they stay untrusted on
# their own: the rulepack label markers cannot list "fumble" as a substring,
# because "you fumble with the lock" is plain prose, not a rolled result.
_REPLY_DICE_MARKUP_RE = re.compile(
    r"🎲[^\n]{0,80}?(?:fumble|success|failure|\bfail(?:s|ed)?\b|成功|失败)",
    re.IGNORECASE,
)


def _reply_states_a_dice_outcome(reply: str) -> bool:
    """True if `reply` states a concrete dice result in prose (roll-vs-target or `NdM = total`).

    Purely structural, by design: paired with `_dice_rolled` it identifies a
    FORGED roll -- numbers presented to players that `core.dice_engine` never
    produced -- without asking the ambiguous question of whether this turn
    warranted a check at all.
    """
    if not reply:
        return False
    return bool(_REPLY_DICE_RESULT_RE.search(reply) or _REPLY_DICE_MARKUP_RE.search(reply))


def _dice_rolled(tool_trace: list[dict]) -> bool:
    """True if any real dice-rolling tool fired during this turn."""
    return any(
        entry.get("name") in _dice_tool_names() and not entry.get("suppressed")
        for entry in tool_trace
    )


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
    if _dice_command_re().search(reply) or _ROLL_REQUEST_EN_RE.search(reply) or _ROLL_REQUEST_ZH_RE.search(reply):
        return True
    # A stated dice result counts however it is written. The success-LEVEL
    # vocabulary below misses any result phrased without a level word -- a live
    # gate let `🎲 Spot Hidden — 22 vs 25 (Success!)` and
    # `🎲 Intimidate — Fumble. (rolled 99 vs 15)` straight through, with no dice
    # tool called on either turn -- so the structural shapes count too, and the
    # corrective round now gets a chance to replace invented numbers with a roll.
    if _reply_states_a_dice_outcome(reply):
        return True
    lowered = reply.lower()
    return (
        any(marker in lowered for marker in _outcome_markers())
        or bool(_REPLY_RESOLVED_EN_RE.search(reply))
        or bool(_REPLY_RESOLVED_ZH_RE.search(reply))
    )


def _player_declares_no_roll_context(text: str) -> bool:
    """High-confidence whole-message exemption for no-roll and meta requests."""
    stripped = (text or "").strip()
    if not stripped:
        return False
    if stripped.startswith((".", "/")):
        return True
    return bool(
        _PLAYER_NO_ROLL_RE.search(stripped)
        or _PLAYER_META_HEAD_RE.search(stripped)
    )


def _player_attempts_checkable_action(text: str) -> bool:
    """Heuristic: does the player's inbound `text` plausibly attempt a skill-checkable action?

    Broad but curated (see the enforcement note above): a whole-word/boundary
    match against the EN skill-attempt lexicon, or a curated CJK term. Deliberately
    excludes dialogue-dominant words so pure roleplay stays inert. A hit triggers
    the SAME bounded corrective, whose forced round now compels a real roll.
    """
    if not text:
        return False
    if _player_declares_no_roll_context(text):
        return False
    # Inspect each declared action clause, not arbitrary substrings in the whole
    # message. This catches a second action after "and/然后" while ignoring a
    # skill word embedded under "I mention that we searched yesterday". An
    # obvious/voluntary exemption applies only to the clause it describes; it
    # must never mask a later uncertain action in the same message.
    skill_en_re, skill_zh_terms = _skill_detectors()
    for english_clause in _PLAYER_EN_CLAUSE_SPLIT_RE.split(text):
        english_head = " ".join(english_clause.split()[:12])
        match = skill_en_re.search(english_head)
        if match is None:
            continue
        prefix = english_head[: match.start()]
        if _PLAYER_REPORTED_EN_RE.search(prefix):
            continue
        if _PLAYER_OBVIOUS_OR_VOLUNTARY_RE.search(english_clause):
            continue
        return True
    for chinese_clause in _PLAYER_ZH_CLAUSE_SPLIT_RE.split(text):
        chinese_head = chinese_clause[:28]
        for term in skill_zh_terms:
            index = chinese_head.find(term)
            if index < 0:
                continue
            if _PLAYER_REPORTED_ZH_RE.search(chinese_head[:index]):
                continue
            if _PLAYER_OBVIOUS_OR_VOLUNTARY_RE.search(chinese_clause):
                continue
            return True
    return False


def _player_forbids_dice(text: str) -> bool:
    """Return whether this submission has a high-confidence no-dice contract.

    Explicit no-roll/meta requests always win. An obvious/voluntary marker also
    wins when no separate uncertain action clause remains; this preserves a
    later checkable action in composite messages.
    """
    if _player_declares_no_roll_context(text):
        return True
    return bool(_PLAYER_OBVIOUS_OR_VOLUNTARY_RE.search(text or "")) and not _player_attempts_checkable_action(text)


@dataclass
class KPTurnResult:
    """One AI-KP turn's outcome."""

    reply: str  # final player-visible text (already `output_review`-ed)
    tool_trace: list[dict]  # [{name, arguments, keeper_only, result}, ...] in call order
    rounds: int  # how many function-calling rounds this turn took
    # Token/cache usage accumulated across this turn's main loop and, when
    # max_rounds is exhausted, its one tools-disabled finalizer. Provider-error
    # early returns stay all-zero; FakeLLM results without usage stay all-zero.
    usage: Usage = field(default_factory=Usage)
    # Validated emitUI() emissions from this turn's hooks, in fire order (turn_start
    # first, then the reply phases). Each dict is one protocol-v1.7 `ui` frame payload
    # ({blocks, panel, id?, replace?}) that `gateway.turn.run_turn` broadcasts right
    # after the KP narrative. Empty whenever hooks are inert.
    ui_frames: list[dict] = field(default_factory=list)
    # Validated emitPanel() emissions (protocol v1.8), capped per turn; each dict is one
    # `panel_event` payload ({panel, payload}) `gateway.turn.run_turn` delivers only to
    # viewers whose panel manifest contains that panel. Empty whenever hooks are inert.
    panel_events: list[dict] = field(default_factory=list)


async def run_kp_turn(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    user_message: str,
    *,
    history_key: str | None = None,
    max_rounds: int = 12,
    output_review: Callable[[str], str] | None = None,
    on_reply_delta: Callable[[dict], Awaitable[None]] | None = None,
) -> KPTurnResult:
    """Drive one AI-KP turn to completion and return its `KPTurnResult`.

    `on_reply_delta`, if given, receives `{"epoch", "seq", "text"}` slices of the
    in-progress reply as the model generates it, released through the fail-closed
    `_ReplyStreamGate` (machinery/MVU blocks can never stream). A tool round's draft
    is discarded (clients clear on the next epoch); the final `reply` remains the
    authoritative text clients reconcile to.

    `history_key` defaults to the room_state key ``"chat_history"`` (room-scoped
    by the room_state table's room column). `output_review`, if given, post-processes the final reply (e.g.
    an M2 output censor) — it runs on the finalizer or fallback text too, if
    `max_rounds` was exhausted.
    """
    i18n = services.i18n.with_locale(ctx.locale)
    # AgentCtx instances may be reused by gateways. Never let a direct tool call
    # or an earlier turn's unconsumed dice payload attach to this turn's trace.
    ctx.consume_dice()
    # Event hooks (Layer C — core.hooks): one sandboxed engine per turn, inert (None) when
    # nothing is registered. turn_start fires BEFORE prompt assembly so its inject() texts and
    # variable writes shape this very turn; every later phase fires in the finalization block
    # below. Hook failures never break a turn (each fire is internally fail-safe).
    hook_engine = await load_room_hook_engine(services, ctx)
    hook_writes_this_turn: list[str] = []
    hook_ui_frames: list[dict] = []
    hook_panel_events: list[dict] = []
    ctx.extra.pop("hook_injections", None)  # reused ctx must not leak a prior turn's injections
    ctx.extra.pop("clock_advances", None)  # same for a prior turn's unconsumed clock records
    # This turn's player message doubles as the worldbook retrieval context —
    # `agent.prompt_builder` reads `extra["user_message"]` for `worldbook.match`. Nothing
    # else ever wrote this key, which left live-play lorebook injection retrieving against
    # an empty context (found by the 2026-08-05 imported-card play-test): imported cards'
    # keyword entries could never fire outside archived-session recaps.
    ctx.extra["user_message"] = user_message
    if hook_engine is not None:
        outcome = hook_engine.fire("turn_start", {"user_message": user_message, "actor": ctx.user_id})
        hook_writes_this_turn += await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        hook_ui_frames += outcome.ui_blocks
        hook_panel_events += outcome.panel_events
        if outcome.injections:
            ctx.extra["hook_injections"] = outcome.injections
    # M18 campaign chronicle: the context-pressure fold runs BEFORE prompt assembly —
    # measured from last turn's usage meter, an over-trigger (or over-ceiling) room
    # folds its oldest chronicle records into the rolling campaign summary before this
    # turn's model call, so the emergency ceiling always has headroom for the fold
    # generation itself. Best-effort: never raises; a no-op when disabled, when no
    # meter exists yet (a room's first turn), or under the trigger.
    await maybe_fold_chronicle(ctx, services)
    system_prompt = await build_system_prompt_parts(ctx, services)
    # Layer B.2 -- allowed-tools enforcement (docs/plugins.md "Layer B"): the union
    # of `allowed_tools` across every KP skill enabled for this room. With no
    # skills enabled (or none of them declaring gated tools) this is `set()`, so
    # `toolset.schemas()`/`toolset.dispatch()` behave exactly as before gating
    # existed -- see `Toolset.schemas`'s docstring.
    unlocked = await unlocked_tools_for(services.store, ctx.chat_key)
    # Stage D tool materialization: the room's rulepack declares which subsystem
    # tools exist here (a system that declares none materializes none), and their
    # schemas ride alongside the static toolset for this turn.
    room_pack = await room_rulepack(services, ctx)
    subsystem_tools = subsystem_schemas(room_pack)

    key = history_key or "chat_history"
    # M20 A2: history is APPEND-ONLY between folds — the sliding window is gone, because
    # dropping its front every turn invalidated every downstream cache prefix. The one
    # truncation point is the chronicle fold: what the rolling summary has absorbed
    # (`through_turn`) is exactly what history no longer needs to replay, and the fold's
    # own no-future watermark (M18's 4-turn lag) guarantees recent turns are never cut.
    history = await _load_history(services, ctx.chat_key, key)
    history = await _trim_folded_history(services, ctx.chat_key, key, history)
    # The turn now in flight — completed turns + 1, the same stamp `record_entry` uses,
    # so a history message and a chronicle record made this turn carry the same index.
    turn_index = await chronicle_turn(services.store, ctx.chat_key) + 1

    # ONE assembler, ONE object (iron rule #5) — but two wire slots (M20 A1). The stable
    # head rides the system message; the volatile tail becomes a `state` message directly
    # before the player's, so the prefix through the end of history stays byte-identical
    # between folds instead of being invalidated every turn by the tail.
    # `_lw_cache_breakpoint` is agent->adapter metadata marking each boundary: the
    # Anthropic path turns it into a `cache_control` breakpoint, the OpenAI-compatible
    # path strips it and caches by prefix on its own. It never reaches a vendor's wire
    # (`infra.llm.wire_messages`).
    messages: list[dict] = []
    if system_prompt.stable:
        messages.append({"role": "system", "content": system_prompt.stable, CACHE_BREAKPOINT_KEY: True})
    # Marked on a COPY: `history` itself is what gets persisted back, and a wire-only
    # breakpoint mark has no business in the store.
    messages.extend([*history[:-1], {**history[-1], CACHE_BREAKPOINT_KEY: True}] if history else [])
    if system_prompt.volatile:
        # A user-role message, not a second system one: mid-conversation system messages
        # are model- and vendor-specific, while every provider path here takes a user
        # turn unchanged. The header names it as engine state so the Keeper never reads
        # the state dump as something a player said.
        messages.append(
            {"role": "user", "content": i18n.t("prompt.state_header") + "\n\n" + system_prompt.volatile}
        )
    messages.append({"role": "user", "content": user_message})

    tool_trace: list[dict] = []
    reply: str | None = None
    rounds = 0
    dice_forbidden = _player_forbids_dice(user_message)
    # Accumulated across MAIN loop rounds and the max-rounds finalizer. The
    # dice-first corrective phase
    # (`_run_dice_correction`, below) makes its own `services.llm.chat` calls but
    # deliberately does NOT fold them in here (see its docstring): the corrective
    # is a bounded, best-effort repair pass, not part of what a context% meter
    # should describe as "this turn's usage".
    turn_usage = Usage()
    gate = _ReplyStreamGate(on_reply_delta) if on_reply_delta is not None else None

    for round_index in range(1, max_rounds + 1):
        rounds = round_index
        if gate is not None:
            gate.begin_round()
        try:
            result = await _chat_with_continuation_cleanup(
                services,
                messages,
                tools=[*toolset.schemas(unlocked), *subsystem_tools],
                tool_choice="auto",
                temperature=services.settings.llm.temperature,
                on_text_delta=gate.feed if gate is not None else None,
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
            return KPTurnResult(
                reply=reply,
                tool_trace=tool_trace,
                rounds=rounds,
                ui_frames=hook_ui_frames,
                panel_events=_capped_panel_events(hook_panel_events, ctx.chat_key),
            )

        _accumulate_usage(turn_usage, result)

        if result.tool_calls:
            if gate is not None:
                gate.finish_round(discard=True)
            try:
                await _dispatch_and_record(
                    toolset,
                    ctx,
                    services,
                    result,
                    messages,
                    tool_trace,
                    unlocked,
                    room_pack=room_pack,
                    max_dice_calls=0 if dice_forbidden else None,
                    dice_policy_suppressed=dice_forbidden,
                )
            except (asyncio.CancelledError, Exception):
                _clear_llm_continuation(services, messages)
                raise
            continue

        if gate is not None:
            gate.finish_round(discard=False)
        reply = result.content or ""
        break

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
        and not dice_forbidden
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
            room_pack=room_pack,
            subsystem_tools=subsystem_tools,
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
            room_pack=room_pack,
            temperature=services.settings.llm.temperature,
        )

    if reply is None:  # max_rounds exhausted without ever reaching a plain-text reply
        try:
            reply = await _run_max_rounds_finalizer(
                services,
                messages,
                tool_trace,
                i18n,
                turn_usage,
                temperature=services.settings.llm.temperature,
            )
        except asyncio.CancelledError:
            _clear_llm_continuation(services, messages)
            raise
        if reply is None:
            reply = _max_rounds_fallback(tool_trace, i18n)

    _clear_llm_continuation(services, messages)
    # MVU compatibility (imported SillyTavern cards whose scaffolding instructs the model to
    # emit <UpdateVariable> text blocks): parse the blocks, apply their commands to the room's
    # MVU variable tree through validated deterministic code, and strip the blocks from the
    # player-visible narration — the upstream extension's contract, with real code doing the
    # bookkeeping. A reply with no blocks comes back byte-identical. Best-effort: a parse/apply
    # problem must never eat the narration. Runs BEFORE output_review so the censor sees final text.
    mvu_applied: list = []
    try:
        reply, mvu_applied, _mvu_errors = await mvu_apply_text(services.documents, ctx.chat_key, reply)
    except Exception:
        logger.warning("MVU update-block processing failed", exc_info=True)
    reply = _strip_text_tool_calls(reply)

    if hook_engine is not None:
        reply, hook_writes_this_turn, reply_ui_frames, reply_panel_events = await _run_reply_hooks(
            services, ctx, hook_engine, reply, tool_trace, mvu_applied, hook_writes_this_turn
        )
        hook_ui_frames += reply_ui_frames
        hook_panel_events += reply_panel_events
    if output_review is not None:
        reply = output_review(reply)

    if gate is not None:
        await gate.drain()
    await _persist_history(services, ctx.chat_key, key, history, user_message, reply, turn=turn_index)
    # Fold this turn into the rolling "story so far" recap when one is due, so
    # the KP keeps facts established far earlier in the session even after the
    # chronicle fold stops replaying those turns verbatim. Best-effort: never fatal.
    await maybe_refresh_session_recap(ctx, services, history_key=key)
    # M18: count the completed turn — chronicle entries stamp against this counter
    # and the fold's no-future watermark derives from it. Best-effort, like the recap.
    await advance_chronicle_turn(services.store, ctx.chat_key)

    return KPTurnResult(
        reply=reply,
        tool_trace=tool_trace,
        rounds=rounds,
        usage=turn_usage,
        ui_frames=hook_ui_frames,
        panel_events=_capped_panel_events(hook_panel_events, ctx.chat_key),
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
    on_text_delta: Callable[[str], None] | None = None,
) -> ChatResult:
    """Call the LLM and release list-owned state if the turn is cancelled."""
    try:
        return await services.llm.chat(
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            on_text_delta=on_text_delta,
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


def _public_committed_results(tool_trace: list[dict], i18n) -> str:
    """Render public tool results while structurally excluding keeper-only data."""
    lines = [
        i18n.t(
            "loop.max_rounds_result",
            name=str(entry.get("name", "")),
            result=str(entry.get("result", "")).strip(),
        )
        for entry in tool_trace
        if not entry.get("keeper_only", False)
    ]
    return "\n".join(lines) if lines else i18n.t("loop.max_rounds_no_public_results")


def _max_rounds_fallback(tool_trace: list[dict], i18n) -> str:
    """Build a deterministic fallback that explicitly preserves public outcomes."""
    return "\n\n".join(
        [
            i18n.t("loop.max_rounds"),
            f'{i18n.t("loop.max_rounds_committed")}\n{_public_committed_results(tool_trace, i18n)}',
        ]
    )


async def _run_max_rounds_finalizer(
    services: Services,
    messages: list[dict],
    tool_trace: list[dict],
    i18n,
    turn_usage: Usage,
    *,
    temperature: float | None,
) -> str | None:
    """Narrate committed public results once, with tools disabled.

    The finalizer starts from durable context with all assistant tool-call and
    role=tool messages removed. Its only result block is rebuilt from
    non-keeper-only trace entries, so hidden tool output cannot enter this
    closing call or its deterministic fallback.
    """
    convo = [
        *_correction_base_messages(messages),
        {
            "role": "user",
            "content": i18n.t(
                "loop.max_rounds_finalize",
                results=_public_committed_results(tool_trace, i18n),
            ),
        },
    ]
    try:
        result = await _chat_with_continuation_cleanup(
            services,
            convo,
            tools=[],
            tool_choice="none",
            temperature=temperature,
        )
    except asyncio.CancelledError:
        # `_chat_with_continuation_cleanup` already retired `convo`.
        raise
    except Exception:
        logger.warning("max-rounds finalizer failed", exc_info=True)
        _clear_llm_continuation(services, convo)
        return None

    _clear_llm_continuation(services, convo)
    _accumulate_usage(turn_usage, result)
    return result.content.strip() if result.content and result.content.strip() else None


def _assistant_tool_call_message(result: ChatResult) -> dict:
    """Render an assistant turn's tool calls in the OpenAI message shape."""
    message = {
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
    if result.provider_blocks is not None:
        # Same-turn faithful replay (Anthropic thinking blocks must accompany their
        # assistant turn); never persisted — history keeps only user text + final reply.
        message["provider_blocks"] = result.provider_blocks
    return message


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


def _normalize_tool_arguments(call_name: str, arguments: dict | None) -> dict:
    """Drop provider-injected optional sentinels that carry no semantic value."""
    normalized = dict(arguments or {})
    if call_name != "skill_check":
        return normalized
    actor = normalized.get("actor")
    if actor is None or (isinstance(actor, str) and not actor.strip()):
        normalized.pop("actor", None)
        npc_target = normalized.get("npc_target")
        if npc_target is None or npc_target == "" or (
            isinstance(npc_target, (int, float)) and npc_target == 0
        ):
            normalized.pop("npc_target", None)
    return normalized


_EVENT_NEGATION_RE = re.compile(
    r"\b(?:no|not|never|without|failed?|unable|cannot|can't|didn't|didnt)\b|(?:没有|没能|未能|并未|不是|无法|不能)",  # i18n-exempt
    re.IGNORECASE,
)
_EVENT_EN_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "at",
        "from",
        "he",
        "her",
        "hers",
        "him",
        "his",
        "in",
        "is",
        "it",
        "its",
        "now",
        "of",
        "our",
        "she",
        "the",
        "their",
        "them",
        "they",
        "to",
        "us",
        "up",
        "was",
        "we",
        "were",
        "with",
    }
)
_EVENT_EN_SYNONYMS = {
    "acquired": "possess",
    "carried": "possess",
    "carries": "possess",
    "carrying": "possess",
    "carry": "possess",
    "claim": "possess",
    "claimed": "possess",
    "claims": "possess",
    "had": "possess",
    "has": "possess",
    "have": "possess",
    "held": "possess",
    "hold": "possess",
    "holds": "possess",
    "inventory": "possess",
    "keep": "possess",
    "keeps": "possess",
    "kept": "possess",
    "obtained": "possess",
    "own": "possess",
    "owned": "possess",
    "owns": "possess",
    "picked": "possess",
    "pocketed": "possess",
    "possessed": "possess",
    "possesses": "possess",
    "possession": "possess",
    "possessing": "possess",
    "recovered": "possess",
    "retrieved": "possess",
    "secure": "possess",
    "secured": "possess",
    "secures": "possess",
    "take": "possess",
    "taken": "possess",
    "takes": "possess",
    "took": "possess",
}
_EVENT_EN_GENERIC_ACTOR_RE = re.compile(
    r"^\s*(?:the\s+)?(?:investigators?|party|group|team)\b",  # i18n-exempt - semantic event guard
    re.IGNORECASE,
)
_EVENT_EN_GENERIC_ACTOR_TERMS = frozenset({"group", "investigator", "investigators", "party", "team"})


def _event_english_sequence(value: str) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()
    suppress_generic_holder = False
    for term in re.findall(r"[a-z0-9]+", value.casefold()):
        if term in _EVENT_EN_STOP_WORDS:
            continue
        normalized = _EVENT_EN_SYNONYMS.get(term, term)
        if normalized in seen:
            # “...recovered the key; it is now in the investigators'
            # possession” restates the same acquisition and appends only a
            # generic shared-party holder. Drop that holder when the repeated
            # possession marker proves it is boilerplate, while retaining
            # generic actors elsewhere in the event sentence.
            if normalized == "possess" and terms and terms[-1] in _EVENT_EN_GENERIC_ACTOR_TERMS:
                seen.discard(terms.pop())
            if normalized == "possess":
                suppress_generic_holder = True
            continue
        if suppress_generic_holder and normalized in _EVENT_EN_GENERIC_ACTOR_TERMS:
            suppress_generic_holder = False
            continue
        suppress_generic_holder = False
        seen.add(normalized)
        terms.append(normalized)
    return terms


def _event_description_is_semantic_duplicate(left: str, right: str) -> bool:
    """Conservative same-turn near-duplicate check for event tool calls."""
    if bool(_EVENT_NEGATION_RE.search(left or "")) != bool(_EVENT_NEGATION_RE.search(right or "")):
        return False
    generic_english_actor = bool(
        _EVENT_EN_GENERIC_ACTOR_RE.search(left or "")
        or _EVENT_EN_GENERIC_ACTOR_RE.search(right or "")
    )
    left_value = re.sub(
        r"^(?:调查员(?:一行|们)?|众人|队伍|一行人)", "", (left or "").strip()  # i18n-exempt
    )
    right_value = re.sub(
        r"^(?:调查员(?:一行|们)?|众人|队伍|一行人)", "", (right or "").strip()  # i18n-exempt
    )
    left_norm = re.sub(r"[^\w\u3400-\u9fff]+", "", left_value.casefold())
    right_norm = re.sub(r"[^\w\u3400-\u9fff]+", "", right_value.casefold())
    if not left_norm or not right_norm:
        return False
    if left_norm == right_norm:
        return True
    sequence_ratio = SequenceMatcher(None, left_norm, right_norm).ratio()
    left_en_sequence = _event_english_sequence(left)
    right_en_sequence = _event_english_sequence(right)
    left_en = set(left_en_sequence)
    right_en = set(right_en_sequence)
    if left_en and right_en:
        union = left_en | right_en
        overlap = len(left_en & right_en) / len(union) if union else 0.0
        order_ratio = SequenceMatcher(None, left_en_sequence, right_en_sequence).ratio()
        if order_ratio >= 0.72 and overlap >= 0.90:
            return True
        # A shared-party milestone may name the acting PC in one wording and
        # use “the investigators/party” in the other. Only ignore that subject
        # when one side is explicitly generic and both descriptions contain the
        # same possession/acquisition action family; other verbs and two named
        # actors retain full subject/object order above.
        if generic_english_actor and "possess" in left_en_sequence and "possess" in right_en_sequence:
            left_core = left_en_sequence[left_en_sequence.index("possess") :]
            right_core = right_en_sequence[right_en_sequence.index("possess") :]
            core_union = set(left_core) | set(right_core)
            core_overlap = len(set(left_core) & set(right_core)) / len(core_union) if core_union else 0.0
            core_order = SequenceMatcher(None, left_core, right_core).ratio()
            return core_order >= 0.90 and core_overlap >= 0.90
        return False
    # CJK single-character set overlap erases subject/object order. Sequence
    # similarity preserves it while still accepting tiny particles such as
    # “已/一行” in a restatement of the same milestone.
    return sequence_ratio >= 0.88


async def _recent_session_event_is_semantic_duplicate(
    services: Services,
    ctx: AgentCtx,
    description: str,
) -> bool:
    """Check recent persisted events so paraphrases across adjacent turns dedupe."""
    try:
        session = await services.battles.generator.get_current_session(ctx.chat_key)
    except Exception:
        logger.warning("semantic event guard could not read the current session", exc_info=True)
        return False
    if session is None:
        return False
    now = time.time()
    for event in reversed(session.key_events):
        timestamp = event.get("timestamp")
        if not isinstance(timestamp, (int, float)) or now - timestamp > 5 * 60:
            continue
        if _event_description_is_semantic_duplicate(
            str(event.get("description", "")),
            description,
        ):
            return True
    return False


async def _dispatch_and_record(
    toolset: Toolset,
    ctx: AgentCtx,
    services: Services,
    result: ChatResult,
    conversation: list[dict],
    tool_trace: list[dict],
    unlocked: set[str] | None = None,
    *,
    room_pack: RulePack | None = None,
    max_dice_calls: int | None = None,
    dice_policy_suppressed: bool = False,
) -> None:
    """Dispatch one assistant round's tool calls, feeding results back into `conversation` + `tool_trace`.

    Shared by the main loop and the dice-first corrective round so both record
    the trace identically. Mutates `conversation` and `tool_trace` in place.
    `unlocked` (Layer B.2 -- see `Toolset.dispatch`) is the room's set of
    unlocked gated-tool names; `None`/empty means no gated tool is callable.
    """
    for call in result.tool_calls:
        call.arguments = _normalize_tool_arguments(call.name, call.arguments)
    conversation.append(_assistant_tool_call_message(result))
    dice_calls_dispatched = 0
    for call in result.tool_calls:
        suppress_extra_dice = (
            max_dice_calls is not None
            and call.name in _dice_tool_names()
            and dice_calls_dispatched >= max_dice_calls
        )
        duplicate_initiative_next = (
            call.name == "initiative_tracker"
            and (call.arguments or {}).get("action") == "next"
            and any(
                entry.get("name") == "initiative_tracker"
                and (entry.get("arguments") or {}).get("action") == "next"
                for entry in tool_trace
            )
        )
        duplicate_session_event = False
        if call.name == "add_session_event":
            description = str((call.arguments or {}).get("description", ""))
            duplicate_session_event = any(
                entry.get("name") == "add_session_event"
                and not entry.get("suppressed")
                and _event_description_is_semantic_duplicate(
                    str((entry.get("arguments") or {}).get("description", "")),
                    description,
                )
                for entry in tool_trace
            )
            if not duplicate_session_event:
                duplicate_session_event = await _recent_session_event_is_semantic_duplicate(
                    services,
                    ctx,
                    description,
                )
        suppressed = False
        if suppress_extra_dice:
            message_key = (
                "loop.dice_policy.forbidden_check_suppressed"
                if dice_policy_suppressed
                else "loop.dice_correction.extra_check_suppressed"
            )
            tool_result = t(message_key, locale=ctx.locale)
            suppressed = True
        elif duplicate_initiative_next:
            tool_result = t("kp_tools.initiative.next_already_committed", locale=ctx.locale)
            suppressed = True
        elif duplicate_session_event:
            tool_result = t("kp_tools.know.session.event_duplicate", locale=ctx.locale)
            suppressed = True
        else:
            tool_result = (
                await dispatch_subsystem(services, ctx, room_pack, call.name, call.arguments)
                if room_pack is not None
                else None
            )
            if tool_result is None:
                tool_result = await toolset.dispatch(call.name, ctx, call.arguments, unlocked)
            if call.name in _dice_tool_names():
                dice_calls_dispatched += 1
        trace_entry = {
            "name": call.name,
            "arguments": call.arguments,
            "keeper_only": toolset.is_keeper_only(call.name),
            "result": tool_result,
        }
        if suppressed:
            trace_entry["suppressed"] = True
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
    room_pack: RulePack | None = None,
    subsystem_tools: list[dict] | None = None,
    temperature: float | None,
) -> str:
    """One bounded, one-shot corrective phase that FORCES a dice resolution, then re-narrates.

    A SOFT nudge did not work: play-testing showed the real Keeper (DeepSeek)
    took the old escape-hatch nudge EVERY time -- the corrective fired but rolled
    on 0 turns. So the FIRST corrective round now compels a tool call via
    `tool_choice="required"` (the OpenAI-compatible "must call some tool" value):
    the model MUST call a tool, and the accompanying instruction directs it to
    the room's dice tools (skill_check / roll_dice / the pack's materialized
    subsystem tools) to resolve the pending check. If a real dice tool fires, one more NORMAL (`tool_choice="auto"`) round
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
    correction_start = len(tool_trace)
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
                tools=[*toolset.schemas(unlocked), *(subsystem_tools or [])],
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
                    tools=[*toolset.schemas(unlocked), *(subsystem_tools or [])],
                    tool_choice="auto",
                    temperature=temperature,
                )
            except Exception:
                logger.warning("dice-first correction skipped: LLM chat failed", exc_info=True)
                _clear_llm_continuation(services, convo)
                return prior_reply
        if result.tool_calls:
            try:
                real_correction_dice = sum(
                    entry.get("name") in _dice_tool_names() and not entry.get("suppressed")
                    for entry in tool_trace[correction_start:]
                )
                await _dispatch_and_record(
                    toolset,
                    ctx,
                    services,
                    result,
                    convo,
                    tool_trace,
                    unlocked,
                    room_pack=room_pack,
                    max_dice_calls=max(0, 1 - real_correction_dice),
                )
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
    room_pack: RulePack | None = None,
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
                await _dispatch_and_record(toolset, ctx, services, result, convo, tool_trace, unlocked, room_pack=room_pack)
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


async def _load_history(services: Services, chat_key: str, key: str) -> list[dict]:
    """Every persisted history message for `key` (`[]` if unset/invalid).

    Uncapped by design (M20 A2): between folds this list only grows, which is what makes
    the replayed prefix byte-stable turn over turn. `_trim_folded_history` is the sole
    place it shrinks.
    """
    raw = await services.store.state_get(chat_key, key)
    if not raw:
        return []
    try:
        history = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(history, list):
        return []
    return history


def _message_turn(message: dict) -> int:
    """The room turn a persisted history message belongs to (0 when unstamped).

    0 reads as "older than any fold", so history written before this stamp existed is
    dropped by the first fold that lands — the rolling summary covers it by then.
    """
    try:
        turn = message.get(HISTORY_TURN_KEY, 0)
        return int(turn) if isinstance(turn, int) and not isinstance(turn, bool) else 0
    except (TypeError, ValueError):
        return 0


async def _trim_folded_history(services: Services, chat_key: str, key: str, history: list[dict]) -> list[dict]:
    """Drop the history turns the chronicle has already folded into its rolling summary.

    THE truncation point (M20 A2), and idempotent: it keys off the summary's cumulative
    `through_turn` rather than what this turn's fold happened to consume, so a manual
    `.chronicle fold` is honoured on the next turn just as a routine one is. Turns past
    the watermark are still replayed verbatim; turns behind it survive as summary. A room
    that never folds (chronicle disabled, or a Keeper that records nothing) keeps its full
    history — the growth then shows up in the usage meter, which is what arms the fold.
    """
    if not history:
        return history
    folded_through = await summary_through_turn(services, chat_key)
    if folded_through <= 0:
        return history
    kept = [message for message in history if _message_turn(message) > folded_through]
    if len(kept) == len(history):
        return history
    await services.store.state_set(chat_key, key, json.dumps(kept, ensure_ascii=False))
    return kept


async def _persist_history(
    services: Services,
    chat_key: str,
    key: str,
    prior: list[dict],
    user_message: str,
    reply: str,
    *,
    turn: int,
) -> None:
    """Append this turn's user message + final reply (NOT tool chatter) to history.

    Uncapped — see `_load_history`. Both messages carry the in-flight turn stamp, which
    is what lets a later fold cut history at exactly the watermark it summarized.
    """
    updated = [
        *prior,
        {"role": "user", "content": user_message, HISTORY_TURN_KEY: turn},
        {"role": "assistant", "content": reply, HISTORY_TURN_KEY: turn},
    ]
    await services.store.state_set(chat_key, key, json.dumps(updated, ensure_ascii=False))


async def _run_reply_hooks(
    services: Services,
    ctx: AgentCtx,
    engine,
    reply: str,
    tool_trace: list[dict],
    mvu_applied: list,
    hook_writes: list[str],
) -> tuple[str, list[str], list[dict], list[dict]]:
    """Fire the post-reply hook phases in order: dice_rolled (when any dice tool resolved this
    turn), clock_advanced (once per game-clock advance recorded by the clock tool this turn),
    reply_ready (narrate/rewrite), then variables_changed exactly once when anything
    wrote variables this turn. One round only — variables_changed's own writes do NOT re-fire
    it, so hook cascades terminate by construction. Best-effort: a failing phase logs and the
    reply passes through unchanged. The third/fourth return values collect every phase's
    validated emitUI() / emitPanel() emissions in fire order (protocol v1.7 `ui` frame
    payloads / v1.8 `panel_event` payloads)."""
    ui_frames: list[dict] = []
    panel_events: list[dict] = []
    try:
        rolls = [
            {"tool": item.get("name", ""), "result": str(item.get("result", ""))[:200]}
            for item in tool_trace
            if item.get("name") in _dice_tool_names()
        ]
        if rolls:
            outcome = engine.fire("dice_rolled", {"rolls": rolls})
            hook_writes = hook_writes + await apply_hook_writes(services, ctx.chat_key, outcome.writes)
            ui_frames += outcome.ui_blocks
            panel_events += outcome.panel_events
            if outcome.narrations:
                reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)

        # Clock advances recorded by the game_clock tool this turn (capped at record time).
        for advance in list(ctx.extra.get("clock_advances") or []):
            if not isinstance(advance, dict):
                continue
            outcome = engine.fire(
                "clock_advanced",
                {
                    "from": str(advance.get("from", "")),
                    "to": str(advance.get("to", "")),
                    "delta": str(advance.get("delta", "")),
                },
            )
            hook_writes = hook_writes + await apply_hook_writes(services, ctx.chat_key, outcome.writes)
            ui_frames += outcome.ui_blocks
            panel_events += outcome.panel_events
            if outcome.narrations:
                reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)

        outcome = engine.fire("reply_ready", {"reply": reply})
        hook_writes = hook_writes + await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        ui_frames += outcome.ui_blocks
        panel_events += outcome.panel_events
        if outcome.rewrite is not None:
            reply = outcome.rewrite
        if outcome.narrations:
            reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)

        changed = [{"path": path, "op": "set"} for path in hook_writes]
        changed += [
            {"path": str(command.get("path", "")), "op": str(command.get("op", ""))}
            for command in mvu_applied
            if isinstance(command, dict)
        ]
        if changed:
            outcome = engine.fire("variables_changed", {"writes": changed})
            await apply_hook_writes(services, ctx.chat_key, outcome.writes)
            ui_frames += outcome.ui_blocks
            panel_events += outcome.panel_events
            if outcome.narrations:
                reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)
    except Exception:
        logger.warning("reply-phase hooks failed", exc_info=True)
    return reply, hook_writes, ui_frames, panel_events


def _capped_panel_events(events: list[dict], chat_key: str) -> list[dict]:
    """Apply the per-TURN emitPanel budget across all phases: keep the head, drop + log
    the excess (the same "excess dropped + logged" stance as the other hook caps)."""
    if len(events) <= MAX_PANEL_EVENTS_PER_TURN:
        return events
    logger.warning(
        "hooks emitted %d panel events for %s; keeping the first %d",
        len(events),
        chat_key,
        MAX_PANEL_EVENTS_PER_TURN,
    )
    return events[:MAX_PANEL_EVENTS_PER_TURN]
