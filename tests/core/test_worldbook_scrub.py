"""ST frontend-template scrubbing (2026-08-05 rerun finding §5-6): status-bar template
residue ({{format_message_variable::…}} macros and the <status_*> wrappers around them)
never reaches a prompt, and an entry that is nothing but residue imports disabled."""

from __future__ import annotations

import random

from core.worldbook import (
    LoreEntry,
    Worldbook,
    render_entry_content,
    scrub_frontend_templates,
)
from infra.store import Store


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
    manager = Worldbook(Store(":memory:"))
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


async def test_residue_wrapped_in_separators_still_imports_disabled():
    manager = Worldbook(Store(":memory:"))
    payload = {
        "entries": [
            {
                "title": "变量列表",
                "content": "---\n<status_current_variables>\n{{format_message_variable::stat_data}}\n</status_current_variables>",
                "keys": [],
                "constant": True,
            },
            {"title": "纯分隔线条目", "content": "---", "keys": [], "constant": True},
        ]
    }
    await manager.import_entries("room", payload, source="card", is_keeper=True)
    by_title = {entry.title: entry for entry in await manager.list("room")}
    assert by_title["变量列表"].enabled is False  # separator残渣 counts as residue
    assert by_title["纯分隔线条目"].enabled is True  # an author's own divider is NOT residue
