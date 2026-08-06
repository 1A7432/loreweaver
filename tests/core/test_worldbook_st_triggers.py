"""Tests for the worldbook's SillyTavern trigger semantics: secondary-key logic, keyword
options (case/whole-words/scan-depth), probability, timed effects (sticky/cooldown/delay),
inclusion groups, position ordering, ST field-name import mapping, and import-time {{char}}
binding."""

from __future__ import annotations

import random

from core.worldbook import LoreEntry, Worldbook, _keyword_hit
from infra.store import Store


def _entry(**overrides) -> LoreEntry:
    base = dict(id="", title="t", content="body", keys=["ritual"])
    base.update(overrides)
    return LoreEntry.from_dict(base)


async def _manager_with(entries) -> Worldbook:
    manager = Worldbook(Store())
    for entry in entries:
        await manager.add("room1", entry)
    return manager


# ---------------------------------------------------------------------------
# _keyword_hit: secondary logic + matching options
# ---------------------------------------------------------------------------


def test_secondary_key_logics():
    def hit(logic, context):
        return _keyword_hit(
            _entry(secondary_keys=["chapel", "crypt"], selective_logic=logic), context
        )

    assert hit("and_any", "a ritual in the chapel") is True
    assert hit("and_any", "a ritual in the woods") is False
    assert hit("and_all", "ritual at the chapel crypt") is True
    assert hit("and_all", "ritual at the chapel") is False
    assert hit("not_any", "a ritual in the woods") is True
    assert hit("not_any", "a ritual in the chapel") is False
    assert hit("not_all", "ritual at the chapel") is True
    assert hit("not_all", "ritual at the chapel crypt") is False


def test_case_sensitive_and_whole_word_matching():
    assert _keyword_hit(_entry(keys=["Ritual"], case_sensitive=True), "the ritual begins") is False
    assert _keyword_hit(_entry(keys=["Ritual"], case_sensitive=True), "the Ritual begins") is True
    assert _keyword_hit(_entry(keys=["rit"], match_whole_words=True), "the ritual begins") is False
    assert _keyword_hit(_entry(keys=["rit"]), "the ritual begins") is True
    # CJK keys are unaffected by whole-word mode (no word boundaries to speak of)
    assert _keyword_hit(_entry(keys=["仪式"], match_whole_words=True), "黑弥撒仪式开始了") is True


def test_scan_depth_limits_the_window_to_recent_lines():
    context = "the ritual was mentioned long ago\nline2\nline3\nline4"
    assert _keyword_hit(_entry(scan_depth=2), context) is False
    assert _keyword_hit(_entry(scan_depth=0), context) is True


# ---------------------------------------------------------------------------
# probability + inclusion groups (seeded rng — real code randomness)
# ---------------------------------------------------------------------------


async def test_probability_gates_injection_with_the_supplied_rng():
    manager = await _manager_with([_entry(title="rare", constant=True, keys=[], probability=50)])
    hits = 0
    for seed in range(20):
        entries = await manager.match("room1", "", role="keeper", rng=random.Random(seed))
        hits += 1 if entries else 0
    assert 0 < hits < 20  # gated, not always-on and not never


async def test_inclusion_group_injects_exactly_one_member():
    manager = await _manager_with(
        [
            _entry(title="rumor-a", constant=True, keys=[], group="rumors"),
            _entry(title="rumor-b", constant=True, keys=[], group="rumors"),
            _entry(title="solo", constant=True, keys=[]),
        ]
    )
    picked = set()
    for seed in range(10):
        entries = await manager.match("room1", "", role="keeper", rng=random.Random(seed))
        titles = [entry.title for entry in entries]
        assert titles.count("solo") == 1
        group_members = [title for title in titles if title.startswith("rumor-")]
        assert len(group_members) == 1
        picked.add(group_members[0])
    assert picked == {"rumor-a", "rumor-b"}  # both reachable across seeds


async def test_position_buckets_order_the_section():
    manager = await _manager_with(
        [
            _entry(title="tail", constant=True, keys=[], position="after", priority=99),
            _entry(title="head", constant=True, keys=[], position="before", priority=0),
            _entry(title="mid", constant=True, keys=[]),
        ]
    )
    entries = await manager.match("room1", "", role="keeper")
    assert [entry.title for entry in entries] == ["head", "mid", "tail"]


# ---------------------------------------------------------------------------
# timed effects: the turn counter only advances on the injection path
# ---------------------------------------------------------------------------


async def test_delay_holds_an_entry_until_the_turn_counter_reaches_it():
    manager = await _manager_with([_entry(title="late", constant=True, keys=[], delay=3)])
    assert await manager.match("room1", "", role="keeper", advance_timers=True) == []  # turn 1
    assert await manager.match("room1", "", role="keeper", advance_timers=True) == []  # turn 2
    entries = await manager.match("room1", "", role="keeper", advance_timers=True)  # turn 3
    assert [entry.title for entry in entries] == ["late"]


async def test_sticky_keeps_an_entry_active_without_its_keys():
    manager = await _manager_with([_entry(title="omen", keys=["ritual"], sticky=2)])
    fired = await manager.match("room1", "the ritual begins", role="keeper", advance_timers=True)
    assert [entry.title for entry in fired] == ["omen"]
    # keys absent for the next two turns — sticky carries it
    for _ in range(2):
        entries = await manager.match("room1", "quiet day", role="keeper", advance_timers=True)
        assert [entry.title for entry in entries] == ["omen"]
    assert await manager.match("room1", "quiet day", role="keeper", advance_timers=True) == []


async def test_cooldown_blocks_refiring_and_starts_after_sticky():
    manager = await _manager_with([_entry(title="once", keys=["ritual"], cooldown=2)])
    assert len(await manager.match("room1", "ritual!", role="keeper", advance_timers=True)) == 1
    assert await manager.match("room1", "ritual!", role="keeper", advance_timers=True) == []
    assert await manager.match("room1", "ritual!", role="keeper", advance_timers=True) == []
    assert len(await manager.match("room1", "ritual!", role="keeper", advance_timers=True)) == 1


async def test_browse_paths_do_not_advance_timers():
    manager = await _manager_with([_entry(title="late", constant=True, keys=[], delay=2)])
    for _ in range(5):  # search/browse calls must not tick the room's clock
        await manager.match("room1", "", role="keeper", ignore_conditions=True)
    assert await manager.match("room1", "", role="keeper", advance_timers=True) == []  # still turn 1


# ---------------------------------------------------------------------------
# import mapping + {{char}} binding
# ---------------------------------------------------------------------------


async def test_import_maps_st_native_field_names():
    manager = Worldbook(Store())
    await manager.import_entries(
        "room1",
        [
            {
                "comment": "st-entry",
                "content": "lore",
                "key": ["ritual"],
                "keysecondary": ["chapel"],
                "selective": True,
                "selectiveLogic": 3,
                "probability": 75,
                "useProbability": True,
                "caseSensitive": True,
                "matchWholeWords": True,
                "scanDepth": 4,
                "position": "before_char",
                "sticky": 2,
                "cooldown": 3,
                "delay": 5,
                "group": "rumors",
                "groupWeight": 60,
            }
        ],
    )
    [entry] = await manager.list("room1")
    assert entry.secondary_keys == ["chapel"]
    assert entry.selective_logic == "and_all"
    assert entry.probability == 75
    assert entry.case_sensitive is True and entry.match_whole_words is True
    assert entry.scan_depth == 4 and entry.position == "before"
    assert (entry.sticky, entry.cooldown, entry.delay) == (2, 3, 5)
    assert entry.group == "rumors" and entry.group_weight == 60


async def test_import_selective_off_drops_secondary_keys_and_use_probability_off_means_100():
    manager = Worldbook(Store())
    await manager.import_entries(
        "room1",
        [
            {
                "comment": "e",
                "content": "lore",
                "key": ["k"],
                "keysecondary": ["s"],
                "selective": False,
                "probability": 25,
                "useProbability": False,
            }
        ],
    )
    [entry] = await manager.list("room1")
    assert entry.secondary_keys == []
    assert entry.probability == 100


async def test_import_binds_char_macro_statically():
    manager = Worldbook(Store())
    await manager.import_entries(
        "room1",
        [{"comment": "about {{char}}", "content": "{{char}} fears <BOT>'s past. {{user}} may ask.", "keys": ["{{char}}"]}],
        char_name="络络",
    )
    [entry] = await manager.list("room1")
    assert entry.title == "about 络络"
    assert entry.content == "络络 fears 络络's past. {{user}} may ask."  # {{user}} stays dynamic
    assert entry.keys == ["络络"]
