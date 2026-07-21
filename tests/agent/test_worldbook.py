from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.worldbook import (
    MAX_IMPORT_CONTENT_CHARS,
    MAX_IMPORT_ENTRIES,
    LoreEntry,
    WorldbookManager,
    inject_world_lore_prompt,
)
from infra.embeddings import FakeEmbeddings
from infra.i18n import I18n
from infra.store import Store
from infra.vector import VectorStore


async def test_crud_lore_entries():
    manager = WorldbookManager(Store(":memory:"))

    entry = await manager.add(
        "chat-a",
        LoreEntry(id="harbor", title="Harbor", content="The harbor is quiet.", keys=["harbor"]),
    )

    assert entry.id == "harbor"
    assert (await manager.get("chat-a", "harbor")).title == "Harbor"
    assert (await manager.get("chat-a", "Harbor")).content == "The harbor is quiet."
    assert [item.id for item in await manager.list("chat-a")] == ["harbor"]

    updated = await manager.update("chat-a", "Harbor", content="The harbor bells ring.", priority=5)

    assert updated is not None
    assert updated.priority == 5
    assert (await manager.get("chat-a", "harbor")).content == "The harbor bells ring."
    assert await manager.remove("chat-a", "harbor") is True
    assert await manager.get("chat-a", "harbor") is None


async def test_keyword_match_constant_and_disabled_filtering():
    manager = WorldbookManager(Store(":memory:"))
    await manager.add(
        "chat-a",
        LoreEntry(id="light", title="Lighthouse", content="The lighthouse lens is cracked.", keys=["lighthouse"]),
    )
    await manager.add("chat-a", LoreEntry(id="law", title="Law", content="Magic leaves silver ash.", constant=True))
    await manager.add(
        "chat-a",
        LoreEntry(id="off", title="Disabled", content="Disabled lore.", keys=["lighthouse"], enabled=False),
    )

    matches = await manager.match("chat-a", "We walk toward the lighthouse.", role="player")
    contents = [entry.content for entry in matches]

    assert "The lighthouse lens is cracked." in contents
    assert "Magic leaves silver ash." in contents
    assert "Disabled lore." not in contents


async def test_vector_retrieval_finds_semantic_entry_without_exact_key():
    embeddings = FakeEmbeddings()
    manager = WorldbookManager(Store(":memory:"), VectorStore(dim=embeddings.dim), embeddings)
    await manager.add(
        "chat-a",
        LoreEntry(
            id="storm",
            title="Storm Customs",
            content="sailors sailors storm bells ring before voyage",
            keys=["unmentioned-key"],
        ),
    )

    matches = await manager.match("chat-a", "The sailors prepare for voyage.", role="player")

    assert [entry.id for entry in matches] == ["storm"]


async def test_secret_filtering_for_match_and_prompt():
    sentinel = "KEEPER_SECRET_SENTINEL"
    manager = WorldbookManager(Store(":memory:"))
    await manager.add(
        "chat-a",
        LoreEntry(
            id="secret",
            title="Secret",
            content=f"{sentinel} hides under the chapel.",
            keys=["chapel"],
            secret=True,
        ),
    )
    await manager.add(
        "chat-a",
        LoreEntry(id="public", title="Public", content="The chapel bell is public knowledge.", keys=["chapel"]),
    )

    keeper_matches = await manager.match("chat-a", "chapel", role="keeper")
    player_matches = await manager.match("chat-a", "chapel", role="player")
    prompt = await inject_world_lore_prompt(
        SimpleNamespace(chat_key="chat-a"),
        manager,
        I18n(locale="en"),
        role="player",
        recent_context="chapel",
    )

    assert sentinel in "\n".join(entry.content for entry in keeper_matches)
    assert sentinel not in "\n".join(entry.content for entry in player_matches)
    assert sentinel not in prompt
    assert "The chapel bell is public knowledge." in prompt


async def test_import_sillytavern_character_book_entries():
    manager = WorldbookManager(Store(":memory:"))

    count = await manager.import_entries(
        "chat-a",
        {"entries": [{"keys": ["observatory"], "content": "The observatory tracks red stars.", "constant": False}]},
        source="card",
    )
    matches = await manager.match("chat-a", "We enter the observatory.", role="player")

    assert count == 1
    assert len(await manager.list("chat-a")) == 1
    assert [entry.content for entry in matches] == ["The observatory tracks red stars."]


async def test_inject_world_lore_prompt_role_filtering_and_empty_case():
    manager = WorldbookManager(Store(":memory:"))
    ctx = SimpleNamespace(chat_key="chat-a")
    i18n = I18n(locale="en")
    await manager.add(
        "chat-a",
        LoreEntry(id="public", title="Public", content="Public moon lore.", keys=["moon"]),
    )
    await manager.add(
        "chat-a",
        LoreEntry(id="secret", title="Secret", content="Secret moon lore.", keys=["moon"], secret=True),
    )

    player_prompt = await inject_world_lore_prompt(ctx, manager, i18n, role="player", recent_context="moon")
    keeper_prompt = await inject_world_lore_prompt(ctx, manager, i18n, role="keeper", recent_context="moon")
    empty_prompt = await inject_world_lore_prompt(ctx, manager, i18n, role="player", recent_context="sun")

    assert "World Lore" in player_prompt
    assert "Public moon lore." in player_prompt
    assert "Secret moon lore." not in player_prompt
    assert "Secret moon lore." in keeper_prompt
    assert empty_prompt == ""


async def test_world_scope_lore_is_room_scoped_no_cross_room_leak():
    """Security: a `world`-scope secret added in room A must be invisible to room B on the same
    host (shared store). Before the fix, world scope used a single global namespace, so every
    room shared worldbook.world.* — an information-isolation red-line breach."""
    sentinel = "ROOM_A_ONLY_SECRET"
    store = Store(":memory:")
    manager = WorldbookManager(store)

    await manager.add(
        "tui:group:room-a",
        LoreEntry(
            id="hidden",
            title="Hidden",
            content=f"{sentinel} is buried below room A.",
            keys=["vault"],
            scope="world",
            secret=True,
        ),
    )
    await manager.add(
        "tui:group:room-a",
        LoreEntry(id="always", title="Always", content="Room A premise.", scope="world", constant=True),
    )

    # Room B shares the same host/store but must see NOTHING from room A.
    assert await manager.list("tui:group:room-b") == []
    assert await manager.match("tui:group:room-b", "vault", role="keeper") == []
    keeper_prompt = await inject_world_lore_prompt(
        SimpleNamespace(chat_key="tui:group:room-b"),
        manager,
        I18n(locale="en"),
        role="keeper",
        recent_context="vault",
    )
    assert keeper_prompt == ""
    assert sentinel not in keeper_prompt

    # Room A still sees its own world lore.
    assert {entry.id for entry in await manager.list("tui:group:room-a")} == {"hidden", "always"}


async def test_import_forces_untrusted_defaults():
    """Security: an uploaded lorebook cannot dictate scope/constant/secret. A crafted entry with
    constant=true / scope=world / secret=true must land room-local, non-constant, non-secret."""
    manager = WorldbookManager(Store(":memory:"))

    count = await manager.import_entries(
        "chat-a",
        {
            "entries": [
                {
                    "title": "Injected",
                    "content": "INJECTED_ALWAYS_ON payload.",
                    "keys": [],
                    "scope": "world",
                    "constant": True,
                    "secret": True,
                }
            ]
        },
        source="card",
        is_keeper=False,
    )
    assert count == 1
    [entry] = await manager.list("chat-a")
    assert entry.scope == "session"
    assert entry.constant is False
    assert entry.secret is False

    # A keyless, non-constant entry must NOT be force-injected into a prompt.
    prompt = await inject_world_lore_prompt(
        SimpleNamespace(chat_key="chat-a"),
        manager,
        I18n(locale="en"),
        role="keeper",
        recent_context="an unrelated scene",
    )
    assert "INJECTED_ALWAYS_ON" not in prompt


async def test_import_keeper_may_retain_secret_but_scope_and_constant_still_forced():
    manager = WorldbookManager(Store(":memory:"))

    await manager.import_entries(
        "chat-a",
        {"entries": [{"title": "K", "content": "keeper lore", "scope": "world", "constant": True, "secret": True}]},
        source="card",
        is_keeper=True,
    )
    [entry] = await manager.list("chat-a")
    assert entry.secret is True  # keeper importer keeps the secrecy flag
    assert entry.scope == "session"  # scope is still forced room-local
    assert entry.constant is False  # constant is still forced off


async def test_import_entry_count_cap_enforced():
    manager = WorldbookManager(Store(":memory:"))
    too_many = {"entries": [{"content": f"lore {i}", "keys": ["k"]} for i in range(MAX_IMPORT_ENTRIES + 1)]}
    with pytest.raises(ValueError):
        await manager.import_entries("chat-a", too_many, source="card")
    # Nothing partial was written.
    assert await manager.list("chat-a") == []


async def test_import_entry_content_length_cap_enforced():
    manager = WorldbookManager(Store(":memory:"))
    oversized = {"entries": [{"content": "x" * (MAX_IMPORT_CONTENT_CHARS + 1), "keys": ["k"]}]}
    with pytest.raises(ValueError):
        await manager.import_entries("chat-a", oversized, source="card")


async def test_room_rows_backup_covers_world_scope_entries():
    """The room backup allowlist must capture room-scoped world lore (entries + index) so a
    snapshot round-trips it. Regression against world lore silently missing from backups."""
    from net.room_backup import room_rows

    store = Store(":memory:")
    manager = WorldbookManager(store)
    chat_key = "tui:group:room-a"
    await manager.add(
        chat_key,
        LoreEntry(id="wl", title="World Lore", content="A durable world fact.", scope="world"),
    )

    services = SimpleNamespace(store=store)
    rows = await room_rows(services, chat_key)
    store_keys = {row["store_key"] for row in rows}

    assert f"worldbook.{chat_key}.wl" in store_keys  # the entry row
    assert f"worldbook_index.{chat_key}" in store_keys  # the index row

    # And nothing lands in the legacy global namespace that would cross rooms.
    assert not any(str(key).startswith("worldbook.world.") for key in store_keys)


async def test_one_corrupt_row_is_skipped_and_does_not_break_lookups():
    """F7: a single unreadable worldbook row (bad JSON / wrong shape) must not break
    list()/get()/match() for the whole book — the bad row is skipped, good ones survive."""
    from core.worldbook import _entry_store_key, _index_store_key, _namespace

    store = Store(":memory:")
    manager = WorldbookManager(store)
    await manager.add(
        "chat-a", LoreEntry(id="ok", title="Good Lore", content="The harbor is calm.", keys=["harbor"])
    )

    # Poison the index with a second id whose stored blob is not valid JSON.
    namespace = _namespace("chat-a", "world")
    await store.set(user_key="", store_key=_entry_store_key(namespace, "broken"), value="{not valid json")
    await store.set(user_key="", store_key=_index_store_key(namespace), value='["ok", "broken"]')

    listed = await manager.list("chat-a")
    assert [entry.id for entry in listed] == ["ok"]  # broken row skipped, good row survives
    assert (await manager.get("chat-a", "Good Lore")).content == "The harbor is calm."
    matches = await manager.match("chat-a", "We reach the harbor.", role="player")
    assert [entry.id for entry in matches] == ["ok"]
