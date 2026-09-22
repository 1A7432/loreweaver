"""A SYNTHETIC lorebook shaped like the ugly real cards the M26 overlay exists for.

Not a copy of anything: every title and every line here is invented. What is copied is the
SHAPE the 2026-08-05 lesson says fixtures must mirror, because tidy three-entry books hide
every bug this layer can have:

- a family of mutually exclusive variants that ship `enabled: false`, `keys: []`,
  `constant: true`, `position: before_char` — in SillyTavern a frontend script toggles
  them, and here nothing does until an admin or a pack says so;
- CJK titles with the `·` separator (which the engine must NEVER read for structure —
  `docs/notes/rejected/sole-active-card-mechanism.md`);
- disabled entries that DO have keywords, which are reachable and must not be counted as
  unreachable;
- a variable-declaration entry, consumed as data before any of this;
- one block above `MAX_IMPORT_CONTENT_CHARS`, skipped whole;
- one enabled constant that alone eats most of a keeper turn's character budget.
"""

from __future__ import annotations

from typing import Any

# Titles the fixture guarantees, so tests assert against names rather than positions.
DIFFICULTY_TITLES = ("难度·轻松", "难度·标准", "难度·残酷")
ROUTE_TITLES = ("路线·主线", "路线·判官线")
KEYED_DISABLED_TITLES = ("回复模板", "残堇内部介绍")
ALWAYS_ON_TITLE = "通用规则"
HEAVY_TITLE = "插图回收舱解锁规则"
OVERSIZED_TITLE = "[mvu_update]变量输出格式"
INITVAR_TITLE = "[InitVar]开局变量"

# The count the import receipt must report: disabled AND keyless, after the declaration
# entry is consumed and the oversized block is skipped.
UNREACHABLE_COUNT = len(DIFFICULTY_TITLES) + len(ROUTE_TITLES)


def _variant(title: str, body: str, *, size: int = 400, order: int = 0) -> dict[str, Any]:
    """One config variant: off, keyless, always-on if it ever fired, ranked first.

    `order` is ST's `insertion_order` — the knob a real card uses to decide which family
    member reaches the prompt first when several are switched on at once, and therefore
    which one the character budget runs out on."""
    return {
        "comment": title,
        "content": (body + "。").ljust(size, "·"),
        "keys": [],
        "enabled": False,
        "constant": True,
        "position": "before_char",
        "insertion_order": order,
    }


def card_book(*, heavy_chars: int = 5_000, route_chars: int = 1_500) -> dict[str, Any]:
    """The whole synthetic `character_book`, in the raw shape an import path receives."""
    entries: list[dict[str, Any]] = [
        {
            # The marker lives in the NAME, and only there. `_consume_initvar` strips
            # leading `@@decorators` from the content and then parses what is left as
            # JSON5/YAML — a repeated `[InitVar]` line inside the content is not a
            # decorator, so it makes the whole block unparseable and the tree silently
            # stays empty. Every real card (and every other fixture here) puts it in the
            # entry name; a fixture that did otherwise quietly tested nothing.
            "comment": INITVAR_TITLE,
            "content": "{\n  \"配置\": {\n    \"难度\": \"标准\",\n    \"路线\": \"主线\"\n  }\n}",
            "keys": [],
            "enabled": True,
        },
        _variant("难度·轻松", "线索自己走到面前"),
        _variant("难度·标准", "线索要找，但找得到"),
        _variant("难度·残酷", "线索会骗人", size=900),
        _variant("路线·主线", "跟着委托人走", order=10),
        _variant("路线·判官线", "跟着那个提灯的人走", size=route_chars, order=10),
        {
            "comment": "回复模板",
            "content": "先写环境，再写人。",
            "keys": ["模板"],
            "enabled": False,
            "constant": False,
        },
        {
            "comment": "残堇内部介绍",
            "content": "残堇的堂口在城北的旧钟楼。",
            "keys": ["残堇"],
            "enabled": False,
            "constant": False,
        },
        {
            "comment": ALWAYS_ON_TITLE,
            "content": "这是一场调查，不是一场战斗。",
            "keys": [],
            "enabled": True,
            "constant": True,
        },
        {
            "comment": HEAVY_TITLE,
            "content": "回收舱的门在第三夜之后才会开。".ljust(heavy_chars, "·"),
            "keys": [],
            "enabled": True,
            "constant": True,
        },
        {
            # Above MAX_IMPORT_CONTENT_CHARS (16000): skipped whole, reported by title.
            "comment": OVERSIZED_TITLE,
            "content": "变量输出格式说明。".ljust(18_000, "·"),
            "keys": [],
            "enabled": True,
            "constant": True,
        },
    ]
    return {"entries": entries}


OVERLAY_FILE = """
format: loreweaver.lore-overlay/1
entries:
  难度·轻松: {condition: '配置.难度 == "轻松"'}
  难度·标准: {condition: '配置.难度 == "标准"'}
  难度·残酷: {condition: '配置.难度 == "残酷"'}
  路线·判官线: {condition: '配置.路线 == "判官线"'}
  残堇内部介绍: {condition: '配置.路线 == "残堇线"'}
  回复模板: {enabled: false}
setup:
  - {path: 配置.难度, options: [轻松, 标准, 残酷], labels: {en: Difficulty, zh: 难度}}
  - {path: 配置.路线, options: [主线, 判官线], labels: {en: Route, zh: 路线}}
expose: [配置]
"""
