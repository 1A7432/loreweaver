"""Sole-active constant families + frontend-template scrubbing (2026-08-05 rerun findings
§5-1 and §5-6): mutually-exclusive `前缀·变体` constant entries follow the room's variable
values instead of raw priority, and ST status-bar template residue never reaches a prompt."""

from __future__ import annotations

import random

from core.worldbook import (
    LoreEntry,
    WorldbookManager,
    render_entry_content,
    scrub_frontend_templates,
)
from infra.store import Store


def _entry(title: str, *, content: str = "", constant: bool = True, priority: int = 0) -> LoreEntry:
    return LoreEntry(id="", title=title, content=content or f"{title} 的规则文本。", constant=constant, priority=priority)


async def _seed_routes(manager: WorldbookManager, chat_key: str) -> None:
    await manager.add(chat_key, _entry("路线·主线", priority=71))
    await manager.add(chat_key, _entry("路线·判官线", priority=75))
    await manager.add(chat_key, _entry("路线·大侦探线", priority=75))
    await manager.add(chat_key, _entry("难度·标准", priority=70))
    await manager.add(chat_key, _entry("难度·残酷", priority=75))


async def test_active_variants_pick_the_route_the_tree_names():
    manager = WorldbookManager(Store(":memory:"))
    await _seed_routes(manager, "room")

    chosen = await manager.match(
        "room", "", role="keeper", rng=random.Random(1), active_variants={"主线", "标准"}
    )
    titles = {entry.title for entry in chosen}
    # Higher-priority non-matching family members are gone; the named variants stay.
    assert "路线·主线" in titles and "难度·标准" in titles
    assert titles.isdisjoint({"路线·判官线", "路线·大侦探线", "难度·残酷"})


async def test_family_with_no_matching_value_keeps_priority_behavior():
    manager = WorldbookManager(Store(":memory:"))
    await _seed_routes(manager, "room")

    chosen = await manager.match(
        "room", "", role="keeper", rng=random.Random(1), active_variants={"无关的值"}
    )
    titles = {entry.title for entry in chosen}
    assert {"路线·主线", "路线·判官线", "路线·大侦探线"} <= titles  # fail-open


async def test_single_member_family_and_non_constants_are_untouched():
    manager = WorldbookManager(Store(":memory:"))
    await manager.add(manager_key := "room", _entry("据点·大别墅"))
    await manager.add(manager_key, _entry("路线·主线", constant=False, content="非常驻", priority=1))

    chosen = await manager.match(
        manager_key, "", role="keeper", rng=random.Random(1), active_variants={"主线"}
    )
    assert {entry.title for entry in chosen} == {"据点·大别墅"}  # lone family member survives


def test_scrub_frontend_templates_removes_macros_and_empty_wrappers():
    residue = "<status_current_variables>{{format_message_variable::stat_data}}</status_current_variables>"
    assert scrub_frontend_templates(residue) == ""
    mixed = "开场规则照旧。\n" + residue + "\n结尾提示。"
    assert scrub_frontend_templates(mixed) == "开场规则照旧。\n\n结尾提示。"
    untouched = "普通设定文本 {{user}} 保持原样。"
    assert scrub_frontend_templates(untouched) == untouched


def test_render_entry_content_scrubs_residue_with_and_without_resolver():
    entry = LoreEntry(
        id="x",
        title="变量列表",
        content="<status_current_variables>{{format_message_variable::stat_data}}</status_current_variables>",
    )
    assert render_entry_content(entry, resolve=None) == ""
    assert render_entry_content(entry, resolve=lambda name: None) == ""


async def test_pure_template_entry_imports_disabled_and_never_injects():
    manager = WorldbookManager(Store(":memory:"))
    payload = {
        "entries": [
            {
                "title": "变量列表",
                "content": "<status_current_variables>{{format_message_variable::stat_data}}</status_current_variables>",
                "keys": [],
                "constant": True,
            },
            {"title": "正经规则", "content": "验人先看手腕。", "keys": [], "constant": True},
        ]
    }
    await manager.import_entries("room", payload, source="card", is_keeper=True)
    by_title = {entry.title: entry for entry in await manager.list("room")}
    assert by_title["变量列表"].enabled is False  # kept, not vanished — but never in a slot
    assert by_title["正经规则"].enabled is True

    chosen = await manager.match("room", "", role="keeper", rng=random.Random(1))
    assert {entry.title for entry in chosen} == {"正经规则"}
