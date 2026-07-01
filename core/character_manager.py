"""Character sheet management for TRPG systems (CoC7 / DnD5e / other).

Ported from ``nekro_trpg_dice_plugin``'s ``core/character_manager.py``. Per
the M0 spec (``docs/specs/M0.md`` §3), the only sanctioned changes are:

- the injected store is `infra.store.Store` (same async get/set/delete
  signature as the source's ``FakeStore`` — a drop-in replacement);
- every user-visible natural-language string is emitted via `infra.i18n.t`
  instead of being hardcoded (skill/attribute/template names are TRPG
  *game data*, not UI text, and are kept verbatim — see
  `core/prompt_sections.py`'s ``summarize_knowledge_item`` for the same
  data-vs-UI-text distinction);
- `CharacterTemplate.apply_to_character` now instantiates
  `core.dice_engine.DiceRoller` (an object with an instance method
  ``roll_expression(expr) -> DiceResult``) instead of calling it as a
  staticmethod, matching the M0 §2.2 contract for the d20-backed engine;
- `_get_char_list_key` is a plain (non-async) helper. The source declared it
  `async def` but every call site invoked it *without* `await`, which quietly
  turned the store lookup key into an unawaited coroutine object — breaking
  `list_characters`/`_update_char_list` (verified against the source: it
  always returned `[]`). Since `list_characters` must keep working, that
  bug is fixed here; it performs no I/O so it never needed to be async.

All character-sheet math — attribute defaults, dice-based generation
formulas, skill values, DND5e proficiency/modifier arithmetic — is kept
byte-for-byte from the source.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from infra.i18n import t
from infra.store import Store

# core/character_manager.py -> core/ -> repo root -> templates/
TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"


class CharacterSheet:
    """A single character/investigator sheet for one TRPG system."""

    def __init__(self, name: str = "", system: str = "CoC") -> None:
        self.name = name
        self.system = system  # "CoC", "DnD5e", "WoD", ...

        # Base attributes (official CoC7 defaults).
        if system == "CoC":
            self.attributes: dict[str, Any] = {
                "STR": 50, "CON": 50, "SIZ": 50, "DEX": 50,
                "APP": 50, "INT": 50, "POW": 50, "EDU": 50, "LUC": 50,
                # derived attributes
                "SAN": 50, "SANMAX": 50, "HP": 10, "HPMAX": 10,
                "MP": 10, "MPMAX": 10, "IDEA": 50, "KNOW": 50,
                # bonus attributes
                "SANMAXADD": 0, "HPMAXADD": 0, "MPMAXADD": 0,
            }
            self.secondary_attributes: dict[str, Any] = {}
            # CoC7 standard starting skill values.
            self.skills: dict[str, Any] = {
                "会计": 5, "人类学": 1, "估价": 5, "考古学": 1, "取悦": 15,
                "攀爬": 20, "计算机使用": 5, "信用": 0, "克苏鲁神话": 0,
                "乔装": 5, "闪避": 0,  # dodge is derived from DEX below
                "汽车驾驶": 20, "电气维修": 10,
                "电子学": 1, "话术": 5, "急救": 30, "历史": 5,
                "恐吓": 15, "跳跃": 20, "母语": 0,  # own language is derived from EDU below
                "法律": 5,
                "图书馆": 20, "聆听": 20, "锁匠": 1, "机械维修": 10,
                "医学": 1, "博物": 10, "导航": 10, "神秘学": 5,
                "操作重型机械": 1, "说服": 10, "精神分析": 1, "心理学": 10,
                "骑乘": 5, "妙手": 10, "侦查": 25, "潜行": 20,
                "游泳": 20, "投掷": 20, "追踪": 10, "驯兽": 5,
                "潜水": 1, "爆破": 1, "读唇": 1, "催眠": 1,
                "炮术": 1, "手枪": 20, "步霰": 25, "斗殴": 20,
            }
            self._calc_coc_derived_skills()
            self.occupation = ""
            self.age = 25
        elif system == "DnD5e":
            self.attributes = {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10}
            self.secondary_attributes = {
                "生命值": 8, "护甲等级": 10, "先攻修正": 0, "速度": 30,
                "熟练加值": 2, "被动感知": 10,
            }
            self.skills = {}
            self.character_class = ""
            self.race = ""
            self.level = 1
        else:
            self.attributes = {}
            self.secondary_attributes = {}
            self.skills = {}

        self.equipment: list[Any] = []
        self.background = ""
        self.notes = ""
        self.created_time = time.time()
        self.last_updated = time.time()

    def _calc_coc_derived_skills(self) -> None:
        """Fill in CoC7 skills whose starting value is derived from an attribute."""
        dex = self.attributes.get("DEX", 50)
        edu = self.attributes.get("EDU", 50)
        self.skills["闪避"] = dex // 2
        self.skills["母语"] = edu

    def get_modifier(self, attribute: str) -> int:
        """Attribute modifier: DnD5e uses `(value-10)//2`; CoC uses the raw value."""
        if self.system == "DnD5e":
            value = self.attributes.get(attribute, 10)
            return (value - 10) // 2
        if self.system == "CoC":
            return self.attributes.get(attribute, 50)
        return 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "system": self.system,
            "attributes": self.attributes,
            "secondary_attributes": getattr(self, "secondary_attributes", {}),
            "skills": self.skills,
            "equipment": getattr(self, "equipment", []),
            "background": getattr(self, "background", ""),
            "notes": getattr(self, "notes", ""),
            "occupation": getattr(self, "occupation", ""),
            "age": getattr(self, "age", 25),
            "character_class": getattr(self, "character_class", ""),
            "race": getattr(self, "race", ""),
            "level": getattr(self, "level", 1),
            "created_time": self.created_time,
            "last_updated": self.last_updated,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CharacterSheet:
        character = cls(data.get("name", ""), data.get("system", "CoC"))
        character.attributes = data.get("attributes", {})
        character.secondary_attributes = data.get("secondary_attributes", {})
        character.skills = data.get("skills", {})
        character.equipment = data.get("equipment", [])
        character.background = data.get("background", "")
        character.notes = data.get("notes", "")
        character.occupation = data.get("occupation", "")
        character.age = data.get("age", 25)
        character.character_class = data.get("character_class", "")
        character.race = data.get("race", "")
        character.level = data.get("level", 1)
        character.created_time = data.get("created_time", time.time())
        character.last_updated = data.get("last_updated", time.time())
        return character


class CharacterTemplate:
    """Character-generation template (OlivaDice-style): multi-system attribute/skill
    generation rules, skill aliases and check-rule configuration, with an optional
    JSON-file override (`templates/{name}.json`) falling back to the hardcoded
    COC7/DND5E defaults below.
    """

    def __init__(self, name: str, system: str) -> None:
        self.name = name
        self.system = system
        self.main_dice = "1d100"  # default check die

        self.attributes: dict[str, Any] = {}
        self.skills: dict[str, Any] = {}
        # Derived-attribute formulas, e.g. {"SANMAX": "{POW}"}.
        self.mapping: dict[str, str] = {}
        # Skill aliases: standard skill name -> list of alternate names.
        self.synonyms: dict[str, list[str]] = {}

        self.check_rules: dict[str, Any] = {
            "critical_success": [1],
            "critical_failure": [100],
            "success_levels": {
                "极难成功": 20,
                "困难成功": 50,
                "普通成功": 100,
            },
        }

        self.init_rules: dict[str, Any] = {}

    def apply_to_character(self, character: CharacterSheet) -> None:
        """Roll/compute this template's attributes, skills and derived mappings
        onto `character` in place."""
        from core.dice_engine import DiceRoller  # local import: core.dice_engine may not be loaded yet

        character.system = self.system
        roller = DiceRoller()

        for attr, value in self.attributes.items():
            if isinstance(value, dict) and "dice" in value:
                roll_result = roller.roll_expression(value["dice"])
                character.attributes[attr] = roll_result.total
            elif isinstance(value, int | float | str):
                try:
                    numeric_value = int(value)
                except ValueError:
                    character.notes = f"{character.notes}\n{attr}: {value}".strip()
                else:
                    character.attributes[attr] = numeric_value
            else:
                character.notes = f"{character.notes}\n{attr}: {value}".strip()

        for skill, value in self.skills.items():
            if isinstance(value, dict) and "dice" in value:
                roll_result = roller.roll_expression(value["dice"])
                character.skills[skill] = roll_result.total
            elif isinstance(value, str) and "{" in value:
                # Formula string, e.g. "{EDU}", "({DEX})/2".
                try:
                    calc_formula = value
                    for attr, attr_value in character.attributes.items():
                        calc_formula = calc_formula.replace(f"{{{attr}}}", str(attr_value))
                    result = eval(calc_formula, {"__builtins__": {}})  # noqa: S307
                    character.skills[skill] = int(result)
                except Exception:
                    character.skills[skill] = 0
            elif isinstance(value, int):
                character.skills[skill] = value
            elif isinstance(value, float | str):
                try:
                    character.skills[skill] = int(value)
                except ValueError:
                    character.skills[skill] = 0
            else:
                character.skills[skill] = 0

        self._calculate_mappings(character)

    def _calculate_mappings(self, character: CharacterSheet) -> None:
        """Evaluate derived-attribute formulas (`self.mapping`) against `character`."""
        for target, formula in self.mapping.items():
            try:
                calc_formula = formula
                for attr, value in character.attributes.items():
                    calc_formula = calc_formula.replace(f"{{{attr}}}", str(value))
                # Skills too, so a cap like SANMAX = "99 - {克苏鲁神话}" can reference a
                # skill value; skills are already numeric here (computed just above).
                for skill, value in character.skills.items():
                    calc_formula = calc_formula.replace(f"{{{skill}}}", str(value))
                result = eval(calc_formula, {"__builtins__": {}})  # noqa: S307
                character.attributes[target] = int(result)
            except Exception:
                pass  # skip attributes whose formula fails to evaluate

    def find_skill_alias(self, skill_name: str) -> str | None:
        """Resolve `skill_name` to its standard skill name via `self.synonyms`."""
        skill_name = skill_name.lower().strip()

        for standard_name, aliases in self.synonyms.items():
            if skill_name == standard_name.lower():
                return standard_name
            if skill_name in [alias.lower() for alias in aliases]:
                return standard_name

        return None

    @classmethod
    def get_coc7_template(cls) -> CharacterTemplate:
        json_path = TEMPLATE_DIR / "coc7_template.json"
        if json_path.exists():
            try:
                return cls._load_from_json(json_path)
            except Exception:
                pass  # fall through to the hardcoded template below

        template = cls("COC7标准", "CoC")
        template.main_dice = "1d100"

        template.attributes = {
            "STR": {"dice": "3d6x5"},  # Strength
            "CON": {"dice": "3d6x5"},  # Constitution
            "SIZ": {"dice": "(2d6+6)x5"},  # Size
            "DEX": {"dice": "3d6x5"},  # Dexterity
            "APP": {"dice": "3d6x5"},  # Appearance
            "INT": {"dice": "(2d6+6)x5"},  # Intelligence
            "POW": {"dice": "3d6x5"},  # Power
            "EDU": {"dice": "(2d6+6)x5"},  # Education
            "LUC": {"dice": "3d6x5"},  # Luck
        }

        template.mapping = {
            # CoC7e: starting SAN = POW, but the sanity *cap* is 99 - Cthulhu Mythos
            # (default 0 -> 99), never POW. Matches the rulepack `_coc_sanmax`.
            "SANMAX": "99 - {克苏鲁神话}",
            "SAN": "{POW}",
            "HPMAX": "({CON}+{SIZ})/10",
            "HP": "({CON}+{SIZ})/10",
            "MPMAX": "{POW}/5",
            "MP": "{POW}/5",
            "IDEA": "{INT}",
            "KNOW": "{EDU}",
        }

        template.skills = {
            "会计": 5, "人类学": 1, "估价": 5, "考古学": 1, "取悦": 15,
            "攀爬": 20, "计算机使用": 5, "信用": 0, "克苏鲁神话": 0,
            "乔装": 5, "闪避": "({DEX})/2",
            "汽车驾驶": 20, "电气维修": 10,
            "电子学": 1, "话术": 5, "急救": 30, "历史": 5,
            "恐吓": 15, "跳跃": 20, "母语": "{EDU}",
            "法律": 5,
            "图书馆": 20, "聆听": 20, "锁匠": 1, "机械维修": 10,
            "医学": 1, "博物": 10, "导航": 10, "神秘学": 5,
            "操作重型机械": 1, "说服": 10, "精神分析": 1, "心理学": 10,
            "骑乘": 5, "妙手": 10, "侦查": 25, "潜行": 20,
            "游泳": 20, "投掷": 20, "追踪": 10, "驯兽": 5,
            "潜水": 1, "爆破": 1, "读唇": 1, "催眠": 1,
            "炮术": 1, "手枪": 20, "步霰": 25, "斗殴": 20,
        }

        template.synonyms = {
            "会计": ["accounting", "会计学"],
            "人类学": ["anthropology", "人类学"],
            "估价": ["appraise", "鉴定", "估价"],
            "考古学": ["archaeology", "考古学"],
            "取悦": ["charm", "魅惑", "取悦"],
            "攀爬": ["climb", "攀爬"],
            "计算机使用": ["computer use", "电脑", "计算机"],
            "信用": ["credit rating", "信用评级", "信用"],
            "克苏鲁神话": ["cthulhu mythos", "神话", "克苏鲁"],
            "乔装": ["disguise", "伪装", "乔装"],
            "闪避": ["dodge", "回避", "闪避"],
            "汽车驾驶": ["drive auto", "驾驶", "开车"],
            "电气维修": ["electrical repair", "电器", "电气"],
            "话术": ["fast talk", "快速交谈", "话术"],
            "急救": ["first aid", "医疗", "急救"],
            "历史": ["history", "历史"],
            "恐吓": ["intimidate", "威吓", "恐吓"],
            "跳跃": ["jump", "跳跃"],
            "母语": ["own language", "母语"],
            "法律": ["law", "法学", "法律"],
            "图书馆": ["library use", "图书馆使用", "图书馆"],
            "聆听": ["listen", "倾听", "聆听"],
            "锁匠": ["locksmith", "开锁", "锁匠"],
            "机械维修": ["mechanical repair", "机械", "维修"],
            "医学": ["medicine", "医疗", "医学"],
            "博物": ["natural world", "自然", "博物"],
            "导航": ["navigate", "导航"],
            "神秘学": ["occult", "神秘学"],
            "说服": ["persuade", "劝说", "说服"],
            "心理学": ["psychology", "心理学"],
            "骑乘": ["ride", "骑术", "骑乘"],
            "妙手": ["sleight of hand", "巧手", "妙手"],
            "侦查": ["spot hidden", "发现", "侦查", "侦察"],
            "潜行": ["stealth", "隐匿", "潜行"],
            "游泳": ["swim", "游泳"],
            "投掷": ["throw", "投掷"],
            "追踪": ["track", "追踪"],
            "斗殴": ["fighting brawl", "格斗（斗殴）", "格斗-斗殴", "格斗：斗殴", "格斗", "斗殴"],
            "手枪": ["handgun", "射击（手枪）", "射击-手枪", "射击：手枪", "射击", "手枪"],
            "步霰": [
                "rifle/shotgun", "射击（步枪/霰弹枪）", "射击（霰弹枪）", "射击（步枪）",
                "射击-霰弹枪", "射击-步枪", "射击：霰弹枪", "射击：步枪", "步枪/霰弹枪",
                "长枪", "步枪", "霰弹枪",
            ],
        }

        return template

    @classmethod
    def get_dnd5e_template(cls) -> CharacterTemplate:
        json_path = TEMPLATE_DIR / "dnd5e_template.json"
        if json_path.exists():
            try:
                return cls._load_from_json(json_path)
            except Exception:
                pass  # fall through to the hardcoded template below

        template = cls("DND5E标准", "DnD5e")
        template.main_dice = "1d20"

        # Six base ability scores, generated 4d6-drop-lowest.
        template.attributes = {
            "STR": {"dice": "4d6k3"},  # Strength
            "DEX": {"dice": "4d6k3"},  # Dexterity
            "CON": {"dice": "4d6k3"},  # Constitution
            "INT": {"dice": "4d6k3"},  # Intelligence
            "WIS": {"dice": "4d6k3"},  # Wisdom
            "CHA": {"dice": "4d6k3"},  # Charisma
        }

        template.mapping = {
            "速度": "30",
            "先攻修正": "({DEX}-10)/2",
            "载重": "{STR}*15",
            "负重": "{STR}*10",
            "护甲等级": "10+({DEX}-10)/2",
        }

        # Skill base values (ability-modifier formulas).
        template.skills = {
            # Strength
            "运动": "({STR}-10)/2",
            # Dexterity
            "体操": "({DEX}-10)/2",
            "巧手": "({DEX}-10)/2",
            "隐匿": "({DEX}-10)/2",
            # Intelligence
            "调查": "({INT}-10)/2",
            "奥秘": "({INT}-10)/2",
            "历史": "({INT}-10)/2",
            "自然": "({INT}-10)/2",
            "宗教": "({INT}-10)/2",
            # Wisdom
            "察觉": "({WIS}-10)/2",
            "洞悉": "({WIS}-10)/2",
            "驯兽": "({WIS}-10)/2",
            "医药": "({WIS}-10)/2",
            "生存": "({WIS}-10)/2",
            # Charisma
            "游说": "({CHA}-10)/2",
            "欺瞒": "({CHA}-10)/2",
            "威吓": "({CHA}-10)/2",
            "表演": "({CHA}-10)/2",
        }

        # Skill aliases (Chinese + English).
        template.synonyms = {
            # Base abilities
            "STR": ["力量", "STR", "Strength"],
            "DEX": ["敏捷", "DEX", "Dexterity"],
            "CON": ["体质", "CON", "Constitution"],
            "INT": ["智力", "INT", "Intelligence"],
            "WIS": ["感知", "WIS", "Wisdom"],
            "CHA": ["魅力", "CHA", "Charisma"],
            # Base derived stats
            "先攻修正": ["先攻", "Initiative"],
            "速度": ["速度", "Speed"],
            "载重": ["载重", "Carrying_Capacity"],
            "负重": ["负重", "Encumbrance"],
            "护甲等级": ["AC", "Armor_Class", "护甲等级"],
            # Skills
            "运动": ["运动", "Athletics"],
            "体操": ["体操", "Acrobatics"],
            "巧手": ["Sleight_of_Hand", "巧手", "手上功夫"],
            "隐匿": ["Stealth", "隐匿"],
            "奥秘": ["Arcana", "奥秘"],
            "历史": ["History", "历史"],
            "调查": ["Investigation", "调查"],
            "自然": ["Nature", "自然"],
            "宗教": ["Religion", "宗教"],
            "驯兽": ["Animal_Handling", "动物驯养", "驯兽"],
            "洞悉": ["Insight", "洞悉"],
            "医药": ["Medicine", "医药"],
            "察觉": ["Perception", "察觉", "观察"],
            "生存": ["Survival", "生存", "求生"],
            "欺瞒": ["Deception", "欺瞒"],
            "威吓": ["Intimidation", "威吓"],
            "表演": ["Performance", "表演"],
            "游说": ["Persuasion", "游说"],
            # Currency
            "金币": ["Gold_Piece", "金币", "GP"],
            "银币": ["Silver_Piece", "银币", "SP"],
            "铜币": ["Copper_Piece", "CP", "铜币"],
            "铂金币": ["Electrum_Piece", "铂金币", "EP"],
            "白金币": ["Platinum_Piece", "白金币", "PP"],
        }

        template.check_rules = {
            "critical_success": [20],
            "critical_failure": [1],
            "success_levels": {
                "大成功": 20,
                "成功": "target_met",
                "失败": "target_missed",
                "大失败": 1,
            },
        }

        return template

    @classmethod
    def _load_from_json(cls, json_path: Path) -> CharacterTemplate:
        with json_path.open(encoding="utf-8") as f:
            data = json.load(f)

        template = cls(data["name"], data["system"])
        template.main_dice = data.get("main_dice", "1d100")
        template.attributes = data.get("attributes", {})
        template.skills = data.get("skills", {})
        template.mapping = data.get("derived_attributes", data.get("mapping", {}))
        template.synonyms = data.get("skill_aliases", data.get("synonyms", {}))
        template.check_rules = data.get("check_rules", {})
        template.init_rules = data.get("init_rules", {})

        return template


class CharacterManager:
    """Character sheet manager: CRUD over `store`, template-based generation,
    skill/attribute alias resolution and DND5e modifier math."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.templates = {
            "coc7": CharacterTemplate.get_coc7_template(),
            "dnd5e": CharacterTemplate.get_dnd5e_template(),
        }

    async def get_character(self, user_id: str, chat_key: str, char_name: str = "") -> CharacterSheet:
        """Fetch a user's character sheet.

        `char_name` defaults to the caller's active character for this
        `chat_key` (falling back to the fixed slot `"default"` if none is
        set); a not-found lookup returns a fresh `CharacterSheet` named
        `char_name` rather than raising.
        """
        if not char_name:
            active_key = f"active_character.{chat_key}"
            try:
                active_name = await self.store.get(user_key=user_id, store_key=active_key)
                char_name = active_name if active_name else "default"
            except Exception:
                char_name = "default"

        store_key = f"characters.{chat_key}.{char_name}"

        try:
            char_data = await self.store.get(user_key=user_id, store_key=store_key)
            if char_data:
                data_dict = json.loads(char_data)
                return CharacterSheet.from_dict(data_dict)
        except Exception:
            pass

        return CharacterSheet(name=char_name)

    async def save_character(self, user_id: str, chat_key: str, character: CharacterSheet) -> None:
        """Persist `character`, and make it the active character / add it to the
        user's character list / sync it into the party roster."""
        character.last_updated = time.time()
        store_key = f"characters.{chat_key}.{character.name}"

        await self.store.set(
            user_key=user_id,
            store_key=store_key,
            value=json.dumps(character.to_dict(), ensure_ascii=False),
        )

        await self.set_active_character(user_id, chat_key, character.name)
        await self._update_char_list(user_id, chat_key, character.name, add=True)
        await self.sync_party_roster(chat_key, character)

    async def sync_party_roster(
        self, chat_key: str, character: CharacterSheet, status_effects: list | None = None
    ) -> None:
        """Sync `character`'s status into the shared party roster (`party_roster.{chat_key}`)
        for the battle-status panel.

        When `status_effects` is omitted (`None`), the character's previously
        recorded `status_effects` in the roster are preserved rather than
        cleared.
        """
        roster_key = f"party_roster.{chat_key}"
        try:
            roster_data = await self.store.get(user_key="", store_key=roster_key)
            roster = json.loads(roster_data) if roster_data else {}
        except Exception:
            roster = {}

        previous_status_effects = []
        if status_effects is None:
            previous = roster.get(character.name, {})
            previous_status_effects = previous.get("status_effects", []) if isinstance(previous, dict) else []
        effective_status_effects = status_effects if status_effects is not None else previous_status_effects

        attrs = character.attributes
        if character.system == "CoC":
            status_summary = {
                "name": character.name,
                "system": character.system,
                "HP": f"{attrs.get('HP', '?')}/{attrs.get('HPMAX', '?')}",
                "SAN": f"{attrs.get('SAN', '?')}/{attrs.get('SANMAX', '?')}",
                "MP": f"{attrs.get('MP', '?')}/{attrs.get('MPMAX', '?')}",
                "occupation": character.occupation,
                "status_effects": effective_status_effects,
                "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
            }
        else:
            sec = getattr(character, "secondary_attributes", {})
            status_summary = {
                "name": character.name,
                "system": character.system,
                "HP": f"{attrs.get('HP', '?')}",
                "AC": sec.get("护甲等级", "?"),
                "status_effects": effective_status_effects,
                "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
            }

        roster[character.name] = status_summary
        try:
            await self.store.set(user_key="", store_key=roster_key, value=json.dumps(roster, ensure_ascii=False))
        except Exception:
            pass

    async def get_party_roster(self, chat_key: str) -> list[dict[str, Any]]:
        roster_key = f"party_roster.{chat_key}"
        try:
            roster_data = await self.store.get(user_key="", store_key=roster_key)
            if roster_data:
                roster = json.loads(roster_data)
                return list(roster.values())
        except Exception:
            pass
        return []

    async def set_active_character(self, user_id: str, chat_key: str, char_name: str) -> None:
        active_key = f"active_character.{chat_key}"
        await self.store.set(user_key=user_id, store_key=active_key, value=char_name)

    def _get_char_list_key(self, chat_key: str) -> str:
        return f"characters_list.{chat_key}"

    async def _update_char_list(self, user_id: str, chat_key: str, char_name: str, add: bool = True) -> None:
        list_key = self._get_char_list_key(chat_key)
        try:
            list_data = await self.store.get(user_key=user_id, store_key=list_key)
            char_list = json.loads(list_data) if list_data else []
        except Exception:
            char_list = []

        if add and char_name not in char_list:
            char_list.append(char_name)
        elif not add and char_name in char_list:
            char_list.remove(char_name)

        try:
            await self.store.set(user_key=user_id, store_key=list_key, value=json.dumps(char_list))
        except Exception:
            pass

    async def list_characters(self, user_id: str, chat_key: str) -> list[dict[str, Any]]:
        list_key = self._get_char_list_key(chat_key)
        characters = []
        try:
            list_data = await self.store.get(user_key=user_id, store_key=list_key)
            char_list = json.loads(list_data) if list_data else []
            for char_name in char_list:
                store_key = f"characters.{chat_key}.{char_name}"
                try:
                    char_data = await self.store.get(user_key=user_id, store_key=store_key)
                    if char_data:
                        data = json.loads(char_data)
                        characters.append(
                            {
                                "name": data.get("name", char_name),
                                "system": data.get("system", "CoC"),
                                "last_updated": data.get("last_updated", 0),
                            }
                        )
                except Exception:
                    pass
        except Exception:
            pass
        return characters

    async def delete_character(self, user_id: str, chat_key: str, char_name: str) -> bool:
        store_key = f"characters.{chat_key}.{char_name}"
        try:
            await self.store.delete(user_key=user_id, store_key=store_key)
            await self._update_char_list(user_id, chat_key, char_name, add=False)
            return True
        except Exception:
            return False

    async def get_daily_luck(self, user_id: str) -> int:
        """Deterministic per-user, per-day "luck" value in `[1, 100]`, cached in the store."""
        today = datetime.now().strftime("%Y-%m-%d")
        store_key = f"daily_luck.{today}"

        try:
            luck_data = await self.store.get(user_key=user_id, store_key=store_key)
            if luck_data:
                return int(luck_data)
        except (ValueError, TypeError):
            pass

        hash_input = f"{user_id}_{today}"
        hash_value = int(hashlib.md5(hash_input.encode()).hexdigest()[:8], 16)  # noqa: S324
        luck_value = (hash_value % 100) + 1  # 1-100

        await self.store.set(user_key=user_id, store_key=store_key, value=str(luck_value))
        return luck_value

    def generate_character(self, template_name: str, char_name: str | None = None) -> CharacterSheet:
        """Generate a new character sheet from a template (`"coc7"` / `"dnd5e"`).

        `char_name` defaults to the localized `character.default_name` i18n
        key when not given, per the "CharacterSheet's own constructor default
        is not localized; callers resolve the display default" convention.
        """
        if template_name not in self.templates:
            raise ValueError(t("character.unknown_template", template_name=template_name))

        template = self.templates[template_name]
        character = CharacterSheet(name=char_name or t("character.default_name"), system=template.system)
        template.apply_to_character(character)

        return character

    def find_skill_by_alias(self, character: CharacterSheet, skill_name: str) -> str | None:
        """Resolve `skill_name` to a standard skill name via the character's template."""
        template_name = "coc7" if character.system == "CoC" else "dnd5e"
        if template_name in self.templates:
            template = self.templates[template_name]
            return template.find_skill_alias(skill_name)
        return None

    def get_skill_value(self, character: CharacterSheet, skill_name: str) -> int:
        """Skill value, resolving `skill_name` through its alias if needed."""
        standard_name = self.find_skill_by_alias(character, skill_name)
        target = standard_name if standard_name else skill_name
        return character.skills.get(target, 0)

    def get_attribute_value(self, character: CharacterSheet, attr_name: str) -> int:
        """Attribute value, resolving `attr_name` through the template alias table if
        it is not already an attribute key."""
        if attr_name in character.attributes:
            return character.attributes[attr_name]

        template_name = "coc7" if character.system == "CoC" else "dnd5e"
        if template_name in self.templates:
            template = self.templates[template_name]
            standard = template.find_skill_alias(attr_name)
            if standard and standard in character.attributes:
                return character.attributes[standard]

        return 0

    # ============ DND5E rules support ============

    DND5E_SKILL_ABILITIES = {
        "运动": "STR",
        "体操": "DEX", "巧手": "DEX", "隐匿": "DEX",
        "奥秘": "INT", "历史": "INT", "调查": "INT", "自然": "INT", "宗教": "INT",
        "驯兽": "WIS", "洞悉": "WIS", "医药": "WIS", "察觉": "WIS", "生存": "WIS",
        "欺瞒": "CHA", "威吓": "CHA", "表演": "CHA", "游说": "CHA",
    }

    DND5E_ABILITY_NAMES = {
        "STR": "力量", "DEX": "敏捷", "CON": "体质",
        "INT": "智力", "WIS": "感知", "CHA": "魅力",
    }

    def get_dnd_proficiency_bonus(self, level: int) -> int:
        """DND5e proficiency bonus for `level`."""
        return (level - 1) // 4 + 2

    def get_dnd_skill_modifier(self, character: CharacterSheet, skill_name: str, proficient: bool = False) -> int:
        """DND5e skill check modifier (ability modifier + proficiency bonus if proficient).

        `skill_name` may be a skill name, a skill alias, or a Chinese/English
        ability name; unresolvable input defaults to STR.
        """
        standard_skill = self.find_skill_by_alias(character, skill_name)
        if not standard_skill:
            standard_skill = skill_name

        ability = self.DND5E_SKILL_ABILITIES.get(standard_skill, "")
        if not ability:
            if standard_skill in ["力量", "敏捷", "体质", "智力", "感知", "魅力"]:
                ability = standard_skill
            elif standard_skill in self.DND5E_ABILITY_NAMES:
                ability = standard_skill
            else:
                ability = "STR"  # default

        ability_map = {"力量": "STR", "敏捷": "DEX", "体质": "CON", "智力": "INT", "感知": "WIS", "魅力": "CHA"}
        ability_key = ability_map.get(ability, ability)

        attr_value = character.attributes.get(ability_key, 10)
        attr_mod = (attr_value - 10) // 2

        prof_bonus = 0
        if proficient:
            level = getattr(character, "level", 1)
            prof_bonus = self.get_dnd_proficiency_bonus(level)

        return attr_mod + prof_bonus

    def get_dnd_ability_modifier(self, character: CharacterSheet, ability: str) -> int:
        """DND5e single-ability modifier."""
        ability_map = {"力量": "STR", "敏捷": "DEX", "体质": "CON", "智力": "INT", "感知": "WIS", "魅力": "CHA"}
        ability_key = ability_map.get(ability, ability)
        attr_value = character.attributes.get(ability_key, 10)
        return (attr_value - 10) // 2

    def get_dnd_saving_throw_modifier(self, character: CharacterSheet, ability: str, proficient: bool = False) -> int:
        """DND5e saving throw modifier (ability modifier + proficiency bonus if proficient)."""
        ability_map = {"力量": "STR", "敏捷": "DEX", "体质": "CON", "智力": "INT", "感知": "WIS", "魅力": "CHA"}
        ability_key = ability_map.get(ability, ability)

        attr_value = character.attributes.get(ability_key, 10)
        attr_mod = (attr_value - 10) // 2

        prof_bonus = 0
        if proficient:
            level = getattr(character, "level", 1)
            prof_bonus = self.get_dnd_proficiency_bonus(level)

        return attr_mod + prof_bonus
