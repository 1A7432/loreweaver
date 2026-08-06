"""The generic sheet substrate (M16 stage B): pack-declared sheet shapes.

A rulepack's ``sheet:`` section declares everything about how its system's
character sheets are SHAPED — the fresh-sheet tables, the canonical-name <->
storage-key bridge, which slots are pure derivations (recomputed on read,
never trusted from storage), the current-pool vitals and their creation
initialization, and the generic ``resources`` list the wire/panels render.
The engine holds none of it: every function here reads the spec.

The derived pipeline is ``source -> (modifier layer) -> derived`` — the
modifier layer is the reserved empty insertion point (`RulePack
.compute_derived`); `refresh_sheet` applies the derived halves onto a sheet's
storage slots, which is what "derived values are NEVER persisted" means in
practice: storage may carry stale copies, readers always overwrite them from
the pack DAG before use, and `strip_derived` drops them from what gets saved.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

MAX_RESOURCES = 8


class SheetSpecError(ValueError):
    """A malformed ``sheet:`` section (raised at pack load time)."""


@dataclass(frozen=True)
class VitalSpec:
    """One current pool: its max slot and how creation initializes it."""

    key: str  # attributes-dict storage key of the CURRENT value
    max_key: str  # attributes-dict storage key of the maximum
    start: Any  # "full" | {"expr": ...} (canonical-namespace expression)


@dataclass(frozen=True)
class ResourceSpec:
    """One wire/panel resource meter."""

    id: str
    label: str
    value_key: str = ""  # attributes-dict key (attribute-backed resources)
    max_key: str = ""
    source: str = "attributes"  # "attributes" | "hit_points"


@dataclass(frozen=True)
class SheetSpec:
    """One pack's declared sheet shape."""

    label: str
    attr_keys: Mapping[str, str] = field(default_factory=dict)  # canonical -> attributes key
    skill_keys: Mapping[str, str] = field(default_factory=dict)  # canonical -> skills key
    secondary_keys: Mapping[str, str] = field(default_factory=dict)  # canonical -> secondary key
    field_keys: Mapping[str, str] = field(default_factory=dict)  # canonical -> sheet field name
    attributes: Mapping[str, Any] = field(default_factory=dict)  # fresh-sheet attributes
    skills: Mapping[str, Any] = field(default_factory=dict)  # fresh-sheet skills
    secondary: Mapping[str, Any] = field(default_factory=dict)  # fresh-sheet secondary attrs
    fields: Mapping[str, Any] = field(default_factory=dict)  # fresh-sheet meta fields
    hit_points: Mapping[str, int] | None = None  # field-based HP systems
    derived_skills: Mapping[str, str] = field(default_factory=dict)  # skills key -> canonical
    derived_attrs: Mapping[str, str] = field(default_factory=dict)  # attributes key -> canonical
    derived_secondary: Mapping[str, str] = field(default_factory=dict)  # secondary key -> canonical
    check_values: Mapping[str, str] = field(default_factory=dict)  # canonical -> canonical fed to checks
    vitals: tuple[VitalSpec, ...] = ()
    resources: tuple[ResourceSpec, ...] = ()

    def key_to_canonical(self) -> dict[str, str]:
        """attributes-storage-key -> canonical name (reverse of attr_keys)."""
        return {key: canonical for canonical, key in self.attr_keys.items()}


def _str_map(pack_id: str, where: str, raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise SheetSpecError(f"rulepack '{pack_id}': {where} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    return {str(key): str(value) for key, value in raw.items()}


def _any_map(pack_id: str, where: str, raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise SheetSpecError(f"rulepack '{pack_id}': {where} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    return {str(key): value for key, value in raw.items()}


def parse_sheet_section(pack_id: str, raw: Any) -> SheetSpec | None:
    """Parse a pack's ``sheet:`` section (None when absent)."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise SheetSpecError(f"rulepack '{pack_id}': 'sheet' must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    unknown = set(raw) - {
        "label", "attr_keys", "skill_keys", "secondary_keys", "field_keys",
        "attributes", "skills", "secondary", "fields", "hit_points",
        "derived_skills", "derived_attrs", "derived_secondary", "check_values",
        "vitals", "resources",
    }
    if unknown:
        raise SheetSpecError(f"rulepack '{pack_id}': sheet has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, raised at load time
    label = str(raw.get("label") or "").strip()
    if not label:
        raise SheetSpecError(f"rulepack '{pack_id}': sheet.label is required")  # i18n-exempt: pack-author diagnostic, raised at load time

    hit_points_raw = raw.get("hit_points")
    hit_points: dict[str, int] | None = None
    if hit_points_raw is not None:
        if not isinstance(hit_points_raw, Mapping):
            raise SheetSpecError(f"rulepack '{pack_id}': sheet.hit_points must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
        hit_points = {
            "current": int(hit_points_raw.get("current", 0)),
            "max": int(hit_points_raw.get("max", 0)),
        }

    vitals_raw = raw.get("vitals") or {}
    if not isinstance(vitals_raw, Mapping):
        raise SheetSpecError(f"rulepack '{pack_id}': sheet.vitals must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at load time
    vitals: list[VitalSpec] = []
    for key, spec in vitals_raw.items():
        if not isinstance(spec, Mapping) or not spec.get("max_key"):
            raise SheetSpecError(f"rulepack '{pack_id}': sheet.vitals.{key} needs a max_key")  # i18n-exempt: pack-author diagnostic, raised at load time
        start = spec.get("start", "full")
        if start != "full" and not (isinstance(start, Mapping) and "expr" in start):
            raise SheetSpecError(f"rulepack '{pack_id}': sheet.vitals.{key}.start must be 'full' or an expr")  # i18n-exempt: pack-author diagnostic, raised at load time
        vitals.append(VitalSpec(key=str(key), max_key=str(spec["max_key"]), start=start))

    resources_raw = raw.get("resources") or []
    if not isinstance(resources_raw, (list, tuple)) or len(resources_raw) > MAX_RESOURCES:
        raise SheetSpecError(f"rulepack '{pack_id}': sheet.resources must be a short list")  # i18n-exempt: pack-author diagnostic, raised at load time
    resources: list[ResourceSpec] = []
    for entry in resources_raw:
        if not isinstance(entry, Mapping) or not entry.get("id") or not entry.get("label"):
            raise SheetSpecError(f"rulepack '{pack_id}': each sheet.resource needs id and label")  # i18n-exempt: pack-author diagnostic, raised at load time
        source = str(entry.get("source") or "attributes")
        if source not in ("attributes", "hit_points"):
            raise SheetSpecError(f"rulepack '{pack_id}': sheet.resource source must be attributes|hit_points")  # i18n-exempt: pack-author diagnostic, raised at load time
        if source == "attributes" and (not entry.get("value") or not entry.get("max")):
            raise SheetSpecError(f"rulepack '{pack_id}': attribute-backed resources need value and max keys")  # i18n-exempt: pack-author diagnostic, raised at load time
        resources.append(
            ResourceSpec(
                id=str(entry["id"]),
                label=str(entry["label"]),
                value_key=str(entry.get("value") or ""),
                max_key=str(entry.get("max") or ""),
                source=source,
            )
        )

    return SheetSpec(
        label=label,
        attr_keys=_str_map(pack_id, "sheet.attr_keys", raw.get("attr_keys")),
        skill_keys=_str_map(pack_id, "sheet.skill_keys", raw.get("skill_keys")),
        secondary_keys=_str_map(pack_id, "sheet.secondary_keys", raw.get("secondary_keys")),
        field_keys=_str_map(pack_id, "sheet.field_keys", raw.get("field_keys")),
        attributes=_any_map(pack_id, "sheet.attributes", raw.get("attributes")),
        skills=_any_map(pack_id, "sheet.skills", raw.get("skills")),
        secondary=_any_map(pack_id, "sheet.secondary", raw.get("secondary")),
        fields=_any_map(pack_id, "sheet.fields", raw.get("fields")),
        hit_points=hit_points,
        derived_skills=_str_map(pack_id, "sheet.derived_skills", raw.get("derived_skills")),
        derived_attrs=_str_map(pack_id, "sheet.derived_attrs", raw.get("derived_attrs")),
        derived_secondary=_str_map(pack_id, "sheet.derived_secondary", raw.get("derived_secondary")),
        check_values=_str_map(pack_id, "sheet.check_values", raw.get("check_values")),
        vitals=tuple(vitals),
        resources=tuple(resources),
    )


# ---------------------------------------------------------------------------
# The bridge: sheets <-> the pack's canonical value namespace
# ---------------------------------------------------------------------------


def _int_or(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def canonical_values(sheet: Any, pack: Any) -> dict[str, Any]:
    """The sheet's SOURCE values in the pack's canonical namespace.

    Attributes/secondary/fields translate through the spec's key maps; skills
    keep their own names (translated through skill_keys' reverse). Derived
    slots are deliberately NOT trusted here — they recompute from this.
    """
    spec = pack.sheet_spec
    values: dict[str, Any] = {}
    if spec is None:
        values.update(getattr(sheet, "attributes", {}) or {})
        values.update(getattr(sheet, "skills", {}) or {})
        return values

    skill_key_reverse = {key: canonical for canonical, key in spec.skill_keys.items()}
    for key, value in (getattr(sheet, "skills", {}) or {}).items():
        values[skill_key_reverse.get(key, key)] = value
    for canonical, key in spec.secondary_keys.items():
        secondary = getattr(sheet, "secondary_attributes", {}) or {}
        if key in secondary:
            values[canonical] = secondary[key]
    key_to_canonical = spec.key_to_canonical()
    for key, value in (getattr(sheet, "attributes", {}) or {}).items():
        values[key_to_canonical.get(key, key)] = value
    for canonical, field_name in spec.field_keys.items():
        values[canonical] = getattr(sheet, field_name, None)
    return values


def sheet_value(sheet: Any, pack: Any, canonical: str) -> int:
    """One canonical name's current value for `sheet` (derived recomputed)."""
    spec = pack.sheet_spec
    if spec is not None:
        attr_key = spec.attr_keys.get(canonical)
        if attr_key and attr_key in sheet.attributes:
            return _int_or(sheet.attributes[attr_key])
        if canonical in ("hp", "hpmax") and spec.hit_points is not None:
            from core.character_manager import get_hit_points

            hp, hp_max = get_hit_points(sheet)
            return hp if canonical == "hp" else hp_max
        secondary_key = spec.secondary_keys.get(canonical)
        if secondary_key and secondary_key in (getattr(sheet, "secondary_attributes", {}) or {}):
            return _int_or(sheet.secondary_attributes[secondary_key])
        skill_key = spec.skill_keys.get(canonical, canonical)
        if skill_key in sheet.skills:
            return _int_or(sheet.skills[skill_key])
        field_name = spec.field_keys.get(canonical)
        if field_name is not None:
            return _int_or(getattr(sheet, field_name, None))

    values = canonical_values(sheet, pack)
    derived = pack.compute_derived(values)
    if canonical in derived:
        return _int_or(derived[canonical])
    if canonical in values:
        return _int_or(values[canonical])
    return _int_or(pack.defaults.get(canonical, 0))


def set_sheet_value(sheet: Any, pack: Any, canonical: str, value: int) -> None:
    """Write one canonical name into its declared storage slot."""
    spec = pack.sheet_spec
    if spec is None:
        sheet.skills[canonical] = value
        return
    attr_key = spec.attr_keys.get(canonical)
    if attr_key:
        sheet.attributes[attr_key] = value
        refresh_sheet(sheet, pack)
        return
    if canonical in ("hp", "hpmax") and spec.hit_points is not None:
        from core.character_manager import set_hit_points

        if canonical == "hp":
            set_hit_points(sheet, current=value, allow_raise_max=True)
        else:
            set_hit_points(sheet, maximum=value)
        return
    secondary_key = spec.secondary_keys.get(canonical)
    if secondary_key:
        sheet.secondary_attributes[secondary_key] = value
        return
    field_name = spec.field_keys.get(canonical)
    if field_name is not None:
        setattr(sheet, field_name, value)
        refresh_sheet(sheet, pack)
        return
    sheet.skills[spec.skill_keys.get(canonical, canonical)] = value


def check_value(sheet: Any, pack: Any, canonical: str) -> int:
    """The value a CHECK on `canonical` feeds into the roll.

    Usually the stat's own value; the spec's ``check_values`` bridge redirects
    names whose check input is another canonical (an ability check rolling its
    modifier). Derived values recompute through `sheet_value`.
    """
    spec = pack.sheet_spec
    if spec is not None:
        canonical = spec.check_values.get(canonical, canonical)
    return sheet_value(sheet, pack, canonical)


def has_check_value(sheet: Any, pack: Any, name: str) -> bool:
    """Whether `name` names something this sheet/system can roll a check on.

    True when the pack's alias table resolves it (a declared stat) or the sheet
    itself carries it (a custom skill written via sheet edits). Anything else is
    an unknown name: refuse the roll rather than run a degenerate target-0
    check where a minimal roll reads as a critical success.
    """
    if pack.resolve_skill(name):
        return True
    spec = pack.sheet_spec
    candidates = {name}
    if spec is not None:
        for mapping in (spec.attr_keys, spec.skill_keys, spec.secondary_keys):
            key = mapping.get(name)
            if key:
                candidates.add(key)
    skills = getattr(sheet, "skills", {}) or {}
    attributes = getattr(sheet, "attributes", {}) or {}
    return any(key in skills or key in attributes for key in candidates)


def refresh_sheet(sheet: Any, pack: Any, *, initialize_vitals: bool = False, preserve_trained: bool = True) -> None:
    """Recompute every derived slot from the pack DAG onto `sheet` in place.

    This is the read-side half of "derived values are never persisted": callers
    refresh before showing/saving so storage copies can never go stale.
    ``preserve_trained`` keeps a stored skill value that differs from its
    derived base (a trained skill) — pass False at creation to seed cleanly.
    ``initialize_vitals`` (creation) sets each current pool per its declared
    start; edits clamp the existing value to the recomputed max.
    """
    spec = pack.sheet_spec
    if spec is None:
        return
    values = canonical_values(sheet, pack)
    derived = pack.compute_derived(values)
    namespace = {**values, **{k: v for k, v in derived.items() if k not in values}}

    for attr_key, canonical in spec.derived_attrs.items():
        if canonical in derived:
            sheet.attributes[attr_key] = derived[canonical]
    for secondary_key, canonical in spec.derived_secondary.items():
        if canonical not in derived:
            continue
        if preserve_trained and secondary_key in sheet.secondary_attributes and _int_or(
            sheet.secondary_attributes[secondary_key]
        ) != _int_or(derived[canonical]):
            # A stored value differing from the derivation is a manual override
            # (armor changing AC, a feature raising passive senses) — keep it.
            continue
        sheet.secondary_attributes.pop(secondary_key, None)
    for skill_key, canonical in spec.derived_skills.items():
        if canonical not in derived:
            continue
        if preserve_trained and skill_key in sheet.skills and _int_or(sheet.skills[skill_key]) != _int_or(
            derived[canonical]
        ):
            # A stored value differing from the derived base is trained — keep it.
            continue
        # Untrained derived skills are NEVER persisted: drop the slot so reads
        # recompute through the DAG. Storing the computed copy would turn into
        # a false "trained" override the moment its source attribute changes.
        sheet.skills.pop(skill_key, None)

    for vital in spec.vitals:
        maximum = _int_or(sheet.attributes.get(vital.max_key), 0)
        if initialize_vitals or vital.key not in sheet.attributes:
            if vital.start == "full":
                start_value = maximum
            else:
                start_expr = dict(vital.start)
                from core.rulepacks import _compile_expr_value  # deliberate: same expr lane

                start_value = _int_or(
                    _compile_expr_value(pack.system, f"vitals.{vital.key}", start_expr, pack.defaults)(
                        {**namespace, **{k: v for k, v in derived.items()}}
                    ),
                    maximum,
                )
            sheet.attributes[vital.key] = max(0, min(maximum, start_value))
        else:
            sheet.attributes[vital.key] = max(0, min(maximum, _int_or(sheet.attributes[vital.key], maximum)))


def wire_resources(sheet: Any, pack: Any) -> list[dict[str, Any]]:
    """The generic ``resources`` meter list for the wire/panels."""
    spec = pack.sheet_spec
    if spec is None:
        return []
    out: list[dict[str, Any]] = []
    for resource in spec.resources:
        if resource.source == "hit_points":
            from core.character_manager import get_hit_points

            value, maximum = get_hit_points(sheet)
        else:
            value = sheet.attributes.get(resource.value_key)
            maximum = sheet.attributes.get(resource.max_key)
            if value is None or maximum is None:
                continue
            value, maximum = _int_or(value), _int_or(maximum)
        out.append({"id": resource.id, "label": resource.label, "value": value, "max": maximum})
    return out
