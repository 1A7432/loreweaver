"""M26 — the lore overlay: effective state, the three activation paths, the overlay file.

The oracle for §10 items 1-5, 8 and 12 of `docs/specs/M26-lore-overlay.md`. The fixture is
the synthetic ugly card in `tests/fixtures/overlay_card.py` — file-disabled, keyless,
constant, `before_char`, CJK `·` titles, one oversized block.
"""

from __future__ import annotations

import pytest

from core.documents import DocumentStore
from core.lore_overlay import (
    EMPTY_OVERLAY,
    MAX_SETUP_OPTIONS,
    Overlay,
    OverlayEntry,
    OverlayError,
    SetupItem,
    apply,
    clear_entry,
    differs,
    load_overlay,
    mark_done,
    mark_setup_done,
    normalize_overlay,
    parse_overlay_file,
    save_overlay,
    set_entry,
    set_setup_items,
    stale_titles,
    validate_overlay,
)
from core.worldbook import (
    KEEPER_TURN_BUDGET_CHARS,
    KEEPER_TURN_LIMIT,
    LoreEntry,
    Worldbook,
    probe_turn_budget,
)
from infra.store import Store
from tests.fixtures.overlay_card import (
    ALWAYS_ON_TITLE,
    OVERLAY_FILE,
    UNREACHABLE_COUNT,
    card_book,
)


def _entry(**overrides) -> LoreEntry:
    base = dict(id="", title="难度·残酷", content="线索会骗人。", enabled=False, constant=True, keys=[])
    base.update(overrides)
    return LoreEntry.from_dict(base)


def _resolver(values: dict):
    return lambda path: values.get(path)


async def _imported_room(store: Store, *, chat_key: str = "room1", **book_kwargs) -> Worldbook:
    worldbook = Worldbook(store)
    await worldbook.import_entries(chat_key, card_book(**book_kwargs), source="card", is_keeper=True)
    return worldbook


# ---------------------------------------------------------------------------
# §10.1 — apply() precedence
# ---------------------------------------------------------------------------


def test_apply_without_an_overlay_returns_the_identical_entry():
    entry = _entry()
    before = entry.to_dict()

    assert apply(entry, None) is entry
    assert apply(entry, EMPTY_OVERLAY) is entry
    assert apply(entry, Overlay(entries={"别的条目": OverlayEntry(enabled=True)})) is entry
    assert entry.to_dict() == before  # byte-equal: nothing was rewritten


def test_apply_overrides_enabled_and_replaces_the_condition():
    entry = _entry(condition="旧条件 == 1")
    overlay = Overlay(entries={"难度·残酷": OverlayEntry(enabled=True, condition='配置.难度 == "残酷"')})

    effective = apply(entry, overlay)

    assert (effective.enabled, effective.condition) == (True, '配置.难度 == "残酷"')
    assert (entry.enabled, entry.condition) == (False, "旧条件 == 1")  # the stored entry is untouched
    assert differs(entry, overlay)


def test_apply_leaves_the_file_condition_when_the_overlay_only_switches():
    entry = _entry(condition="旧条件 == 1")

    effective = apply(entry, Overlay(entries={"难度·残酷": OverlayEntry(enabled=True)}))

    assert (effective.enabled, effective.condition) == (True, "旧条件 == 1")


def test_apply_can_switch_an_entry_off():
    entry = _entry(enabled=True)

    assert apply(entry, Overlay(entries={"难度·残酷": OverlayEntry(enabled=False)})).enabled is False


# ---------------------------------------------------------------------------
# §10.2 — all three activation paths honor the overlay
# ---------------------------------------------------------------------------


class _StubVectorDb:
    """A vector store that always recalls the ids it was handed.

    The point under test is the FILTER, not the embedding: `FakeEmbeddings` is a hash
    bag-of-tokens and CJK entries do not reliably come back from it, which would make a
    green test prove nothing. This double removes that variable — every search returns the
    seeded hits, so an entry that does not reach the caller was dropped by the overlay.
    """

    def __init__(self) -> None:
        self.entry_ids: list[str] = []
        self.searched = 0

    async def upsert(self, points) -> None:  # pragma: no cover - not exercised here
        return None

    async def delete(self, ids) -> None:  # pragma: no cover - not exercised here
        return None

    async def search(self, vector, *, limit: int, filter=None):
        from infra.vector import VectorHit

        self.searched += 1
        return [
            VectorHit(id=entry_id, score=0.9, payload={"entry_id": entry_id})
            for entry_id in self.entry_ids
        ]


class _StubEmbeddings:
    dim = 8

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0] + [0.0] * 7 for _ in texts]


async def test_keyword_match_honors_the_overlay_both_ways():
    store = Store()
    worldbook = await _imported_room(store)

    off = [entry.title for entry in await worldbook.match("room1", "", role="keeper")]
    assert "难度·残酷" not in off  # the file says disabled

    await save_overlay(
        DocumentStore(store), "room1", Overlay(entries={"难度·残酷": OverlayEntry(enabled=True)})
    )
    on = [entry.title for entry in await worldbook.match("room1", "", role="keeper")]
    assert "难度·残酷" in on


async def test_semantic_recall_cannot_re_add_what_the_overlay_switched_off():
    """The 2026-08-06 bypass shape: a filter keyword matching honors and recall ignores."""
    store = Store()
    vector_db = _StubVectorDb()
    worldbook = Worldbook(store, vector_db=vector_db, embeddings=_StubEmbeddings())
    await worldbook.import_entries("room1", card_book(), source="card", is_keeper=True)
    always_on = await worldbook.get("room1", ALWAYS_ON_TITLE)
    assert always_on is not None
    vector_db.entry_ids = [always_on.id]

    # Proof the vector path really runs: with no overlay the entry comes back from the
    # store even when keyword selection is asked to skip constants.
    recalled = await worldbook._semantic_hits("room1", "现在的场面", limit=8)
    assert vector_db.searched > 0
    assert {entry.title for entry in recalled} == {ALWAYS_ON_TITLE}

    overlay = Overlay(entries={ALWAYS_ON_TITLE: OverlayEntry(enabled=False)})
    filtered = await worldbook._semantic_hits("room1", "现在的场面", limit=8, overlay=overlay)
    assert filtered == []

    # And through the public path, where the same overlay is loaded from the document.
    await save_overlay(DocumentStore(store), "room1", overlay)
    chosen = await worldbook.match("room1", "现在的场面", role="keeper")
    assert ALWAYS_ON_TITLE not in [entry.title for entry in chosen]


async def test_semantic_recall_can_also_surface_an_entry_the_overlay_switched_on():
    store = Store()
    vector_db = _StubVectorDb()
    worldbook = Worldbook(store, vector_db=vector_db, embeddings=_StubEmbeddings())
    await worldbook.import_entries("room1", card_book(), source="card", is_keeper=True)
    variant = await worldbook.get("room1", "难度·残酷")
    assert variant is not None and variant.enabled is False
    vector_db.entry_ids = [variant.id]

    assert await worldbook._semantic_hits("room1", "线索", limit=8) == []

    overlay = Overlay(entries={"难度·残酷": OverlayEntry(enabled=True)})
    recalled = await worldbook._semantic_hits("room1", "线索", limit=8, overlay=overlay)
    assert {entry.title for entry in recalled} == {"难度·残酷"}


async def test_the_activewi_extra_pass_honors_the_overlay():
    from core.worldbook import inject_world_lore_prompt

    class _Ctx:
        chat_key = "room1"

    class _I18n:
        def t(self, key, **kwargs):
            return key

    class _Engine:
        """The slice of `core.ejs_full.FullEjsEngine` the extra pass touches."""

        def __init__(self, names):
            self.activated = names

        def render(self, content):  # pragma: no cover - no template content in the fixture
            raise RuntimeError("no templates here")

        def eval_condition(self, condition):
            return None

    store = Store()
    worldbook = await _imported_room(store)

    without = await inject_world_lore_prompt(
        _Ctx(), worldbook, _I18n(), role="keeper", recent_context="", engine=_Engine(["难度·残酷"])
    )
    assert "线索会骗人" not in without  # file-disabled: the extra pass drops it today

    await save_overlay(
        DocumentStore(store), "room1", Overlay(entries={"难度·残酷": OverlayEntry(enabled=True)})
    )
    with_overlay = await inject_world_lore_prompt(
        _Ctx(), worldbook, _I18n(), role="keeper", recent_context="", engine=_Engine(["难度·残酷"])
    )
    assert "线索会骗人" in with_overlay


# ---------------------------------------------------------------------------
# §10.3 — a binding is a switch driven by the variable tree
# ---------------------------------------------------------------------------


async def test_a_bound_family_follows_the_variable_and_fails_closed():
    store = Store()
    worldbook = await _imported_room(store)
    await save_overlay(
        DocumentStore(store),
        "room1",
        Overlay(
            entries={
                title: OverlayEntry(enabled=True, condition=f'配置.难度 == "{title.split("·")[1]}"')
                for title in ("难度·轻松", "难度·标准", "难度·残酷")
            }
        ),
    )

    async def _titles(values: dict | None):
        entries = await worldbook.match(
            "room1", "", role="keeper", resolve=None if values is None else _resolver(values)
        )
        return [entry.title for entry in entries if entry.title.startswith("难度·")]

    assert await _titles({"配置.难度": "残酷"}) == ["难度·残酷"]
    assert await _titles({"配置.难度": "轻松"}) == ["难度·轻松"]
    assert await _titles({"配置.难度": "没听过的档位"}) == []
    assert await _titles(None) == []  # no resolver at all → fail closed


# ---------------------------------------------------------------------------
# §10.4 / §10.5 — faithful import survives, and so does the overlay
# ---------------------------------------------------------------------------


async def test_binding_never_rewrites_the_stored_entry():
    store = Store()
    documents = DocumentStore(store)
    worldbook = await _imported_room(store)
    before = (await worldbook.get("room1", "难度·残酷")).to_dict()

    await save_overlay(
        documents,
        "room1",
        set_entry(EMPTY_OVERLAY, "难度·残酷", enabled=True, condition='配置.难度 == "残酷"'),
    )

    assert (await worldbook.get("room1", "难度·残酷")).to_dict() == before
    stored = await documents.get("room1", "lore_overlay", "overlay")
    assert stored is not None and stored.data["entries"]["难度·残酷"]["enabled"] is True


async def test_a_reimport_replaces_the_lore_and_keeps_the_overlay():
    store = Store()
    documents = DocumentStore(store)
    worldbook = await _imported_room(store)
    await save_overlay(
        documents,
        "room1",
        set_entry(
            set_entry(EMPTY_OVERLAY, "难度·残酷", enabled=True),
            "被删掉的条目",
            enabled=True,
        ),
    )
    first_id = (await worldbook.get("room1", "难度·残酷")).id

    revised = card_book()
    revised["entries"] = [item for item in revised["entries"] if item["comment"] != "路线·判官线"]
    await worldbook.import_entries("room1", revised, source="card", is_keeper=True)

    assert (await worldbook.get("room1", "难度·残酷")).id != first_id  # replaced, not stacked
    assert "路线·判官线" not in {entry.title for entry in await worldbook.list("room1")}
    overlay = await load_overlay(documents, "room1")
    assert set(overlay.entries) == {"难度·残酷", "被删掉的条目"}
    titles = {entry.title for entry in await worldbook.list("room1")}
    assert stale_titles(overlay, titles) == ("被删掉的条目",)
    assert apply(await worldbook.get("room1", "难度·残酷"), overlay).enabled is True


# ---------------------------------------------------------------------------
# The import receipt's unreachable count (§10.13's core half)
# ---------------------------------------------------------------------------


async def test_unreachable_counts_only_stored_disabled_keyless_entries():
    store = Store()
    worldbook = Worldbook(store)
    unreachable: list[str] = []
    skipped: list[str] = []

    await worldbook.import_entries(
        "room1",
        card_book(),
        source="card",
        is_keeper=True,
        skipped_titles=skipped,
        unreachable_titles=unreachable,
    )

    assert len(unreachable) == UNREACHABLE_COUNT
    assert set(unreachable) == {"难度·轻松", "难度·标准", "难度·残酷", "路线·主线", "路线·判官线"}
    assert "回复模板" not in unreachable  # disabled but KEYED — reachable
    assert "[InitVar]开局变量" not in unreachable  # consumed as data before storage
    assert skipped == ["[mvu_update]变量输出格式"]


async def test_a_card_with_no_unreachable_entries_reports_none():
    store = Store()
    worldbook = Worldbook(store)
    unreachable: list[str] = []

    await worldbook.import_entries(
        "room1",
        {"entries": [{"comment": "开场", "content": "天亮了。", "keys": ["开场"], "enabled": True}]},
        source="tidy",
        is_keeper=True,
        unreachable_titles=unreachable,
    )

    assert unreachable == []


# ---------------------------------------------------------------------------
# §10.8 — the overlay FILE
# ---------------------------------------------------------------------------


def test_the_example_overlay_file_parses():
    overlay = parse_overlay_file(OVERLAY_FILE.encode("utf-8"))

    assert overlay.entries["难度·残酷"].condition == '配置.难度 == "残酷"'
    assert overlay.entries["难度·残酷"].enabled is True  # a binding implies the switch
    assert overlay.entries["回复模板"] == OverlayEntry(enabled=False, condition="")
    assert [item.path for item in overlay.setup] == ["配置.难度", "配置.路线"]
    assert overlay.setup[0].options == ("轻松", "标准", "残酷")
    assert overlay.setup[0].label_for("zh") == "难度"
    assert overlay.setup[0].label_for("en") == "Difficulty"
    assert overlay.expose == ("配置",)
    assert overlay.to_dict()["setup"][0]["done"] is False


@pytest.mark.parametrize(
    "body",
    [
        "format: loreweaver.lore-overlay/2\nentries: {}\n",  # unknown format
        "entries: {}\n",  # no format at all
        "format: loreweaver.lore-overlay/1\nentries:\n  A: {condition: '" + "x" * 600 + " == 1'}\n",
        "format: loreweaver.lore-overlay/1\nentries:\n  A: {condition: 'Object.keys(x)'}\n",
        "format: loreweaver.lore-overlay/1\nentries:\n  A: {enabled: maybe}\n",
        "format: loreweaver.lore-overlay/1\nsomething_else: 1\n",
        "format: loreweaver.lore-overlay/1\nsetup:\n  - {path: p, options: ["
        + ", ".join(str(index) for index in range(MAX_SETUP_OPTIONS + 1))
        + "]}\n",
    ],
)
def test_a_bad_overlay_file_is_refused(body: str):
    with pytest.raises(OverlayError):
        parse_overlay_file(body.encode("utf-8"))


def test_an_unknown_title_is_a_warning_not_a_failure():
    overlay = parse_overlay_file(OVERLAY_FILE.encode("utf-8"))

    warnings = validate_overlay(overlay, {"难度·轻松", "难度·标准", "难度·残酷", "路线·判官线", "回复模板"})

    assert len(warnings) == 1 and "残堇内部介绍" in warnings[0]
    assert validate_overlay(overlay, set(overlay.entries)) == []


def test_too_many_entries_is_refused():
    body = "format: loreweaver.lore-overlay/1\nentries:\n" + "".join(
        f"  E{index}: {{enabled: true}}\n" for index in range(201)
    )
    with pytest.raises(OverlayError):
        parse_overlay_file(body.encode("utf-8"))


# ---------------------------------------------------------------------------
# Transitions, persistence and degradation (§5.8)
# ---------------------------------------------------------------------------


def test_set_entry_refuses_an_unparsable_expression_and_changes_nothing():
    overlay = set_entry(EMPTY_OVERLAY, "难度·残酷", enabled=True)

    with pytest.raises(OverlayError):
        set_entry(overlay, "难度·残酷", condition="1 ~ 2")

    assert overlay.entries["难度·残酷"] == OverlayEntry(enabled=True, condition="")


def test_clear_entry_drops_one_or_all():
    overlay = set_entry(set_entry(EMPTY_OVERLAY, "A", enabled=True), "B", enabled=False)

    single, removed = clear_entry(overlay, "A")
    assert removed == 1 and set(single.entries) == {"B"}
    assert clear_entry(overlay, "缺席")[1] == 0

    everything, removed_all = clear_entry(overlay, "*")
    assert removed_all == 2 and everything.entries == {}


def test_setup_items_merge_without_reopening_a_made_choice():
    overlay = set_setup_items(EMPTY_OVERLAY, [SetupItem(path="配置.难度", options=("轻松",))])
    overlay, changed = mark_done(overlay, "配置.难度")
    assert changed is True

    merged = set_setup_items(
        overlay,
        [SetupItem(path="配置.难度", options=("轻松", "标准")), SetupItem(path="配置.路线")],
    )

    assert [(item.path, item.done) for item in merged.setup] == [("配置.难度", True), ("配置.路线", False)]
    assert merged.setup[0].options == ("轻松", "标准")  # the revised declaration still lands
    assert [item.path for item in merged.pending()] == ["配置.路线"]


async def test_mark_setup_done_flips_exactly_one_path():
    store = Store()
    documents = DocumentStore(store)
    await save_overlay(
        documents,
        "room1",
        set_setup_items(EMPTY_OVERLAY, [SetupItem(path="配置.难度"), SetupItem(path="配置.路线")]),
    )

    assert await mark_setup_done(documents, "room1", "配置.难度") is True
    assert await mark_setup_done(documents, "room1", "配置.难度") is False  # already done
    assert [item.path for item in (await load_overlay(documents, "room1")).pending()] == ["配置.路线"]


def test_a_pack_overlay_may_not_expose_the_whole_tree():
    """`*` is a judgement about THIS table's spoilers, so only the human at it may say it.
    A pack author writing `expose: ['*']` is reaching past the keeper."""
    for spelling in ("'*'", "'**'", "'*配置'"):
        body = f"format: loreweaver.lore-overlay/1\nexpose: [{spelling}]\n"
        with pytest.raises(OverlayError) as caught:
            parse_overlay_file(body.encode("utf-8"))
        assert "expose" in str(caught.value)

    explicit = parse_overlay_file(
        b"format: loreweaver.lore-overlay/1\nexpose: ['\xe9\x85\x8d\xe7\xbd\xae']\n"
    )
    assert explicit.expose == ("配置",)


async def test_a_stored_condition_outside_the_closed_grammar_is_dropped_on_load():
    """A restored `.save` file (or a hand-edited row) must not hand an arbitrary string to
    the EJS sandbox through `_condition_holds`: the load re-validates, fail closed."""
    store = Store()
    documents = DocumentStore(store)
    worldbook = await _imported_room(store)
    await documents.put(
        "room1",
        "lore_overlay",
        "overlay",
        {
            "entries": {
                "难度·残酷": {"enabled": True, "condition": "Object.keys(globalThis).length > 0"},
                "路线·判官线": {"enabled": True, "condition": '配置.路线 == "判官线"'},
            }
        },
    )

    overlay = await load_overlay(documents, "room1")

    assert overlay.entries["难度·残酷"].condition == ""  # the JS never survives the load
    assert overlay.entries["难度·残酷"].enabled is True  # but the switch does
    assert overlay.entries["路线·判官线"].condition == '配置.路线 == "判官线"'
    # And with the gate gone the entry is unconditional again, not JS-gated.
    chosen = [entry.title for entry in await worldbook.match("room1", "", role="keeper")]
    assert "难度·残酷" in chosen
    assert "路线·判官线" not in chosen  # its (valid) condition still fails closed with no resolver


async def test_update_lore_says_so_when_the_room_overlay_overrules_the_edit():
    """`update_lore` edits the FILE copy. Reporting "enabled is now false" for an entry the
    overlay keeps ON is a lie the model would then narrate around."""
    from agent.context import AgentCtx
    from agent.kp_tools_worldbook import WorldbookTools
    from agent.services import build_services
    from infra.config import Settings
    from infra.embeddings import FakeEmbeddings
    from infra.llm import FakeLLM

    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(16))
    ctx = AgentCtx(chat_key="room-update", user_id="kp", locale="en")
    await services.worldbook.import_entries(
        ctx.chat_key, card_book(), source="card", is_keeper=True
    )
    await save_overlay(
        services.documents, ctx.chat_key, Overlay(entries={"通用规则": OverlayEntry(enabled=True)})
    )
    tools = WorldbookTools(services)

    overruled = await tools.update_lore(ctx, title="通用规则", field="enabled", value="false")

    assert "this room overrides" in overruled and "enabled=Yes" in overruled
    # The FILE copy really did change — the tool did its job, it just is not the switch.
    assert (await services.worldbook.get(ctx.chat_key, "通用规则")).enabled is False
    assert (await services.worldbook.effective_list(ctx.chat_key))
    effective = next(
        entry for entry in await services.worldbook.effective_list(ctx.chat_key) if entry.title == "通用规则"
    )
    assert effective.enabled is True

    plain = await tools.update_lore(ctx, title="难度·残酷", field="priority", value="3")
    assert "this room overrides" not in plain


async def test_room_entry_titles_is_the_one_oracle_for_known_titles():
    """The card's RAW list still holds what the import consumed as data and what it skipped
    as oversized; the ROOM's stored entries are what an overlay title can actually name."""
    from core.lore_overlay import room_entry_titles

    store = Store()
    worldbook = await _imported_room(store)

    titles = await room_entry_titles(worldbook, "room1")

    assert "难度·残酷" in titles
    assert "[InitVar]开局变量" not in titles  # consumed as data, never stored
    assert "[mvu_update]变量输出格式" not in titles  # skipped as oversized


def test_a_corrupt_overlay_degrades_to_the_file_state():
    assert normalize_overlay("not a mapping") is EMPTY_OVERLAY
    assert normalize_overlay({"entries": "junk", "setup": 7}).is_empty
    salvaged = normalize_overlay(
        {"entries": {"A": {"enabled": "yes"}, "B": {"enabled": True}, "": {"enabled": True}}}
    )
    assert set(salvaged.entries) == {"B"}  # a non-bool `enabled` is not an override


# ---------------------------------------------------------------------------
# §10.12 — the budget receipt
# ---------------------------------------------------------------------------


async def test_an_entry_larger_than_the_whole_budget_never_injects():
    store = Store()
    worldbook = Worldbook(store)
    await worldbook.add(
        "room1",
        LoreEntry.from_dict(
            {"id": "", "title": "巨块", "content": "·" * (KEEPER_TURN_BUDGET_CHARS + 1), "constant": True}
        ),
    )

    probe = await probe_turn_budget(worldbook, "room1", "巨块")

    assert probe.found and probe.oversize and not probe.fits
    assert probe.size == KEEPER_TURN_BUDGET_CHARS + 1


async def test_the_receipt_names_what_crowded_an_entry_out():
    store = Store()
    # Both variants are switched on; 路线·判官线 carries the higher insertion order, so it
    # takes the 12,000-char budget first and 难度·残酷 is dropped by `_cap_entries` without
    # a word — the exact "chose = did nothing" shape the receipt exists to expose.
    worldbook = await _imported_room(store, route_chars=11_500)
    await save_overlay(
        DocumentStore(store),
        "room1",
        Overlay(
            entries={
                "路线·判官线": OverlayEntry(enabled=True),
                "难度·残酷": OverlayEntry(enabled=True),
            }
        ),
    )

    probe = await probe_turn_budget(worldbook, "room1", "难度·残酷")

    assert probe.found and not probe.fits and probe.crowded_out
    assert "路线·判官线" in probe.ranked_above


async def test_the_receipt_says_when_an_entry_does_fit():
    store = Store()
    worldbook = await _imported_room(store)
    await save_overlay(
        DocumentStore(store), "room1", Overlay(entries={"难度·残酷": OverlayEntry(enabled=True)})
    )

    probe = await probe_turn_budget(worldbook, "room1", "难度·残酷")

    assert probe.fits and not probe.crowded_out and not probe.oversize


async def test_the_receipt_dry_run_never_advances_the_timers():
    store = Store()
    worldbook = await _imported_room(store)
    before = await store.state_get("room1", "worldbook_timers")

    await probe_turn_budget(worldbook, "room1", ALWAYS_ON_TITLE)

    assert await store.state_get("room1", "worldbook_timers") == before


async def test_a_missing_title_probes_as_not_found():
    probe = await probe_turn_budget(await _imported_room(Store()), "room1", "不存在的条目")

    assert not probe.found


async def test_the_probe_flags_a_js_condition_it_could_not_evaluate():
    """Without the sandbox an arbitrary-JS `@@if` cannot be judged. Saying "nothing selects
    it" would be a confident lie about an entry the real turn injects every time."""
    store = Store()
    worldbook = await _imported_room(store)
    await worldbook.add(
        "room1",
        LoreEntry.from_dict(
            {
                "id": "",
                "title": "JS 门",
                "content": "gated",
                "constant": True,
                "condition": "[1,2].filter(x => x > 0).length > 1",
            }
        ),
    )

    probe = await probe_turn_budget(worldbook, "room1", ALWAYS_ON_TITLE)

    assert probe.js_unevaluated is True


async def test_a_room_with_only_closed_grammar_conditions_is_not_flagged():
    store = Store()
    worldbook = await _imported_room(store)
    await save_overlay(
        DocumentStore(store),
        "room1",
        Overlay(entries={"难度·残酷": OverlayEntry(enabled=True, condition='配置.难度 == "残酷"')}),
    )

    probe = await probe_turn_budget(worldbook, "room1", ALWAYS_ON_TITLE)

    assert probe.js_unevaluated is False


async def test_the_comparison_run_is_bounded_by_the_room_not_by_the_import_caps():
    """The unbounded run exists to answer "would it be selected at all"; a 3.2 MB budget
    means "no cap" only by accident, and the room's own totals say it on purpose."""
    store = Store()
    worldbook = await _imported_room(store, route_chars=11_500)
    await save_overlay(
        DocumentStore(store),
        "room1",
        Overlay(
            entries={
                "路线·判官线": OverlayEntry(enabled=True),
                "难度·残酷": OverlayEntry(enabled=True),
            }
        ),
    )
    seen: list[tuple[int, int]] = []
    original = worldbook.match

    async def _recording(chat_key, context, **kwargs):
        seen.append((kwargs["limit"], kwargs["budget_chars"]))
        return await original(chat_key, context, **kwargs)

    worldbook.match = _recording  # type: ignore[method-assign]
    probe = await probe_turn_budget(worldbook, "room1", "难度·残酷")

    assert probe.crowded_out
    entries = await worldbook.effective_list("room1")
    assert seen[0] == (KEEPER_TURN_LIMIT, KEEPER_TURN_BUDGET_CHARS)
    assert seen[1] == (len(entries), sum(len(entry.content) for entry in entries))
