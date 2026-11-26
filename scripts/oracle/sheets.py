"""Reference vectors for character sheets: pack-declared shapes, derived values, validation.

A ``sheets_cases`` row takes ONE literal sheet (plain JSON in the ``CharacterSheet.to_dict`` shape) and
records everything the sheet layer says about it: the loaded sheet, its canonical values, the pack's
derived DAG, ``refresh_sheet`` in every mode, name/alias resolution through ``sheet_value`` /
``check_value`` / ``has_check_value``, the wire resource meters per locale and ``validate_sheet``.
The other files cover the pure pieces on their own (``sheets_derived`` sweeps the derived DAG,
``sheets_aliases`` the alias maps, ``sheets_ops`` mutations, creation and hit points).

Schemas: ``server/test/fixtures/reference/README.md``.
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._common import fresh_sheet_input, sheet_dict
from ._io import assert_scripts_held, error_dict, jsonable, scratch_dir, scripted_random, write_jsonl

from agent.services import build_services  # isort: skip
from core import rulepacks  # isort: skip
from core.character_manager import (  # isort: skip
    CharacterSheet,
    get_hit_points,
    resource_label_map,
    set_hit_points,
)
from core.character_rules import validate_sheet  # isort: skip
from core.rulepacks import available_systems, load_rulepack  # isort: skip
from core.sheets import (  # isort: skip
    canonical_values,
    check_value,
    has_check_value,
    refresh_sheet,
    set_sheet_value,
    sheet_value,
    wire_resources,
)
from infra.config import Settings  # isort: skip
from infra.embeddings import FakeEmbeddings  # isort: skip
from infra.llm import FakeLLM  # isort: skip

from . import synthetic  # isort: skip

BUILTIN = ("coc7", "dnd5e", "wod")
WIRE_LOCALES = (None, "en", "zh", "zh-CN", "zh_TW", "fr", "ja")
REFRESH_MODES = [(False, True), (True, True), (False, False), (True, False)]  # (initialize_vitals, preserve_trained)
VALIDATE_MODES: list[tuple[bool, str | None]] = [
    (False, None), (True, None), (False, "point_buy"), (True, "point_buy"), (False, "rolled"), (False, "Point-Buy"),
]


def _try(fn: Callable[[], Any]) -> Any:
    """The call's value, or ``{"$error": {class, message}}`` when it raised."""
    try:
        return jsonable(fn())
    except Exception as exc:  # noqa: BLE001 - the error class IS the vector
        return {"$error": error_dict(exc)}


def _load(sheet_input: dict[str, Any]) -> CharacterSheet:
    return CharacterSheet.from_dict(copy.deepcopy(sheet_input))


# ---------------------------------------------------------------------------
# The literal sheets
# ---------------------------------------------------------------------------


def _coc_cases() -> list[tuple[str, dict[str, Any]]]:
    def sheet(**patch: Any) -> dict[str, Any]:
        return fresh_sheet_input("coc7", "Vera", **patch)

    cases: list[tuple[str, dict[str, Any]]] = [
        ("fresh", sheet()),
        ("typical", sheet(
            attributes={"STR": 60, "CON": 55, "SIZ": 65, "DEX": 70, "APP": 50, "INT": 75, "POW": 60, "EDU": 80, "LUC": 55,
                        "HP": 9, "MP": 8, "SAN": 55},
            skills={"侦查": 60, "图书馆": 70, "心理学": 45, "斗殴": 50, "闪避": None},
            fields={"occupation": "Detective", "age": 41},
        )),
        ("minimum", sheet(attributes={"STR": 15, "CON": 15, "SIZ": 40, "DEX": 15, "APP": 15, "INT": 40, "POW": 15,
                                       "EDU": 40, "LUC": 15})),
        ("maximum", sheet(attributes={key: 90 for key in ("STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC")},
                          skills={"侦查": 90, "图书馆": 90})),
        ("out_of_range", sheet(
            attributes={"STR": 150, "CON": -5, "SIZ": 0, "DEX": 91, "APP": 14, "INT": 39, "POW": 999, "EDU": 100, "LUC": 0},
            skills={"侦查": 150, "图书馆": -10, "聆听": 91, "心理学": 99, "话术": 100},
        )),
        ("string_numerics", sheet(
            attributes={"STR": "65", "CON": "abc", "DEX": None, "APP": True, "INT": 12.7, "POW": "  80 ", "EDU": "", "LUC": [1]},
            skills={"侦查": "40", "图书馆": "x", "聆听": None, "心理学": 33.9, "话术": False},
        )),
        ("empty_sections", sheet(attributes={}, skills={}, secondary_attributes={}, fields={})),
        ("partial_attributes", {**sheet(), "attributes": {"STR": 70, "SIZ": 80}, "skills": {"侦查": 33}}),
        ("no_vitals", sheet(attributes={"HP": None, "MP": None, "SAN": None, "HPMAX": None, "MPMAX": None, "SANMAX": None,
                                        "IDEA": None, "KNOW": None})),
        ("stale_derived", sheet(
            attributes={"HPMAX": 99, "MPMAX": 1, "SANMAX": 5, "IDEA": 1, "KNOW": 2, "HP": 50, "MP": 50, "SAN": 50},
            skills={"闪避": 1, "母语": 3},
        )),
        ("trained_derived", sheet(skills={"闪避": 60, "母语": 90}, attributes={"DEX": 70, "EDU": 60})),
        ("mythos", sheet(attributes={"SAN": 90, "POW": 80}, skills={"克苏鲁神话": 35})),
        ("mythos_max", sheet(attributes={"SAN": 99}, skills={"克苏鲁神话": 99})),
        ("wounded", sheet(attributes={"CON": 60, "SIZ": 70, "POW": 60, "HP": 3, "MP": 2, "SAN": 20})),
        ("vitals_over_max", sheet(attributes={"HP": 99, "MP": 99, "SAN": 150})),
        ("vitals_negative", sheet(attributes={"HP": -4, "MP": -1, "SAN": -9})),
        ("strong_big", sheet(attributes={"STR": 90, "SIZ": 90, "DEX": 40, "CON": 90})),
        ("db_edges_low", sheet(attributes={"STR": 30, "SIZ": 34})),
        ("db_edges_mid", sheet(attributes={"STR": 60, "SIZ": 65})),
        ("mov_variants", sheet(attributes={"STR": 80, "SIZ": 60, "DEX": 70})),
        ("mov_low", sheet(attributes={"STR": 40, "SIZ": 60, "DEX": 40})),
        ("credit_bridge", sheet(skills={"信用": 30, "信用评级": 77})),
        ("custom_skills", sheet(skills={"祖传菜刀": 40, "侦查": 33, "Occult lore": 12})),
        ("age_string", sheet(fields={"age": "41", "occupation": None})),
        ("system_alias", {**sheet(), "system": "call of cthulhu"}),
        ("system_alias_upper", {**sheet(), "system": " CoC7 "}),
        ("dressed", {**sheet(), "equipment": ["revolver", {"name": "lamp", "qty": 2}], "background": "Orphan.",
                     "notes": "n", "avatar": {"kind": "url", "ref": "x"}}),
        ("secondary_junk", {**sheet(), "secondary_attributes": {"生命值": 7, "foo": 1}}),
        ("hp_fields_ignored", {**sheet(), "hp_current": 4, "hp_max": 9}),
        ("skills_overbudget", sheet(skills={"侦查": 90, "图书馆": 90, "心理学": 90, "医学": 90, "法律": 90, "历史": 90, "会计": 90})),
        ("skills_within_budget", sheet(attributes={"INT": 70, "EDU": 80}, skills={"侦查": 60, "图书馆": 60})),
        ("chinese_keys_in_attributes", sheet(attributes={"力量": 70, "体质": 60})),
    ]
    return cases


def _dnd_cases() -> list[tuple[str, dict[str, Any]]]:
    def sheet(**patch: Any) -> dict[str, Any]:
        return fresh_sheet_input("dnd5e", "Kael", **patch)

    def at_level(level: Any, **patch: Any) -> dict[str, Any]:
        return sheet(fields={"level": level}, **patch)

    cases: list[tuple[str, dict[str, Any]]] = [
        ("fresh", sheet()),
        ("fighter_l5", sheet(attributes={"STR": 16, "DEX": 12, "CON": 14, "INT": 10, "WIS": 13, "CHA": 8},
                             fields={"level": 5, "character_class": "Fighter", "race": "Human"},
                             hp_current=44, hp_max=44, skills={"运动": 7})),
        ("minimum", sheet(attributes={key: 3 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA")})),
        ("maximum", sheet(attributes={key: 18 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA")})),
        ("beyond_max", sheet(attributes={key: 30 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA")})),
        ("out_of_range", sheet(attributes={"STR": 25, "DEX": 0, "CON": -2, "INT": 19, "WIS": 2, "CHA": 99})),
        ("point_buy_max", sheet(attributes={key: 15 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA")})),
        ("point_buy_ok", sheet(attributes={"STR": 15, "DEX": 14, "CON": 13, "INT": 12, "WIS": 10, "CHA": 8})),
        ("standard_array", sheet(attributes={"STR": 15, "DEX": 14, "CON": 13, "INT": 12, "WIS": 10, "CHA": 8})),
        ("string_numerics", sheet(attributes={"STR": "16", "DEX": "abc", "CON": None, "INT": True, "WIS": 12.9, "CHA": " 8 "},
                                  skills={"运动": "5", "察觉": "x"})),
        ("empty_sections", sheet(attributes={}, skills={}, secondary_attributes={}, fields={})),
        ("level_0", at_level(0)), ("level_2", at_level(2)), ("level_4", at_level(4)), ("level_5", at_level(5)),
        ("level_9", at_level(9)), ("level_13", at_level(13)), ("level_17", at_level(17)), ("level_20", at_level(20)),
        ("level_21", at_level(21)), ("level_negative", at_level(-3)), ("level_string", at_level("5")),
        ("level_junk", at_level("abc")), ("level_none", at_level(None)),
        ("secondary_overrides", sheet(secondary_attributes={"护甲等级": 18, "被动感知": 15, "速度": 40, "载重": 1, "熟练加值": 4})),
        ("secondary_equal_to_derived", sheet(attributes={"DEX": 14}, secondary_attributes={"护甲等级": 12, "速度": 30})),
        ("trained_skills", sheet(attributes={"WIS": 14, "CHA": 12}, skills={"察觉": 6, "游说": 1, "运动": 0, "求生": 3})),
        ("custom_skills", sheet(skills={"祖传菜刀": 4, "生存": 5})),
        ("hp_over_max", sheet(hp_current=50, hp_max=10)),
        ("hp_negative", sheet(hp_current=-5, hp_max=10)),
        ("hp_current_only", {**sheet(), "hp_current": 7, "hp_max": None}),
        ("hp_max_only", {**sheet(), "hp_current": None, "hp_max": 15}),
        ("hp_none", {**sheet(), "hp_current": None, "hp_max": None}),
        ("hp_legacy_secondary", {**sheet(), "hp_current": None, "hp_max": None,
                                 "secondary_attributes": {"生命值": 12, "生命值上限": 15}}),
        ("hp_legacy_attributes", {**sheet(), "hp_current": None, "hp_max": None, "attributes": {"STR": 10, "HP": 9, "HPMAX": 20}}),
        ("hp_strings", {**sheet(), "hp_current": "8", "hp_max": "12"}),
        ("system_alias", {**sheet(), "system": "D&D5e"}),
        ("dressed", {**sheet(), "equipment": ["sword"], "background": "Soldier.", "notes": "n", "avatar": None}),
        ("fields_unknown", {**sheet(), "fields": {"level": 3, "character_class": "Wizard", "race": "Elf", "mystery": 1}}),
    ]
    return cases


def _wod_cases() -> list[tuple[str, dict[str, Any]]]:
    return [
        ("fresh", fresh_sheet_input("wod", "Nora")),
        ("typical", {**fresh_sheet_input("wod", "Nora"), "attributes": {"Strength": 3, "Dexterity": 2}, "skills": {"Brawl": 2, "Stealth": 1}}),
        ("junk", {**fresh_sheet_input("wod", "Nora"), "attributes": {"x": "3", "y": None, "z": 2.5}, "skills": {"a": True}}),
        ("alias_system", {**fresh_sheet_input("wod", "Nora"), "system": "world of darkness"}),
    ]


def _synth_cases() -> list[tuple[str, dict[str, Any]]]:
    pack = synthetic.SYNTH_ID

    def sheet(**patch: Any) -> dict[str, Any]:
        return fresh_sheet_input(pack, "Ilya", **patch)

    return [
        ("fresh", sheet()),
        ("typical", sheet(attributes={"MUS": 14, "NRV": 9, "WIT": 13, "GRIT": 4, "FATE": 2}, fields={"level": 6, "klass": "Rogue"},
                          hp_current=9, hp_max=20, skills={"LORE": 7})),
        ("out_of_range", sheet(attributes={"MUS": 25, "NRV": 2, "WIT": -1, "GRIT": 40})),
        ("point_buy_over", sheet(attributes={"MUS": 14, "NRV": 14, "WIT": 14})),
        ("point_buy_ok", sheet(attributes={"MUS": 10, "NRV": 8, "WIT": 8})),
        ("band_edges", sheet(attributes={"MUS": 4, "NRV": 5})),
        ("band_top", sheet(attributes={"MUS": 20, "NRV": 20})),
        ("level_5_cap", sheet(attributes={"GRIT": 9}, fields={"level": 9})),
        ("level_0", sheet(fields={"level": 0})),
        ("fate_over", sheet(attributes={"FATE": 99, "GRIT": 4}, fields={"level": 2})),
        ("fate_none", sheet(attributes={"FATE": None})),
        ("trained_derived", sheet(skills={"athletics": 9, "bluff": 4}, attributes={"MUS": 12, "WIT": 14})),
        ("secondary_override", sheet(secondary_attributes={"PROF": 5, "GUARD": 9})),
        ("skills_overbudget", sheet(attributes={"WIT": 8, "MUS": 6, "NRV": 6}, skills={"sneak": 60, "brawl": 40, "LORE": 30})),
        ("hp_over_max", sheet(hp_current=40, hp_max=11)),
        ("strings", sheet(attributes={"MUS": "14", "NRV": "x", "WIT": None, "GRIT": 4.8}, fields={"level": "3"})),
    ]


# ---------------------------------------------------------------------------
# Name probes
# ---------------------------------------------------------------------------

SAMPLE_NAMES: dict[str, list[str]] = {
    "coc7": [
        "str", "STR", "strength", "力量", "san", "SAN值", "理智值", "hp", "生命", "生命值", "mp", "魔法", "spot hidden",
        "侦查", "偵查", "library use", "图书馆使用", "圖書館", "sleight of hand", "妙手", "驾驶:飞行器", "驾驶（飞行器）",
        "艺术和手艺（表演）", "art", "克苏鲁神话", "cthulhu mythos", "db", "damage bonus", "build", "mov", "luck", "LUC",
        "幸运值", "credit rating", "信用", "信用评级", "dodge", "闪避", "own language", "母语", "  侦查  ", "SPOT_HIDDEN",
        "Spot Hidden", "unknown skill", "", "不存在的技能", "祖传菜刀", "Occult lore",
    ],
    "dnd5e": [
        "str", "STR", "strength", "力量", "dex", "athletics", "运动", "acrobatics", "hp", "生命值", "ac", "护甲等级", "dc", "pp",
        "passive perception", "被动察觉", "proficiency", "熟练", "熟练加值", "level", "等级", "sleight of hand", "perception",
        "察觉", "survival", "求生", "生存", "先攻修正", "速度", "载重", "负重", "class", "职业", "race", "种族", "unknown", "",
        "祖传菜刀", "SPOT", "hit dice", "hd",
    ],
    "wod": ["strength", "力量", "Brawl", "Strength", "unknown", "", "a", "x"],
    synthetic.SYNTH_ID: [
        "mus", "肌力", "Might", "muscle", "lvl", "等级", "athl", "运动力", "hp", "生命", "hpmax", "fate", "命运", "lore master",
        "知识面", "prof", "guard", "band", "muscle_mod", "nerve_mod", "wit_mod", "class", "klass", "MUS", "LORE", "sneak",
        "brawl", "unknown", "", "reach", "fatemax", "grit",
    ],
}


def _probe_names(pack_id: str) -> list[str]:
    pack = load_rulepack(pack_id)
    spec = pack.sheet_spec
    names: list[str] = [*pack.defaults.keys(), *pack.derived_formulas.keys(), *pack.alias.keys()]
    if spec is not None:
        for mapping in (spec.attr_keys, spec.skill_keys, spec.secondary_keys, spec.field_keys, spec.check_values):
            names.extend(mapping.keys())
            names.extend(mapping.values())
        names.extend(spec.attributes.keys())
        names.extend(spec.skills.keys())
        names.extend(spec.secondary.keys())
    names.extend(SAMPLE_NAMES.get(pack_id, []))
    seen: dict[str, None] = {}
    for name in names:
        seen.setdefault(str(name), None)
    return list(seen)


# ---------------------------------------------------------------------------
# Per-case vector
# ---------------------------------------------------------------------------


def _violation(violation: Any) -> dict[str, Any]:
    return {
        "code": violation.code,
        "path": violation.path,
        "original": jsonable(violation.original),
        "corrected": jsonable(violation.corrected),
        "limit": jsonable(violation.limit),
    }


def _case_row(pack_id: str, case: str, sheet_input: dict[str, Any], names: list[str]) -> dict[str, Any]:
    pack = load_rulepack(pack_id)
    loaded = _load(sheet_input)
    out: dict[str, Any] = {
        "kind": "sheet_case",
        "pack": pack_id,
        "case": case,
        "input": sheet_input,
        "loaded": sheet_dict(loaded),
    }
    values = _try(lambda: canonical_values(loaded, pack))
    out["canonical_values"] = values
    out["derived"] = _try(lambda: pack.compute_derived(canonical_values(loaded, pack)))
    out["hit_points"] = _try(lambda: list(get_hit_points(loaded)))

    refreshed: dict[str, Any] = {}
    for initialize, preserve in REFRESH_MODES:
        key = f"init{int(initialize)}_keep{int(preserve)}"

        def _refresh(initialize: bool = initialize, preserve: bool = preserve) -> dict[str, Any]:
            working = _load(sheet_input)
            refresh_sheet(working, pack, initialize_vitals=initialize, preserve_trained=preserve)
            return sheet_dict(working)

        refreshed[key] = _try(_refresh)
    out["refreshed"] = refreshed

    # Name resolution: the engine's callers resolve a typed name through the pack alias table first,
    # then ask for the value; has_check_value takes the raw typed name.
    canonical_of = [pack.resolve_skill(name) or name for name in names]
    out["probe"] = {
        "value": [_try(lambda c=c: sheet_value(loaded, pack, c)) for c in canonical_of],
        "check_value": [_try(lambda c=c: check_value(loaded, pack, c)) for c in canonical_of],
        "has_check": [_try(lambda n=n: has_check_value(loaded, pack, n)) for n in names],
    }

    refreshed_sheet = _load(sheet_input)
    refresh_sheet(refreshed_sheet, pack)
    out["wire"] = {
        "loaded": [{"locale": locale, "resources": _try(lambda loc=locale: wire_resources(loaded, pack, loc))} for locale in WIRE_LOCALES],
        "refreshed": [
            {"locale": locale, "resources": _try(lambda loc=locale: wire_resources(refreshed_sheet, pack, loc))}
            for locale in WIRE_LOCALES
        ],
    }

    validations = []
    for initialize, method in VALIDATE_MODES:

        def _validate(initialize: bool = initialize, method: str | None = method) -> dict[str, Any]:
            clamped, violations = validate_sheet(_load(sheet_input), pack_id, initialize_vitals=initialize, creation_method=method)
            return {"sheet": sheet_dict(clamped), "violations": [_violation(item) for item in violations]}

        validations.append({"initialize_vitals": initialize, "creation_method": method, "result": _try(_validate)})
    out["validate"] = validations
    return out


# ---------------------------------------------------------------------------
# Pure pieces
# ---------------------------------------------------------------------------

ALIAS_PROBES = [
    "", " ", "  侦查  ", "SPOT HIDDEN", "Spot_Hidden", "spot  hidden", "spot\thidden", "驾驶：飞行器", "驾驶:飞行器", "驾驶（飞行器）",
    "驾驶(飞行器)", "艺术和手艺（表演）", "艺术和手艺:表演", "ＳＴＲ", "str ", "Ｓtr", "ß", "İ", "ǅ", "nope", "力 量", "力量力量",
]


def _alias_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for pack_id in (*BUILTIN, synthetic.SYNTH_ID):
        pack = load_rulepack(pack_id)
        probes: dict[str, None] = {}
        for canonical, variants in pack.alias.items():
            probes.setdefault(canonical, None)
            for variant in variants:
                probes.setdefault(str(variant), None)
        for name in (*pack.defaults.keys(), *ALIAS_PROBES, *SAMPLE_NAMES.get(pack_id, [])):
            probes.setdefault(str(name), None)
        for name in list(probes):
            probes.setdefault(name.upper(), None)
            probes.setdefault(f"  {name}  ", None)
        for name in probes:
            rows.append({"kind": "resolve_skill", "pack": pack_id, "name": name, "canonical": pack.resolve_skill(name)})
    # Pack lookup by id, declared name or set_key (case/space-insensitive).
    for name in ("coc", "CoC", "coc7", " CoC7 ", "call of cthulhu", "Call Of Cthulhu", "dnd", "D&D5e", "dnd5e", "DND5E", "wod",
                 "World Of Darkness", "world_of_darkness", "oraclesynth", "oracle synth", "unknown", "", "coc8", "d&d", "dnd 5e"):
        row: dict[str, Any] = {"kind": "load_rulepack", "name": name, "pack": None, "error": None}
        try:
            row["pack"] = load_rulepack(name).system
        except Exception as exc:  # noqa: BLE001
            row["error"] = error_dict(exc)
        rows.append(row)
    rows.append({"kind": "built_in_ids", "ids": sorted(rulepacks.built_in_rulepack_ids())})
    rows.append({"kind": "available_systems_contains", "ids": [name for name in available_systems() if name in (*BUILTIN, *synthetic.PACKS)]})
    for system in ("coc7", "CoC", "dnd5e", "wod", "oraclesynth", "unknown", ""):
        for locale in WIRE_LOCALES:
            rows.append({"kind": "resource_label_map", "system": system, "locale": locale, "labels": resource_label_map(system, locale)})
    return rows


# -- compute_derived sweeps ------------------------------------------------------------------------


def _derived_row(pack_id: str, values: dict[str, Any]) -> dict[str, Any]:
    pack = load_rulepack(pack_id)
    return {
        "kind": "derived",
        "pack": pack_id,
        "values": values,
        "derived": _try(lambda: pack.compute_derived(values)),
    }


WEIRD_VALUES: list[Any] = ["50", " 50 ", "abc", "", None, True, False, 12.7, 12.0, -5, 0, 10**12, [1], {"a": 1}, "1e3", "0x10", "٣"]


def _derived_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(pack_id: str, values: dict[str, Any]) -> None:
        rows.append(_derived_row(pack_id, values))

    # --- coc7: damage bonus / build bands, MOV, HP / MP / SAN maxima, copies and halves
    add("coc7", {})
    for strength in (0, 15, 30, 40, 50, 65, 80, 90, 100, 125, 150, 200):
        for size in (0, 15, 40, 50, 65, 80, 90, 120, 165):
            add("coc7", {"力量": strength, "体型": size})
    for total in (*range(63, 67), *range(83, 87), *range(123, 127), *range(163, 167), *range(203, 207), *range(283, 287),
                  *range(363, 367), *range(443, 447), 525, 605, 1000):
        add("coc7", {"力量": total, "体型": 0})
        add("coc7", {"力量": 0, "体型": total})
    for dex in (40, 49, 50, 51, 60):
        for strength in (40, 49, 50, 51, 60):
            for size in (50, 49, 51):
                add("coc7", {"敏捷": dex, "力量": strength, "体型": size})
    for con in (0, 9, 10, 15, 50, 90):
        for size in (0, 9, 10, 15, 50, 90):
            add("coc7", {"体质": con, "体型": size})
    for power in range(0, 121):
        add("coc7", {"意志": power})
    for value in range(0, 101):
        add("coc7", {"敏捷": value, "教育": value, "智力": value, "克苏鲁神话": value})
    for key in ("力量", "体型", "体质", "意志", "敏捷", "教育", "智力", "克苏鲁神话"):
        for weird in WEIRD_VALUES:
            add("coc7", {key: weird})
    add("coc7", {"力量": 60, "体型": 60, "未知": "x"})
    # --- dnd5e: ability modifiers floor toward -infinity, proficiency by level, derived skills
    add("dnd5e", {})
    for key in ("力量", "敏捷", "体质", "智力", "感知", "魅力"):
        for score in range(-2, 32):
            add("dnd5e", {key: score})
    for level in range(-5, 26):
        add("dnd5e", {"等级": level})
    for wisdom in (1, 8, 9, 10, 11, 12, 20):
        for trained in (None, 0, 5):
            values: dict[str, Any] = {"感知": wisdom}
            if trained is not None:
                values["察觉"] = trained
            add("dnd5e", values)
    for key in ("力量", "感知", "等级", "察觉"):
        for weird in WEIRD_VALUES:
            add("dnd5e", {key: weird})
    # --- wod: no derived section at all
    add("wod", {})
    add("wod", {"Strength": 3})
    # --- oraclesynth: floor_div, half_of, banded strings, if/min/max/abs/ceil expressions
    synth = synthetic.SYNTH_ID
    add(synth, {})
    for key in ("muscle", "nerve", "wit", "grit", "level"):
        for score in range(-2, 42):
            add(synth, {key: score})
    for muscle in (0, 4, 5, 9, 10, 14, 15, 20, 29, 30, 49, 50, 100):
        for nerve in (0, 4, 9, 10, 20, 30, 50):
            add(synth, {"muscle": muscle, "nerve": nerve})
    for key in ("muscle", "nerve", "wit", "level"):
        for weird in WEIRD_VALUES:
            add(synth, {key: weird})
    return rows


# ---------------------------------------------------------------------------
# Mutations, creation, hit points
# ---------------------------------------------------------------------------


def _set_value_rows(cases: dict[str, list[tuple[str, dict[str, Any]]]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    writes: dict[str, list[tuple[str, Any]]] = {
        "coc7": [("力量", 70), ("力量", 0), ("力量", 999), ("敏捷", 90), ("体质", 30), ("体型", 30), ("教育", 80), ("意志", 40),
                 ("智力", 90), ("幸运", 5), ("理智", 10), ("理智", 500), ("生命值", 3), ("魔法值", 2), ("信用评级", 45),
                 ("侦查", 80), ("闪避", 33), ("母语", 61), ("克苏鲁神话", 20), ("自定义技能", 33), ("职业", "Detective"),
                 ("年龄", 30), ("DB", 5), ("移动力", 11), ("生命值上限", 99), ("理智上限", 3), ("STR", 44)],
        "dnd5e": [("力量", 18), ("敏捷", 8), ("体质", 3), ("智力", 30), ("等级", 5), ("等级", 20), ("等级", 1), ("hp", 5), ("hp", 99),
                  ("hp", -3), ("hpmax", 30), ("hpmax", 2), ("hpmax", -1), ("护甲等级", 18), ("先攻修正", 3), ("速度", 40),
                  ("熟练加值", 4), ("察觉", 6), ("运动", 0), ("求生", 3), ("生存", 3), ("自定义技能", 33), ("职业", "Wizard"),
                  ("种族", "Elf")],
        "wod": [("Strength", 3), ("Brawl", 2), ("力量", 4)],
        synthetic.SYNTH_ID: [("muscle", 16), ("wit", 6), ("grit", 8), ("fate", 2), ("fatemax", 9), ("level", 5), ("lore", 7),
                             ("athletics", 3), ("prof", 4), ("guard", 8), ("hp", 5), ("hpmax", 30), ("class", "Rogue"), ("custom", 1)],
    }
    chosen = {
        "coc7": ["fresh", "wounded", "trained_derived", "typical"],
        "dnd5e": ["fresh", "fighter_l5", "secondary_overrides", "hp_legacy_secondary"],
        "wod": ["fresh"],
        synthetic.SYNTH_ID: ["fresh", "typical"],
    }
    for pack_id, items in writes.items():
        pack = load_rulepack(pack_id)
        by_case = dict(cases[pack_id])
        for case in chosen[pack_id]:
            for canonical, value in items:
                sheet = _load(by_case[case])
                result: dict[str, Any] = {"kind": "set_sheet_value", "pack": pack_id, "case": case, "canonical": canonical,
                                          "value": value, "sheet_after": None, "error": None}
                try:
                    set_sheet_value(sheet, pack, canonical, value)
                    result["sheet_after"] = sheet_dict(sheet)
                except Exception as exc:  # noqa: BLE001
                    result["error"] = error_dict(exc)
                rows.append(result)
    return rows


def _hit_point_rows(cases: dict[str, list[tuple[str, dict[str, Any]]]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    operations: list[dict[str, Any]] = [
        {}, {"current": 5}, {"current": 0}, {"current": -4}, {"current": 99}, {"current": 99, "allow_raise_max": True},
        {"maximum": 20}, {"maximum": 3}, {"maximum": 0}, {"maximum": -5}, {"delta": -3}, {"delta": 4}, {"delta": -100},
        {"delta": 100}, {"delta": 100, "allow_raise_max": True}, {"current": 4, "maximum": 9}, {"current": 9, "maximum": 4},
        {"current": 4, "delta": 3}, {"maximum": 12, "delta": 2}, {"current": "6"}, {"maximum": "15", "delta": "-2"},
    ]
    for pack_id, case_names in (("dnd5e", ("fresh", "fighter_l5", "hp_legacy_secondary", "hp_none", "hp_over_max")),
                                ("coc7", ("fresh", "wounded")), (synthetic.SYNTH_ID, ("fresh", "typical"))):
        by_case = dict(cases[pack_id])
        for case in case_names:
            for operation in operations:
                sheet = _load(by_case[case])
                row: dict[str, Any] = {"kind": "set_hit_points", "pack": pack_id, "case": case, "operation": operation,
                                       "result": None, "sheet_after": None, "error": None}
                try:
                    row["result"] = list(set_hit_points(sheet, **operation))
                    row["sheet_after"] = sheet_dict(sheet)
                except Exception as exc:  # noqa: BLE001
                    row["error"] = error_dict(exc)
                rows.append(row)
    return rows


def _creation_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    services = build_services(
        Settings(_env_file=None, data_dir=str(scratch_dir() / "sheets")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    manager = services.characters
    # A brand-new sheet: constructor defaults plus the creation-time refresh, for any spelling of the system.
    for system in ("coc7", "CoC", "call of cthulhu", "dnd5e", "DnD5e", "wod", "oraclesynth", "nonsense", ""):
        rows.append({"kind": "new_sheet", "system": system, "name": "Vera", "sheet": sheet_dict(CharacterSheet("Vera", system))})
    # generate_character: the pack's declared creation rolls, in declaration order, then the creation refresh.
    for system in ("coc7", "dnd5e", "wod", "oraclesynth", "CoC", "nonsense"):
        for seed in (1, 2, 3, 4, 5, 6):
            sheet_out = None
            error = None
            with scripted_random(seed) as log:
                try:
                    sheet_out = sheet_dict(manager.generate_character(system, "Hero"))
                except Exception as exc:  # noqa: BLE001
                    error = error_dict(exc)
            rows.append({"kind": "generate_character", "system": system, "name": "Hero", "seed": seed, "forced": None,
                         "draws": log.draws, "sheet": sheet_out, "error": error})
    for system, forced in (("coc7", [1] * 20), ("coc7", [6] * 20), ("dnd5e", [1] * 30), ("dnd5e", [6] * 30), ("oraclesynth", [6] * 12)):
        with scripted_random(1, forced) as log:
            sheet_out = sheet_dict(manager.generate_character(system, "Hero"))
        rows.append({"kind": "generate_character", "system": system, "name": "Hero", "seed": 1, "forced": forced,
                     "draws": log.draws, "sheet": sheet_out, "error": None})
    return rows


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export() -> list[tuple[str, int, str]]:
    synthetic.install()
    cases = {
        "coc7": _coc_cases(),
        "dnd5e": _dnd_cases(),
        "wod": _wod_cases(),
        synthetic.SYNTH_ID: _synth_cases(),
    }
    probe_rows: list[dict[str, Any]] = []
    case_rows: list[dict[str, Any]] = []
    for pack_id, pack_cases in cases.items():
        names = _probe_names(pack_id)
        pack = load_rulepack(pack_id)
        probe_rows.append(
            {
                "kind": "probe_names",
                "pack": pack_id,
                "names": names,
                "canonical": [pack.resolve_skill(name) or name for name in names],
                "resolved": [pack.resolve_skill(name) for name in names],
            }
        )
        for case, sheet_input in pack_cases:
            case_rows.append(_case_row(pack_id, case, sheet_input, names))
    mutation_rows = [*_set_value_rows(cases), *_hit_point_rows(cases)]
    creation_rows = _creation_rows()
    assert_scripts_held(creation_rows)
    return [
        write_jsonl("sheets_aliases", _alias_rows()),
        write_jsonl("sheets_derived", _derived_rows()),
        write_jsonl("sheets_cases", [*probe_rows, *case_rows]),
        write_jsonl("sheets_ops", [*mutation_rows, *creation_rows]),
    ]
