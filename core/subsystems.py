"""Generic, pack-parameterized subsystem behavior templates (M16 stage D).

A rulepack's ``subsystems:`` section declares the extra play mechanics its
system runs beyond the basic check — each entry binds ONE engine behavior
TEMPLATE to pack-chosen parameters, vocabulary and (crucially) a NAME:

.. code-block:: yaml

    subsystems:
      <tool_name>:                  # the pack key IS the KP tool name AND the
        template: check_with_loss   # wire `subsystem` id — vocabulary is 100%
        stat: SAN                   # the pack's; the engine knows only the
        ...                         # template semantics.

The engine ships a small CLOSED set of templates (the no-single-sample
doctrine applied to behaviors — a flow no template expresses uses the stage-E
script lane, and only a pattern recurring across systems earns a template):

- ``check_with_loss``      — roll the system's check against a governing
  attribute; apply a dice-rolled loss chosen by the outcome (the
  horror-stress / attribute-erosion family).
- ``improvement_check``    — post-session improvement roll against the current
  skill value; on success the skill grows by an improvement roll (the
  experience-tick family).
- ``resource_spend_adjust``— spend points of a resource attribute to adjust
  the character's most recent eligible recorded check (the luck-spend
  family; eligibility/arithmetic live in `core.luck`).
- ``opposed``              — two actors' checks compared by rank tier, then
  raw values (already a generic contract operation).
- ``table_draw``           — draw one entry from a pack-data table (madness/
  reaction/complication tables; entries are opaque game DATA).

The room's KP toolset is MATERIALIZED from these declarations: the tool named
by each pack key exists only in rooms whose system declares it, its schema is
built from the template shape, and the engine's tool bodies read the spec —
no engine code names a system or a system's mechanic.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

TEMPLATES = (
    "check_with_loss",
    "improvement_check",
    "resource_spend_adjust",
    "opposed",
    "table_draw",
)

MAX_SUBSYSTEMS = 16
MAX_TABLE_ENTRIES = 64
_FUMBLE_LOSS_POLICIES = ("all", "max")


class SubsystemError(ValueError):
    """A malformed ``subsystems:`` section (raised at pack load time)."""


@dataclass(frozen=True)
class DrawTable:
    """One named draw table: per-locale display name + opaque entry list."""

    id: str
    display: Mapping[str, str]
    entries: tuple[str, ...]
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class SubsystemSpec:
    """One declared subsystem: the pack key (== tool name == wire id), the
    engine template it binds, and the pack's parameters/vocabulary."""

    id: str
    template: str
    display: Mapping[str, str] = field(default_factory=dict)
    stat: str = ""
    stat_max: str = ""
    fumble_loss: str | None = None  # check_with_loss: "all" | "max" | None
    roll: str = "1d100"  # improvement_check: the improvement-check roll
    improve: str = "1d10"  # improvement_check: the growth amount roll
    cap: int = 100  # improvement_check: skill ceiling
    auto_success_above: int | None = None  # improvement_check: roll > N always grows
    tables: tuple[DrawTable, ...] = ()  # table_draw
    default_table: str = ""  # table_draw
    script: Any = None  # RulesScriptEngine — stage-E script flow (template == "script")
    rolls: Mapping[str, str] = field(default_factory=dict)  # script flow: slot -> pre-rolled dice expr

    def label(self, locale: str) -> str:
        """The pack's display name for this subsystem, for `locale` (falls back
        to en, then any, then the id)."""
        base = str(locale or "en").replace("_", "-").split("-")[0].casefold()
        for candidate in (self.display.get(base), self.display.get("en")):
            if candidate:
                return candidate
        for candidate in self.display.values():
            if candidate:
                return candidate
        return self.id

    def table(self, ref: str) -> DrawTable | None:
        """Resolve a caller-supplied table reference (id or alias, trimmed,
        case-insensitive) to one of this spec's draw tables."""
        wanted = str(ref or "").strip().casefold()
        if not wanted:
            wanted = self.default_table
        for entry in self.tables:
            if entry.id == wanted or wanted in entry.aliases:
                return entry
        return None


def _parse_script_subsystem(
    pack_id: str, tool_name: str, spec_raw: Mapping[str, Any], script_loader: Any
) -> SubsystemSpec:
    where = f"subsystems.{tool_name}"
    unknown = set(spec_raw) - {"script", "display", "rolls"}
    if unknown:
        raise SubsystemError(f"rulepack '{pack_id}': {where} has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, raised at load time
    filename = spec_raw.get("script")
    if not isinstance(filename, str) or not filename.strip():
        raise SubsystemError(f"rulepack '{pack_id}': {where}.script must be a filename")  # i18n-exempt: pack-author diagnostic, raised at load time
    if script_loader is None:
        raise SubsystemError(f"rulepack '{pack_id}': {where}.script needs a pack file context")  # i18n-exempt: pack-author diagnostic, raised at load time
    rolls_raw = spec_raw.get("rolls") or {}
    if not isinstance(rolls_raw, Mapping) or len(rolls_raw) > 8:
        raise SubsystemError(f"rulepack '{pack_id}': {where}.rolls must be a small mapping of slot -> dice expr")  # i18n-exempt: pack-author diagnostic, raised at load time
    rolls: dict[str, str] = {}
    for slot, expr in rolls_raw.items():
        slot_key = str(slot).strip()
        if not slot_key.isidentifier():
            raise SubsystemError(f"rulepack '{pack_id}': {where}.rolls slot {slot!r} must be an identifier")  # i18n-exempt: pack-author diagnostic, raised at load time
        if not isinstance(expr, str) or not expr.strip():
            raise SubsystemError(f"rulepack '{pack_id}': {where}.rolls.{slot_key} must be a dice expression")  # i18n-exempt: pack-author diagnostic, raised at load time
        rolls[slot_key] = expr.strip()

    from core.rules_script import RulesScriptEngine, RulesScriptError

    try:
        source = script_loader(filename.strip())
        engine = RulesScriptEngine(pack_id, f"{where}.script", source, "flow")
    except RulesScriptError as exc:
        raise SubsystemError(str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise SubsystemError(f"rulepack '{pack_id}': {where}.script unreadable: {exc}") from exc  # i18n-exempt: pack-author diagnostic, raised at load time
    return SubsystemSpec(
        id=tool_name,
        template="script",
        display=_parse_display(pack_id, where, spec_raw.get("display")),
        script=engine,
        rolls=rolls,
    )


def _parse_display(pack_id: str, where: str, raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise SubsystemError(f"rulepack '{pack_id}': {where}.display must be a locale mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    return {str(locale).casefold(): str(text) for locale, text in raw.items() if str(text).strip()}


def _parse_tables(pack_id: str, where: str, raw: Any) -> tuple[DrawTable, ...]:
    if not isinstance(raw, Mapping) or not raw:
        raise SubsystemError(f"rulepack '{pack_id}': {where}.tables must be a non-empty mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    tables: list[DrawTable] = []
    for table_id, spec in raw.items():
        table_key = str(table_id).strip().casefold()
        if not table_key:
            raise SubsystemError(f"rulepack '{pack_id}': {where}.tables has an empty table id")  # i18n-exempt: pack-author diagnostic, raised at load time
        spec = spec or {}
        if not isinstance(spec, Mapping):
            raise SubsystemError(f"rulepack '{pack_id}': {where}.tables.{table_key} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
        unknown = set(spec) - {"display", "entries", "aliases"}
        if unknown:
            raise SubsystemError(
                f"rulepack '{pack_id}': {where}.tables.{table_key} has unknown keys {sorted(unknown)}"  # i18n-exempt: pack-author diagnostic, raised at load time
            )
        entries_raw = spec.get("entries")
        if not isinstance(entries_raw, (list, tuple)) or not entries_raw:
            raise SubsystemError(f"rulepack '{pack_id}': {where}.tables.{table_key}.entries must be a non-empty list")  # i18n-exempt: pack-author diagnostic, raised at load time
        if len(entries_raw) > MAX_TABLE_ENTRIES:
            raise SubsystemError(f"rulepack '{pack_id}': {where}.tables.{table_key} has too many entries")  # i18n-exempt: pack-author diagnostic, raised at load time
        aliases_raw = spec.get("aliases") or []
        if not isinstance(aliases_raw, (list, tuple)):
            raise SubsystemError(f"rulepack '{pack_id}': {where}.tables.{table_key}.aliases must be a list")  # i18n-exempt: pack-author diagnostic, raised at load time
        tables.append(
            DrawTable(
                id=table_key,
                display=_parse_display(pack_id, f"{where}.tables.{table_key}", spec.get("display")),
                entries=tuple(str(entry) for entry in entries_raw),
                aliases=tuple(str(alias).strip().casefold() for alias in aliases_raw if str(alias).strip()),
            )
        )
    return tuple(tables)


def parse_subsystems(
    pack_id: str, raw: Any, *, script_loader: Any = None
) -> dict[str, SubsystemSpec]:
    """Parse and validate a pack's ``subsystems:`` section (empty dict when absent).

    The section is a mapping ``tool_name -> spec``; every spec names one of the
    engine's closed `TEMPLATES` and carries that template's parameters. A pack
    whose subsystems don't validate does not load.
    """
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise SubsystemError(f"rulepack '{pack_id}': 'subsystems' must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    if len(raw) > MAX_SUBSYSTEMS:
        raise SubsystemError(f"rulepack '{pack_id}': too many subsystems (max {MAX_SUBSYSTEMS})")  # i18n-exempt: pack-author diagnostic, raised at load time

    specs: dict[str, SubsystemSpec] = {}
    for name, spec_raw in raw.items():
        tool_name = str(name).strip()
        if not tool_name.isidentifier() or tool_name.startswith("_"):
            raise SubsystemError(f"rulepack '{pack_id}': subsystem name {name!r} must be an identifier")  # i18n-exempt: pack-author diagnostic, raised at load time
        if not isinstance(spec_raw, Mapping):
            raise SubsystemError(f"rulepack '{pack_id}': subsystems.{tool_name} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
        if "script" in spec_raw:
            # Stage-E script flow: the pack ships its own flow logic; the
            # engine pre-rolls the declared dice and applies the returned,
            # closed-vocabulary effect. Mutually exclusive with a template.
            specs[tool_name] = _parse_script_subsystem(pack_id, tool_name, spec_raw, script_loader)
            continue
        template = spec_raw.get("template")
        if template not in TEMPLATES:
            raise SubsystemError(
                f"rulepack '{pack_id}': subsystems.{tool_name}.template must be one of {list(TEMPLATES)}"  # i18n-exempt: pack-author diagnostic, raised at load time
            )

        allowed = {"template", "display"}
        if template == "check_with_loss":
            allowed |= {"stat", "stat_max", "fumble_loss"}
        elif template == "improvement_check":
            allowed |= {"roll", "improve", "cap", "auto_success_above"}
        elif template == "resource_spend_adjust":
            allowed |= {"stat"}
        elif template == "table_draw":
            allowed |= {"tables", "default"}
        unknown = set(spec_raw) - allowed
        if unknown:
            raise SubsystemError(
                f"rulepack '{pack_id}': subsystems.{tool_name} has unknown keys {sorted(unknown)}"  # i18n-exempt: pack-author diagnostic, raised at load time
            )

        display = _parse_display(pack_id, f"subsystems.{tool_name}", spec_raw.get("display"))
        if template in ("check_with_loss", "resource_spend_adjust"):
            stat = str(spec_raw.get("stat") or "").strip()
            if not stat:
                raise SubsystemError(f"rulepack '{pack_id}': subsystems.{tool_name} needs a 'stat'")  # i18n-exempt: pack-author diagnostic, raised at load time
        else:
            stat = ""

        fumble_loss = spec_raw.get("fumble_loss")
        if fumble_loss is not None and fumble_loss not in _FUMBLE_LOSS_POLICIES:
            raise SubsystemError(
                f"rulepack '{pack_id}': subsystems.{tool_name}.fumble_loss must be one of {list(_FUMBLE_LOSS_POLICIES)}"  # i18n-exempt: pack-author diagnostic, raised at load time
            )

        cap_raw = spec_raw.get("cap", 100)
        auto_above_raw = spec_raw.get("auto_success_above")
        try:
            cap = int(cap_raw)
            auto_above = int(auto_above_raw) if auto_above_raw is not None else None
        except (TypeError, ValueError) as exc:
            raise SubsystemError(f"rulepack '{pack_id}': subsystems.{tool_name} bounds must be integers") from exc  # i18n-exempt: pack-author diagnostic, raised at load time

        tables: tuple[DrawTable, ...] = ()
        default_table = ""
        if template == "table_draw":
            tables = _parse_tables(pack_id, f"subsystems.{tool_name}", spec_raw.get("tables"))
            default_table = str(spec_raw.get("default") or tables[0].id).strip().casefold()
            if all(default_table != table.id for table in tables):
                raise SubsystemError(
                    f"rulepack '{pack_id}': subsystems.{tool_name}.default names an unknown table"  # i18n-exempt: pack-author diagnostic, raised at load time
                )

        specs[tool_name] = SubsystemSpec(
            id=tool_name,
            template=str(template),
            display=display,
            stat=stat,
            stat_max=str(spec_raw.get("stat_max") or "").strip(),
            fumble_loss=fumble_loss,
            roll=str(spec_raw.get("roll") or "1d100").strip(),
            improve=str(spec_raw.get("improve") or "1d10").strip(),
            cap=cap,
            auto_success_above=auto_above,
            tables=tables,
            default_table=default_table,
        )
    return specs
