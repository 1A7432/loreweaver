"""Tests for the worldbook's conditional-injection + template-compat pass: the `condition`
field (fail-closed gating via core.condexpr), EJS-subset content rendering at injection, and
the SillyTavern import mappings (@@if → condition, [InitVar]/@@initial_variables consumed into
the MVU tree, render-time-only entries disabled, [GENERATE:*] title prefixes stripped)."""

from __future__ import annotations

from core.mvu_compat import MvuManager
from core.worldbook import LoreEntry, WorldbookManager, render_entry_content
from infra.store import Store


def _entry(**overrides) -> LoreEntry:
    base = dict(id="", title="t", content="body", constant=True)
    base.update(overrides)
    return LoreEntry.from_dict(base)


def _resolver(values: dict):
    return lambda path: values.get(path)


# ---------------------------------------------------------------------------
# condition round-trip + match gating
# ---------------------------------------------------------------------------


def test_condition_survives_the_dict_round_trip():
    entry = _entry(condition="fear >= 5")
    assert LoreEntry.from_dict(entry.to_dict()).condition == "fear >= 5"


async def test_match_fires_condition_only_when_true():
    manager = WorldbookManager(Store())
    await manager.add("room1", _entry(title="panic", condition="fear >= 5"))
    await manager.add("room1", _entry(title="always"))

    low = await manager.match("room1", "", role="keeper", resolve=_resolver({"fear": 1}))
    high = await manager.match("room1", "", role="keeper", resolve=_resolver({"fear": 7}))

    assert [entry.title for entry in low] == ["always"]
    assert sorted(entry.title for entry in high) == ["always", "panic"]


async def test_match_conditions_fail_closed():
    manager = WorldbookManager(Store())
    await manager.add("room1", _entry(title="conditioned", condition="fear >= 5"))
    await manager.add("room1", _entry(title="broken", condition="1 ~ 2"))

    no_resolver = await manager.match("room1", "", role="keeper")
    with_resolver = await manager.match("room1", "", role="keeper", resolve=_resolver({"fear": 9}))

    assert [entry.title for entry in no_resolver] == []
    assert [entry.title for entry in with_resolver] == ["conditioned"]  # broken stays closed


async def test_match_ignore_conditions_shows_everything():
    manager = WorldbookManager(Store())
    await manager.add("room1", _entry(title="conditioned", condition="fear >= 5"))

    entries = await manager.match("room1", "", role="keeper", ignore_conditions=True)

    assert [entry.title for entry in entries] == ["conditioned"]


# ---------------------------------------------------------------------------
# injection-time content rendering
# ---------------------------------------------------------------------------


def test_render_entry_content_renders_ejs_and_macros():
    entry = _entry(content="<% if (fear >= 5) { %>Windows are boarded. <% } %>Fear: {{var:fear}}")
    resolve = _resolver({"fear": 7})
    assert render_entry_content(entry, resolve) == "Windows are boarded. Fear: 7"
    assert render_entry_content(_entry(content=entry.content)) == entry.content  # no resolver → verbatim


def test_render_entry_content_never_leaks_template_syntax():
    entry = _entry(content="<% bogus!!! %>plain<%= 1 ~ 2 %>")
    assert render_entry_content(entry, _resolver({})) == "plain"


# ---------------------------------------------------------------------------
# SillyTavern import mappings
# ---------------------------------------------------------------------------


async def test_import_maps_at_if_to_condition_and_strips_decorator_lines():
    manager = WorldbookManager(Store())
    count = await manager.import_entries(
        "room1",
        [{"comment": "stage two lore", "content": "@@if variables.stage === 2\nThe cult mobilizes.", "keys": ["cult"]}],
    )
    assert count == 1
    [entry] = await manager.list("room1")
    assert entry.condition == "variables.stage === 2"
    assert entry.content == "The cult mobilizes."


async def test_keeper_import_consumes_initvar_into_the_mvu_tree_not_as_lore():
    store = Store()
    manager = WorldbookManager(store)
    initvar_content = '{\n  // starting state\n  "理": {"好感度": [33, "desc"],},\n}'
    count = await manager.import_entries(
        "room1",
        [
            {"comment": "[InitVar]变量初始化", "content": initvar_content},
            {"comment": "real lore", "content": "The chapel is locked.", "keys": ["chapel"]},
        ],
        is_keeper=True,
    )
    assert count == 1  # only the real lore entry stored
    assert [entry.title for entry in await manager.list("room1")] == ["real lore"]
    tree = await MvuManager(store).load("room1")
    assert tree["理"]["好感度"][0] == 33


async def test_player_import_drops_initvar_without_seeding_the_shared_tree():
    """RED LINE (拆卡): only the keeper's world import may write the room's variable tree.
    A player upload's declaration entries are neither stored as lore nor consumed."""
    store = Store()
    manager = WorldbookManager(store)
    count = await manager.import_entries(
        "room1",
        [
            {"comment": "[InitVar]", "content": '{"真凶": ["管家", "twist"]}'},
            {"comment": "real lore", "content": "The chapel is locked.", "keys": ["chapel"]},
        ],
        is_keeper=False,
    )
    assert count == 1
    assert [entry.title for entry in await manager.list("room1")] == ["real lore"]
    assert await MvuManager(store).load("room1") == {}


async def test_import_initvar_bypasses_the_content_length_cap():
    store = Store()
    manager = WorldbookManager(store)
    # 150 keys stays inside normalize_tree's defensive node budget while the raw text still
    # far exceeds the 4000-char lore cap — the point is the cap bypass, not the budget.
    big = "{" + ",".join(f'"k{i}": [{i}, "some longer description text"]' for i in range(150)) + "}"
    assert len(big) > 4000
    count = await manager.import_entries("room1", [{"comment": "[InitVar]", "content": big}], is_keeper=True)
    assert count == 0
    assert (await MvuManager(store).load("room1"))["k149"][0] == 149


async def test_import_disables_render_time_only_entries():
    manager = WorldbookManager(Store())
    await manager.import_entries(
        "room1",
        [
            {"comment": "[RENDER:AFTER]status bar", "content": "<div>hp bar</div>", "keys": ["x"]},
            {"comment": "footer", "content": "@@render_after\n<div>ui</div>", "keys": ["y"]},
            {"comment": "hidden", "content": "@@dont_activate\ndraft", "keys": ["z"]},
        ],
    )
    entries = await manager.list("room1")
    assert len(entries) == 3
    assert all(entry.enabled is False for entry in entries)


async def test_import_strips_generate_title_prefix_but_keeps_the_entry():
    manager = WorldbookManager(Store())
    await manager.import_entries(
        "room1", [{"comment": "[GENERATE:BEFORE] opening scene", "content": "It rains.", "keys": ["rain"]}]
    )
    [entry] = await manager.list("room1")
    assert entry.enabled is True
    assert entry.title == "opening scene"
