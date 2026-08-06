from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.worldbook import (
    MAX_IMPORT_CONTENT_CHARS,
    MAX_IMPORT_ENTRIES,
    LoreEntry,
    Worldbook,
    inject_world_lore_prompt,
)
from infra.embeddings import FakeEmbeddings
from infra.i18n import I18n
from infra.store import Store
from infra.vector import VectorStore


async def test_crud_lore_entries():
    manager = Worldbook(Store(":memory:"))

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
    manager = Worldbook(Store(":memory:"))
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
    manager = Worldbook(Store(":memory:"), VectorStore(dim=embeddings.dim), embeddings)
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
    manager = Worldbook(Store(":memory:"))
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
    manager = Worldbook(Store(":memory:"))

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
    manager = Worldbook(Store(":memory:"))
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
    manager = Worldbook(store)

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
    """Security: an uploaded lorebook cannot dictate scope/constant/secret. A crafted
    non-secret entry with constant=true / scope=world lands room-local and non-constant;
    a secret=true entry on a NON-keeper import is dropped outright — honoring it would
    mint keeper-only lore, importing it as public (the pre-M14 behavior) would launder
    keeper-only content into player-visible state."""
    manager = Worldbook(Store(":memory:"))

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
                },
                {
                    "title": "Smuggled secret",
                    "content": "keeper-only payload",
                    "keys": [],
                    "secret": True,
                },
            ]
        },
        source="card",
        is_keeper=False,
    )
    assert count == 1  # the secret-flagged entry never lands, in any form
    [entry] = await manager.list("chat-a")
    assert entry.title == "Injected"
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


async def test_import_keeper_retains_secret_and_constant_but_scope_still_forced():
    manager = Worldbook(Store(":memory:"))

    await manager.import_entries(
        "chat-a",
        {"entries": [{"title": "K", "content": "keeper lore", "scope": "world", "constant": True, "secret": True}]},
        source="card",
        is_keeper=True,
    )
    [entry] = await manager.list("chat-a")
    assert entry.secret is True  # keeper importer keeps the secrecy flag
    assert entry.constant is True  # …and the constant flag (module rules are constant entries)
    assert entry.scope == "session"  # scope is still forced room-local, keeper or not


async def test_import_entry_count_cap_enforced():
    manager = Worldbook(Store(":memory:"))
    too_many = {"entries": [{"content": f"lore {i}", "keys": ["k"]} for i in range(MAX_IMPORT_ENTRIES + 1)]}
    with pytest.raises(ValueError):
        await manager.import_entries("chat-a", too_many, source="card")
    # Nothing partial was written.
    assert await manager.list("chat-a") == []


async def test_import_oversized_entry_is_skipped_and_itemized_not_fatal():
    """Real module cards mix ordinary lore with 10KB+ protocol blocks: an oversized entry
    is skipped (title reported via the accumulator), the REST of the import still lands —
    the pre-2026-08-05 whole-import ValueError left ten entries half-written and no clue
    which entry was at fault."""
    manager = Worldbook(Store(":memory:"))
    payload = {
        "entries": [
            {"title": "正常条目", "content": "short lore", "keys": ["k"]},
            {"title": "巨型协议块", "content": "x" * (MAX_IMPORT_CONTENT_CHARS + 1), "keys": ["p"]},
            {"title": "另一条", "content": "more lore", "keys": ["m"]},
        ]
    }
    skipped: list[str] = []
    count = await manager.import_entries("chat-a", payload, source="card", skipped_titles=skipped)
    assert count == 2
    assert skipped == ["巨型协议块"]
    titles = {entry.title for entry in await manager.list("chat-a")}
    assert titles == {"正常条目", "另一条"}


async def test_keeper_world_import_preserves_constant_player_import_does_not():
    """ST module cards ship rules/timelines as constant entries; a keeper world import keeps
    the flag (same trust precedent as `secret`), while a player upload still gets it forced
    off — an untrusted file cannot self-promote to always-on injection."""
    manager = Worldbook(Store(":memory:"))
    payload = {"entries": [{"title": "难度·标准", "content": "原作时间线规则。", "keys": [], "constant": True}]}

    await manager.import_entries("keeper-room", payload, source="card", is_keeper=True)
    [keeper_entry] = await manager.list("keeper-room")
    assert keeper_entry.constant is True

    await manager.import_entries("player-room", payload, source="card", is_keeper=False)
    [player_entry] = await manager.list("player-room")
    assert player_entry.constant is False


async def test_world_scope_entries_live_room_scoped_in_the_documents_table():
    """World lore persists as this ROOM's `lore` documents (M17): room-scoped by the
    documents table's room column, so a snapshot of the room carries it and nothing
    can land in a cross-room global namespace."""
    store = Store(":memory:")
    manager = Worldbook(store)
    chat_key = "tui:group:room-a"
    await manager.add(
        chat_key,
        LoreEntry(id="wl", title="World Lore", content="A durable world fact.", scope="world"),
    )

    docs = await manager.documents.list(chat_key, "lore")
    assert [doc.id for doc in docs] == ["wl"]
    assert await manager.documents.list("some-other-room", "lore") == []


async def test_one_corrupt_document_is_skipped_and_does_not_break_lookups():
    """F7: a single unreadable lore document (shape that LoreEntry.from_dict rejects)
    must not break list()/get()/match() for the whole book — the bad document is
    skipped, good ones survive."""
    store = Store(":memory:")
    manager = Worldbook(store)
    await manager.add(
        "chat-a", LoreEntry(id="ok", title="Good Lore", content="The harbor is calm.", keys=["harbor"])
    )

    # Poison the book with a document whose data shape from_dict rejects.
    await manager.documents.put("chat-a", "lore", "broken", {"title": "Broken", "keys": 123})

    listed = await manager.list("chat-a")
    assert [entry.id for entry in listed] == ["ok"]  # broken document skipped, good one survives
    assert (await manager.get("chat-a", "Good Lore")).content == "The harbor is calm."
    matches = await manager.match("chat-a", "We reach the harbor.", role="player")
    assert [entry.id for entry in matches] == ["ok"]
