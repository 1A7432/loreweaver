from __future__ import annotations

from types import SimpleNamespace

from core.worldbook import LoreEntry, WorldbookManager, inject_world_lore_prompt
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
