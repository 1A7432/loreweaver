"""End-of-turn structural checks (M20 C) — the table, the conditions, and the runner.

What this replaces: two hand-written corrective phases of identical shape, plus 21
compiled regexes in `agent/loop.py` that tried to guess whether a player's sentence had
attempted something checkable. That guess was the wrong tool in the wrong box — a gate
built on a heuristic cannot see that heuristic's blind spots, and the metric that watched
it shared the same lexicon, so it confirmed itself. The judgement "should this have been
rolled?" needs the fiction read, so it belongs to the Scribe (`agent/scribe.py`), which
reads the fiction anyway and reports it as a whisper the Keeper is free to act on.

What is left here is only what can be decided WITHOUT reading the fiction:

- **forgery** — the reply states a roll-shaped result and no dice tool ran this turn, so
  there is no true value to compare against. Shape detection, which means a residual
  ambiguity band: ordinary prose does contain numbers. It is a large improvement over
  guessing intent, and it is NOT exact — `tests/agent/test_turn_checks.py` writes the
  tolerance down rather than pretending it away.
- **contradiction** — dice DID run, and the numbers in the prose disagree with them. This
  one is exact: normalize the numerals (Arabic and CJK), and compare against the totals,
  targets and faces this turn actually produced.
- **stale HUD** — the reply drew a scene/time heading but the turn never touched the
  deterministic scene/clock state the HUD reads.

Both dice checks exist because of one contract: **narration carries no roll numbers.**
The dice frames already carry them (`gateway/render_chat.py`, `clients/tui`), so a number
in prose is at best a duplicate and at worst a duplicate that DISAGREES with the roll.

## The runner is pure Stop form

The gate refuses to end the turn and feeds the reason back; the model corrects itself. It
does NOT mutate `tools` or `tool_choice`. That is not squeamishness about forcing: the
correctives run at the END of a turn, when the prefix is at its largest, and on Anthropic
changing `tools` invalidates all three cache layers while changing `tool_choice`
invalidates the message layer — so the old `tool_choice="required"` path paid for a full
recompute up to five times per turn, at exactly the moment M20 A had made the prefix big.

Two properties make Stop form safe, and both are load-bearing:

1. **It loops and re-verifies.** "I will not let this turn end" only differs from "please
   roll" because the structural condition is re-run after each re-ask, up to the cap.
2. **The nightly dice-miss metric watches the assumption.** A soft nudge with an escape
   hatch was historically declined by the real Keeper on every occasion. Stop form is
   structurally different (the turn does not end) and, post-C1, the condition is
   verifiable rather than hoped for — but that is an empirical claim, and if the metric
   regresses, escalating the FINAL attempt to `required` is one added tier, not a
   redesign.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from core.rulepacks import RulePack, all_subsystem_tool_names

logger = logging.getLogger(__name__)

# --- Round budget ----------------------------------------------------------
# The old pair of correctives cost at most 2 + 3 = 5 chat calls per turn, and the
# per-turn model-call budget in AGENTS.md is written against that number. The runner
# keeps it: a pack may shorten a check or drop it, never lengthen the turn past this.
# `tests/architecture/test_turn_check_budget.py` pins both, same family as
# `tests/agent/test_turn_call_budget.py`.
MAX_ROUNDS_PER_CHECK = 3
MAX_ROUNDS_PER_TURN = 5

# Tools that resolve real dice outcomes. The engine names only its own generic ones;
# every pack-declared subsystem tool joins at runtime.
_BASE_DICE_TOOL_NAMES = frozenset({"skill_check", "roll_dice"})

# Tools that update the deterministic HUD-backed scene/focus and game-clock state.
_STATE_BOOKKEEPING_TOOL_NAMES = frozenset({"kp_note", "game_clock"})


def dice_tool_names() -> frozenset[str]:
    return _BASE_DICE_TOOL_NAMES | all_subsystem_tool_names()


def dice_rolled(tool_trace: list[dict]) -> bool:
    """True if any real dice-rolling tool fired during this turn."""
    names = dice_tool_names()
    return any(entry.get("name") in names and not entry.get("suppressed") for entry in tool_trace)


# ---------------------------------------------------------------------------
# C1 — what the dice actually produced, and what the prose claims they did
# ---------------------------------------------------------------------------

_CJK_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CJK_UNITS = {"十": 10, "百": 100}
_CJK_NUMBER_RE = re.compile(r"[零〇一二两三四五六七八九十百]+")  # i18n-exempt - numeral parser


def _cjk_to_int(text: str) -> int | None:
    """Parse a CJK numeral in the range dice actually produce (0-999), else None.

    Deliberately small: a check's total, target and faces are two- or three-digit, so
    十/百 plus the digits cover every number a rolled result can be written as. Anything
    larger is prose, not a roll.
    """
    total = 0
    section = 0
    seen = False
    for char in text:
        if char in _CJK_DIGITS:
            section = _CJK_DIGITS[char]
            seen = True
            continue
        unit = _CJK_UNITS.get(char)
        if unit is None:
            return None
        # "十五" is 15, "三十五" is 35 — a bare unit carries an implicit one.
        total += (section or 1) * unit
        section = 0
        seen = True
    if not seen:
        return None
    value = total + section
    return value if 0 <= value <= 999 else None


def _numbers_in(text: str) -> set[int]:
    """Every number `text` states, Arabic or CJK, normalized to ints."""
    values = {int(match) for match in re.findall(r"\d{1,4}", text)}
    for match in _CJK_NUMBER_RE.finditer(text):
        parsed = _cjk_to_int(match.group(0))
        if parsed is not None:
            values.add(parsed)
    return values


# The SHAPES a stated dice result takes in prose. Each is what the real dice frames
# render, so a reply containing one either came from a tool call or was invented:
#   - a roll-vs-target pair: "22 vs 25", "47 versus 65", "22 对 25"
#   - a d-notation total: "1d100 = 47", "2d6+1 -> 9"
# A bare "22/25" slash pair is deliberately NOT one: ordinary prose has ratios and scores
# in it ("the odds are 50/50"), and `vs` alone is specific enough.
_ROLL_VS_TARGET_RE = re.compile(r"\b(\d{1,3})\s*(?:vs\.?|versus|對|对)\s*(\d{1,3})\b", re.IGNORECASE)
_ROLL_TOTAL_RE = re.compile(r"\b\d{0,3}d\d{1,3}(?:\s*[+-]\s*\d{1,3})?\s*(?:=|＝|->|→|:|：)\s*(\d{1,4})\b", re.IGNORECASE)
# A die emoji next to a result word is the OTHER shape a stated outcome takes —
# "🎲 **Intimidate — Fumble.**" with the numbers omitted. 🎲 essentially never appears in
# ordinary narration, which is what lets the bare result words be trusted here while they
# stay untrusted on their own.
_ROLL_MARKUP_RE = re.compile(
    r"🎲[^\n]{0,80}?(?:fumble|success|failure|\bfail(?:s|ed)?\b|成功|失败|失敗)",  # i18n-exempt - detector shape
    re.IGNORECASE,
)
# The CJK form of a stated pair, where the numbers may be written out: "掷出三十七，对手 65".
_CJK_ROLL_RE = re.compile(r"(?:掷出|投出|骰出|roll(?:ed|s)?)\s*[:：]?\s*([零〇一二两三四五六七八九十百]+|\d{1,3})", re.IGNORECASE)


def reply_states_a_roll(reply: str) -> bool:
    """True if `reply` states a dice result in one of the shapes the frames render.

    Purely structural, and deliberately NOT a judgement about whether this turn warranted
    a check at all — that question needs the fiction read, and it belongs to the Scribe.
    """
    if not reply:
        return False
    return bool(
        _ROLL_VS_TARGET_RE.search(reply)
        or _ROLL_TOTAL_RE.search(reply)
        or _ROLL_MARKUP_RE.search(reply)
        or _CJK_ROLL_RE.search(reply)
    )


def stated_roll_numbers(reply: str) -> set[int]:
    """The numbers `reply` presents AS a roll result — not every number in the prose.

    Scoped to the roll-shaped spans above, so a street number, a year, or a count of coins
    can never be read as a contradicted die.
    """
    values: set[int] = set()
    for match in _ROLL_VS_TARGET_RE.finditer(reply or ""):
        values.update({int(match.group(1)), int(match.group(2))})
    for match in _ROLL_TOTAL_RE.finditer(reply or ""):
        values.add(int(match.group(1)))
    for match in _CJK_ROLL_RE.finditer(reply or ""):
        values.update(_numbers_in(match.group(1)))
    return values


def rolled_values(tool_trace: list[dict]) -> set[int]:
    """Every number this turn's dice actually produced: totals, targets, and faces.

    Read from the structured payloads the dice tools emit (`AgentCtx.emit_dice`), which is
    the same data the players' dice frames are rendered from — so "what the prose may say"
    and "what the table can see" are compared against one source.
    """
    values: set[int] = set()
    for entry in tool_trace:
        for payload in entry.get("dice_payloads") or []:
            if not isinstance(payload, dict):
                continue
            for key in ("total", "target", "effective_target"):
                number = payload.get(key)
                if isinstance(number, int) and not isinstance(number, bool):
                    values.add(number)
            for face in payload.get("rolls") or []:
                if isinstance(face, int) and not isinstance(face, bool):
                    values.add(face)
    return values


# ---------------------------------------------------------------------------
# The scene-heading condition
# ---------------------------------------------------------------------------

# High-confidence "self-drawn scene card": a short title-like line with a location/time
# separator AND an explicit time marker, e.g. "🌉 東京港·大井埠頭五号泊位 | 晚 10:15".
# Ordinary prose can mention places or times freely; the separator + time-marker shape is
# what flags "the model knew this was a HUD transition but forgot to update the state".
_SCENE_TITLE_TIME_RE = re.compile(
    r"(?:\b\d{1,2}[:：]\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|上午|下午|早上|清晨|凌晨|"
    r"傍晚|黄昏|晚上|晚间|夜里|深夜|午夜|正午|morning|afternoon|evening|night|midnight|dawn|dusk|noon)",
    re.IGNORECASE,
)


def scene_title_lines(reply: str) -> list[str]:
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


def state_bookkeeping_done(tool_trace: list[dict]) -> bool:
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


# ---------------------------------------------------------------------------
# The table
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TurnState:
    """What a condition may look at: the reply as written, and what the turn really did.

    Deliberately not the player's message. A condition that reads the player's words is a
    condition guessing at intent, which is the class this milestone deleted.
    """

    reply: str
    tool_trace: list[dict]


def _dice_forged(state: TurnState) -> bool:
    return reply_states_a_roll(state.reply) and not dice_rolled(state.tool_trace)


def _dice_contradicts(state: TurnState) -> bool:
    if not dice_rolled(state.tool_trace):
        return False
    stated = stated_roll_numbers(state.reply)
    if not stated:
        return False
    real = rolled_values(state.tool_trace)
    if not real:
        # A dice tool fired but published no structured payload (a suppressed or
        # unusual call). There is nothing exact to compare against, so claim nothing.
        return False
    return not stated <= real


def _stale_scene_hud(state: TurnState) -> bool:
    return bool(scene_title_lines(state.reply)) and not state_bookkeeping_done(state.tool_trace)


# The whole condition vocabulary. Conditions are CODE (they are structural predicates over
# the turn's real tool trace), so a pack chooses among them, reorders them, rewords their
# instruction and shortens their cap — it never authors a new one. That boundary is what
# keeps a content pack from becoming a place to write engine logic.
CONDITIONS: dict[str, Callable[[TurnState], bool]] = {
    "dice_forged": _dice_forged,
    "dice_contradicts": _dice_contradicts,
    "stale_scene_hud": _stale_scene_hud,
}


@dataclass(frozen=True)
class TurnCheck:
    """One row of the end-of-turn table."""

    id: str
    condition: str
    instruction_key: str = ""
    instruction_text: dict[str, str] = field(default_factory=dict)
    max_rounds: int = 2

    def holds(self, state: TurnState) -> bool:
        predicate = CONDITIONS.get(self.condition)
        return bool(predicate and predicate(state))

    def instruction(self, i18n, locale: str, **fields: Any) -> str:
        """The text fed back to the model. A pack's own wording wins over the engine's."""
        base = str(locale or "").replace("_", "-").split("-")[0].casefold()
        text = self.instruction_text.get(base) or self.instruction_text.get("en")
        if text:
            return text.format(**fields) if fields else text
        return i18n.t(self.instruction_key, **fields)


DEFAULT_TURN_CHECKS: tuple[TurnCheck, ...] = (
    TurnCheck(id="dice_forged", condition="dice_forged", instruction_key="loop.check.dice_forged", max_rounds=2),
    TurnCheck(
        id="dice_contradicts", condition="dice_contradicts", instruction_key="loop.check.dice_contradicts", max_rounds=1
    ),
    TurnCheck(id="stale_scene_hud", condition="stale_scene_hud", instruction_key="loop.check.stale_scene_hud", max_rounds=2),
)


def turn_checks_for(pack: RulePack | None) -> tuple[TurnCheck, ...]:
    """This room's end-of-turn table: the pack's, when it declares one, else the engine's.

    The split of duties is the usual one. `core.rulepacks` validates the SHAPE of a
    `turn_checks:` section (it is pack data, and core stays rule-agnostic); the meaning of
    a condition name is engine code, so it is checked here — a row naming a condition this
    engine does not have is dropped rather than crashing a room, exactly as an unknown
    subsystem tool is. The engine clamps the round caps whatever the pack asked for:
    otherwise one content pack could blow the per-turn model-call budget.
    """
    declared = getattr(pack, "turn_checks", ()) if pack is not None else ()
    if not declared:
        return DEFAULT_TURN_CHECKS
    table: list[TurnCheck] = []
    for row in declared:
        condition = str(row.get("when") or row.get("condition") or "").strip()
        if condition not in CONDITIONS:
            logger.warning("rulepack declares unknown turn-check condition %r; skipping", condition)
            continue
        if row.get("enabled") is False:
            continue
        raw_rounds = row.get("max_rounds")
        rounds = raw_rounds if isinstance(raw_rounds, int) and not isinstance(raw_rounds, bool) else 2
        instruction = row.get("instruction")
        table.append(
            TurnCheck(
                id=str(row.get("id") or condition),
                condition=condition,
                instruction_key=_DEFAULT_INSTRUCTION_KEYS.get(condition, ""),
                instruction_text={
                    str(locale): str(text) for locale, text in instruction.items() if str(text).strip()
                }
                if isinstance(instruction, dict)
                else {},
                max_rounds=max(1, min(rounds, MAX_ROUNDS_PER_CHECK)),
            )
        )
    return tuple(table)


_DEFAULT_INSTRUCTION_KEYS = {check.condition: check.instruction_key for check in DEFAULT_TURN_CHECKS}
