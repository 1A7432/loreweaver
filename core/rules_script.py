"""Script lane for rule resolution and subsystem flows (M16 stage E).

``resolution: {script: <file>.js}`` and ``subsystems: {<id>: {script: ...}}``
cover what the DSL cannot express — QuickJS, the same zero-callable Layer-C
trust lane as ``hooks.js``. The purity contract is structural:

- The ENGINE pre-rolls every declared die and serializes the whole input INTO
  the sandbox as plain JSON; the script receives no callables, no state
  handles, and cannot roll.
- The script's exported function returns a plain JSON shape; the engine
  validates and clamps EVERYTHING (flags to booleans, tier to a bounded int,
  ids to slugs, effects to a closed vocabulary) before anything touches
  engine state. A malformed return is an error, never a partial apply.
- Subsystem flows return an EFFECT DESCRIPTION drawn from the closed,
  engine-owned effect vocabulary (stat deltas, a mark, a narration line) that
  the caller applies in the APPLY phase. The vocabulary follows the same
  promotion discipline as behavior templates: it never grows an effect kind
  for one system.

Bundled packs stay DSL-only — they are the reference vocabulary; the script
lane is the third-party/forge escape hatch, disclosed on the pack trust card
(``has_rules_script``).
"""

from __future__ import annotations

import json
import re
from typing import Any

from core.ejs_full import MEMORY_LIMIT_BYTES, TIME_LIMIT_SECONDS, quickjs_available

MAX_SCRIPT_CHARS = 40_000  # same cap as hooks.js sources
MAX_EFFECT_DELTAS = 8
MAX_EFFECT_DELTA_MAGNITUDE = 1_000
MAX_EFFECT_TEXT_CHARS = 2_000
MAX_RANK_TIER = 32

_RANK_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


class RulesScriptError(ValueError):
    """A rules script failed to load, run, or return a valid shape."""


class RulesScriptEngine:
    """One QuickJS interpreter holding one pack's rules script.

    The script must define a global function with the expected name
    (``resolve`` for check resolution, ``flow`` for a subsystem). ``run``
    serializes the input in, calls it, and parses the JSON result out —
    the zero-callable bridge, with the time limit re-armed per call.
    """

    def __init__(self, pack_id: str, where: str, source: str, function: str) -> None:
        if not quickjs_available():
            raise RulesScriptError(f"rulepack '{pack_id}': {where} needs the quickjs extra installed")  # i18n-exempt: pack-author diagnostic, raised at load time
        if len(source) > MAX_SCRIPT_CHARS:
            raise RulesScriptError(f"rulepack '{pack_id}': {where} script exceeds {MAX_SCRIPT_CHARS} chars")  # i18n-exempt: pack-author diagnostic, raised at load time
        import quickjs

        self._pack_id = pack_id
        self._where = where
        self._function = function
        self._context = quickjs.Context()
        self._context.set_memory_limit(MEMORY_LIMIT_BYTES)
        # The limit arms BEFORE untrusted top-level code runs, so an infinite
        # loop in the script body times out instead of hanging pack load.
        self._context.set_time_limit(TIME_LIMIT_SECONDS)
        try:
            self._context.eval(source)
            is_function = self._context.eval(f"typeof {function} === 'function'")  # i18n-exempt: JavaScript source, not UI text
        except Exception as exc:
            raise RulesScriptError(f"rulepack '{pack_id}': {where} failed to load: {exc}") from exc  # i18n-exempt: pack-author diagnostic, raised at load time
        if not is_function:
            raise RulesScriptError(
                f"rulepack '{pack_id}': {where} must define a global function {function}(input)"  # i18n-exempt: pack-author diagnostic, raised at load time
            )

    def run(self, input_payload: dict[str, Any]) -> Any:
        """Call the script function with `input_payload`, returning parsed JSON."""
        try:
            self._context.set_time_limit(TIME_LIMIT_SECONDS)
            raw = self._context.eval(
                f"JSON.stringify({self._function}({json.dumps(input_payload, ensure_ascii=False)}))"  # i18n-exempt: JavaScript source, not UI text
            )
        except Exception as exc:
            raise RulesScriptError(f"rulepack '{self._pack_id}': {self._where} failed: {exc}") from exc  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
        if not isinstance(raw, str):
            raise RulesScriptError(f"rulepack '{self._pack_id}': {self._where} returned no result")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RulesScriptError(f"rulepack '{self._pack_id}': {self._where} returned unserializable data") from exc  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths


def validate_rank_result(pack_id: str, raw: Any) -> dict[str, Any]:
    """Validate/clamp a resolution script's return into rank-shaped data.

    Expected: ``{rank: {id, tier, success?, critical?, fumble?}, margin?}``.
    Flags MUST be booleans, tier an int in range, the id a slug; extra keys
    (state smuggling) are rejected outright.
    """
    if not isinstance(raw, dict):
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script must return an object")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    unknown = set(raw) - {"rank", "margin"}
    if unknown:
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script returned unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    rank = raw.get("rank")
    if not isinstance(rank, dict):
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script must return a rank object")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    unknown = set(rank) - {"id", "tier", "success", "critical", "fumble"}
    if unknown:
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script rank has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    rank_id = rank.get("id")
    if not isinstance(rank_id, str) or not _RANK_ID_RE.match(rank_id):
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script rank needs a slug id")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    tier = rank.get("tier")
    if not isinstance(tier, int) or isinstance(tier, bool) or not 0 <= tier <= MAX_RANK_TIER:
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script rank.tier must be an int 0..{MAX_RANK_TIER}")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    for flag in ("success", "critical", "fumble"):
        if flag in rank and not isinstance(rank[flag], bool):
            raise RulesScriptError(f"rulepack '{pack_id}': resolution script rank.{flag} must be a boolean")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    margin = raw.get("margin")
    if margin is not None and (not isinstance(margin, int) or isinstance(margin, bool)):
        raise RulesScriptError(f"rulepack '{pack_id}': resolution script margin must be an integer or null")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    return {
        "id": rank_id,
        "tier": tier,
        "success": bool(rank.get("success", False)),
        "critical": bool(rank.get("critical", False)),
        "fumble": bool(rank.get("fumble", False)),
        "margin": margin,
    }


def validate_flow_effect(pack_id: str, subsystem_id: str, raw: Any) -> dict[str, Any]:
    """Validate/clamp a subsystem flow script's EFFECT DESCRIPTION.

    The closed effect vocabulary (engine-owned, generic): ``stat_delta`` (a
    canonical-name -> integer-delta mapping the caller applies through the
    sheet layer), ``mark`` (a short marker string, e.g. a growth tick),
    ``narration`` (one text line to show). Anything else is rejected — the
    vocabulary never grows an effect kind for one system.
    """
    where = f"subsystems.{subsystem_id}"
    if not isinstance(raw, dict):
        raise RulesScriptError(f"rulepack '{pack_id}': {where} script must return an effect object")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    unknown = set(raw) - {"stat_delta", "mark", "narration"}
    if unknown:
        raise RulesScriptError(f"rulepack '{pack_id}': {where} script returned unknown effect keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths

    deltas_raw = raw.get("stat_delta") or {}
    if not isinstance(deltas_raw, dict) or len(deltas_raw) > MAX_EFFECT_DELTAS:
        raise RulesScriptError(f"rulepack '{pack_id}': {where} stat_delta must be a small mapping")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    deltas: dict[str, int] = {}
    for name, value in deltas_raw.items():
        if not isinstance(name, str) or not name.strip():
            raise RulesScriptError(f"rulepack '{pack_id}': {where} stat_delta has an empty stat name")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
        if not isinstance(value, int) or isinstance(value, bool):
            raise RulesScriptError(f"rulepack '{pack_id}': {where} stat_delta values must be integers")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
        deltas[name.strip()] = max(-MAX_EFFECT_DELTA_MAGNITUDE, min(MAX_EFFECT_DELTA_MAGNITUDE, value))

    mark = raw.get("mark")
    if mark is not None and not isinstance(mark, str):
        raise RulesScriptError(f"rulepack '{pack_id}': {where} mark must be a string")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths
    narration = raw.get("narration")
    if narration is not None and not isinstance(narration, str):
        raise RulesScriptError(f"rulepack '{pack_id}': {where} narration must be a string")  # i18n-exempt: pack-author diagnostic, surfaced via tool error paths

    return {
        "stat_delta": deltas,
        "mark": (mark or "")[:64],
        "narration": (narration or "")[:MAX_EFFECT_TEXT_CHARS],
    }
