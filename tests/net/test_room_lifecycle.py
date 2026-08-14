"""M23 WS1 behaviour: the facet registry answers WHAT, and the answer did not change.

`tests/architecture/test_room_facets.py` proves the registry is complete. This file
proves the switch was behaviour-preserving where it had to be, and behaviour-fixing
where it was meant to be:

- a golden table pins `.reset story/chars/all` against the four hand-written frozensets
  the registry replaced, key for key;
- `.save load` can no longer be rewound through (`import` clears the undo ring);
- a deleted room stops leaking its turn lock.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.services import build_services
from agent.undo import available_turns, capture
from agent.undo import restore as restore_room
from gateway.hub import RoomHub
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.keystore import Keystore
from net.room_backup import chat_key_for_room, delete_room_data, export_room, import_room, reset_room_state

# --- The golden tables ------------------------------------------------------
# Copied VERBATIM from `net/room_backup.py` as it stood at e773111, immediately before
# the facet registry replaced them. They are the oracle: the registry may reorganise who
# owns what, but a `.reset` must still wipe exactly these and spare everything else.
GOLDEN_STORY_DOC_TYPES = frozenset({"note", "scene", "npc", "chronicle", "campaign_summary", "thread"})
GOLDEN_STORY_KEYS = frozenset(
    {
        "chat_history",
        "chat_history_leaf",
        "initiative",
        "initiative_meta",
        "game_clock",
        "chronicle_turn",
        "chronicle_seq",
        "relationships",
        "usage_stats",
        "worldbook_timers",
    }
)
GOLDEN_STORY_PREFIXES = frozenset(
    {"battle_report.", "session_history.", "session_name.", "session_record."}
)
GOLDEN_CHARS_DOC_TYPES = frozenset({"sheet"})
GOLDEN_CHARS_KEYS = frozenset({"party_roster", "party_auto"})
GOLDEN_CHARS_PREFIXES = frozenset({"active_character."})
GOLDEN_ALL_DOC_TYPES = frozenset({"lore", "mvu_tree", "modvars", "module_pool", "pregen"})
GOLDEN_ALL_KEYS = frozenset(
    {
        "module_fulltext",
        "module_init_error",
        "module_init_status",
        "world_import",
        "room_hooks",
        "media_history",
        "audio_library",
        "audio_state",
        "forge_module_last",
    }
)
GOLDEN_ALL_PREFIXES = frozenset({"forge_module_owner."})

# Room state that survived every scope before M23 WS1 and must still survive it: the
# settings family. Configuration, not campaign content.
GOLDEN_SURVIVING_KEYS = frozenset(
    {
        "chat_locale",
        "bot_enabled",
        "media_enabled",
        "panels_enabled",
        "preset_enabled",
        "skills_enabled",
        "rule_variant",
        "tool_phase",
        "reset_pending",
    }
)

# The one place this file is NOT a copy of the pre-M23 tables. These three survived every
# reset before M23 only because no cleanup list had ever named them; the WS1 write-surface
# scan surfaced them, and the owner ruled on 2026-08-14 that all three go with the story.
# Kept as their own set so the golden tables above stay an honest record of what was.
POST_M23_STORY_KEYS = frozenset({"scribe_whispers", "director_images", "director_pregen"})

# Same honest-record split on the document-type side: no pre-M23 cleanup list named the
# registered `media` document type, so `.reset all` spared it. The M23 media facet claims
# the type at reset_scope="all", so a full reset now wipes it — a post-M23 behaviour
# increment, pinned explicitly rather than folded into the golden tables.
POST_M23_ALL_DOC_TYPES = frozenset({"media"})
GOLDEN_SURVIVING_DOC_TYPES = frozenset({"table_habits"})


def _golden_targets(scope: str) -> tuple[frozenset[str], frozenset[str], frozenset[str]]:
    doc_types = set(GOLDEN_STORY_DOC_TYPES)
    keys = set(GOLDEN_STORY_KEYS) | set(POST_M23_STORY_KEYS)
    prefixes = set(GOLDEN_STORY_PREFIXES)
    if scope in ("chars", "all"):
        doc_types |= GOLDEN_CHARS_DOC_TYPES
        keys |= GOLDEN_CHARS_KEYS
        prefixes |= GOLDEN_CHARS_PREFIXES
    if scope == "all":
        doc_types |= GOLDEN_ALL_DOC_TYPES | POST_M23_ALL_DOC_TYPES
        keys |= GOLDEN_ALL_KEYS
        prefixes |= GOLDEN_ALL_PREFIXES
    return frozenset(doc_types), frozenset(keys), frozenset(prefixes)


def _services(data_dir: str):
    settings = Settings(
        locale="en", data_dir=data_dir, llm=LLMSettings(provider="openai", chat_model="gpt-4o")
    )
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


async def _populate(services, chat_key: str) -> None:
    """Write one row for every key, prefix and document type in the golden tables."""
    every_doc_type = (
        GOLDEN_STORY_DOC_TYPES
        | GOLDEN_CHARS_DOC_TYPES
        | GOLDEN_ALL_DOC_TYPES
        | POST_M23_ALL_DOC_TYPES
        | GOLDEN_SURVIVING_DOC_TYPES
    )
    for doc_type in sorted(every_doc_type):
        # The raw store, not `DocumentStore.put`: this fixture is about row disposal, and
        # a chronicle record that has to satisfy its validator would say nothing extra.
        await services.store.doc_put(
            chat_key,
            doc_type,
            f"{doc_type}-1",
            schema_version=1,
            data="{}",
            meta="{}",
            grants="[]",
        )
    every_key = (
        GOLDEN_STORY_KEYS
        | POST_M23_STORY_KEYS
        | GOLDEN_CHARS_KEYS
        | GOLDEN_ALL_KEYS
        | GOLDEN_SURVIVING_KEYS
    )
    for key in sorted(every_key):
        await services.store.state_set(chat_key, key, "x")
    every_prefix = GOLDEN_STORY_PREFIXES | GOLDEN_CHARS_PREFIXES | GOLDEN_ALL_PREFIXES
    for prefix in sorted(every_prefix):
        await services.store.state_set(chat_key, f"{prefix}sample", "x")


@pytest.mark.parametrize("scope", ["story", "chars", "all"])
async def test_reset_wipes_exactly_what_the_pre_registry_tables_wiped(tmp_path, scope):
    services = _services(str(tmp_path))
    chat_key = chat_key_for_room("arkham")
    await _populate(services, chat_key)

    await reset_room_state(services, chat_key, scope=scope)

    wiped_types, wiped_keys, wiped_prefixes = _golden_targets(scope)
    surviving_rows = {
        str(row["key"]) for row in await services.store.state_list(chat_key) if row["value"] is not None
    }
    surviving_types = {str(doc["type"]) for doc in await services.store.doc_list(chat_key)}

    for key in sorted(wiped_keys):
        assert key not in surviving_rows, f"`.reset {scope}` should have wiped {key!r}"
    for prefix in sorted(wiped_prefixes):
        assert f"{prefix}sample" not in surviving_rows, f"`.reset {scope}` should have wiped {prefix}*"
    for doc_type in sorted(wiped_types):
        assert doc_type not in surviving_types, f"`.reset {scope}` should have wiped {doc_type} documents"

    all_keys = (
        GOLDEN_STORY_KEYS
        | POST_M23_STORY_KEYS
        | GOLDEN_CHARS_KEYS
        | GOLDEN_ALL_KEYS
        | GOLDEN_SURVIVING_KEYS
    )
    for key in sorted(all_keys - wiped_keys):
        assert key in surviving_rows, f"`.reset {scope}` wiped {key!r}, which used to survive"
    all_prefixes = GOLDEN_STORY_PREFIXES | GOLDEN_CHARS_PREFIXES | GOLDEN_ALL_PREFIXES
    for prefix in sorted(all_prefixes - wiped_prefixes):
        assert f"{prefix}sample" in surviving_rows, f"`.reset {scope}` wiped {prefix}*, which used to survive"
    all_types = (
        GOLDEN_STORY_DOC_TYPES
        | GOLDEN_CHARS_DOC_TYPES
        | GOLDEN_ALL_DOC_TYPES
        | POST_M23_ALL_DOC_TYPES
        | GOLDEN_SURVIVING_DOC_TYPES
    )
    for doc_type in sorted(all_types - wiped_types):
        assert doc_type in surviving_types, f"`.reset {scope}` wiped {doc_type}, which used to survive"


async def test_reset_still_clears_the_history_tree_and_the_undo_ring_at_every_scope(tmp_path):
    services = _services(str(tmp_path))
    chat_key = chat_key_for_room("arkham")
    for scope in ("story", "chars", "all"):
        await services.store.history_append(
            chat_key,
            "chat_history",
            [{"id": f"m-{scope}", "parent_id": None, "turn": 1, "role": "user", "content": "hi", "seq": 0}],
        )
        await capture(services, chat_key, turn=1)
        assert await available_turns(services, chat_key) == [1]

        await reset_room_state(services, chat_key, scope=scope)

        assert await services.store.history_rows(chat_key) == []
        assert await available_turns(services, chat_key) == []


async def test_reset_below_all_takes_the_chronicle_points_and_spares_the_module_ones(tmp_path):
    """b23c450's fix, now derived from the chronicle facet's declared vector lane."""
    services = _services(str(tmp_path))
    chat_key = chat_key_for_room("arkham")
    await services.vector_db.vector_store.upsert(
        [
            ("chronicle:1", [0.1] * 64, {"collection": "chronicle", "namespace": chat_key}),
            ("worldbook:1", [0.2] * 64, {"collection": "worldbook", "namespace": chat_key}),
            ("module:1", [0.3] * 64, {"chat_key": chat_key, "document_id": "m", "chunk_index": 0}),
        ]
    )

    result = await reset_room_state(services, chat_key, scope="story")

    assert result["vector_points"] == 1
    remaining = {point["id"] for point in await services.vector_db.vector_store.dump(filter={}, limit=100)}
    assert remaining == {"worldbook:1", "module:1"}

    assert (await reset_room_state(services, chat_key, scope="all"))["vector_points"] == 2
    assert await services.vector_db.vector_store.dump(filter={}, limit=100) == []


async def test_undo_cannot_reach_across_a_save_load(tmp_path):
    """The bundled fix: `import_room` clears the undo ring in the same transaction.

    Before M23 WS1 the ring survived the import, so `.undo` restored a snapshot of the
    room's PRE-import life over the state the keeper had just deliberately loaded.
    """
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")

    await services.store.state_set(chat_key, "game_clock", "saved-clock")
    exported = await export_room(services, keystore, "arkham", "checkpoint.json")

    # The room lives on: a later turn moves the clock and leaves a snapshot behind.
    await services.store.state_set(chat_key, "game_clock", "later-clock")
    await capture(services, chat_key, turn=7)
    assert await available_turns(services, chat_key) == [7]

    await import_room(services, keystore, exported["path"], expected_room="arkham")

    assert await services.store.state_get(chat_key, "game_clock") == "saved-clock"
    assert await available_turns(services, chat_key) == []
    assert await restore_room(services, chat_key, 7) is False
    assert await services.store.state_get(chat_key, "game_clock") == "saved-clock"


async def test_a_failed_import_puts_the_undo_ring_back(tmp_path, monkeypatch):
    """The ring is cleared by the import, so the import's own rollback must restore it.

    The failure is injected into the LAST leg (restoring the room's bearer keys), which
    runs after the store transaction that cleared the ring — exactly the window where an
    uncompensated new mutation would leave the room short of state it owned.
    """
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    await services.store.state_set(chat_key, "game_clock", "saved-clock")
    exported = await export_room(services, keystore, "arkham", "checkpoint.json")
    await services.store.state_set(chat_key, "game_clock", "later-clock")
    await capture(services, chat_key, turn=3)
    assert await available_turns(services, chat_key) == [3]

    monkeypatch.setattr(keystore, "restore", lambda *args, **kwargs: False)
    with pytest.raises(RuntimeError):
        await import_room(services, keystore, exported["path"], expected_room="arkham")

    assert await available_turns(services, chat_key) == [3]
    assert await services.store.state_get(chat_key, "game_clock") == "later-clock"


async def test_deleting_a_room_disposes_its_turn_lock(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    hub = RoomHub()
    hub.turn_lock(chat_key)
    assert chat_key in hub._turn_locks

    await delete_room_data(services, keystore, "arkham", hub=hub)

    assert chat_key not in hub._turn_locks


async def test_a_held_turn_lock_is_left_alone(tmp_path):
    """Replacing a lock a turn is inside would dissolve the serialization it exists for."""
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    hub = RoomHub()
    lock = hub.turn_lock(chat_key)

    async with lock:
        await delete_room_data(services, keystore, "arkham", hub=hub)
        assert hub.turn_lock(chat_key) is lock

    assert hub.dispose_room(chat_key) is True
    assert chat_key not in hub._turn_locks


async def test_deleting_a_room_without_a_hub_still_succeeds(tmp_path):
    """The CLI has no bus; a facet hook with nothing to reach must not fail the delete."""
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    await services.store.state_set(chat_key_for_room("arkham"), "game_clock", "x")

    result = await delete_room_data(services, keystore, "arkham")

    assert result["room"] == "arkham"


async def test_the_export_manifest_carries_every_section_a_facet_storage_names(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    from net.room_backup import EXPORT_SECTIONS

    exported = await export_room(services, keystore, "arkham", "manifest.json")
    snapshot = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))

    for section in EXPORT_SECTIONS.values():
        assert section in snapshot, f"the export manifest lost its {section!r} section"
