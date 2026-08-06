"""`.reset [chars|all]` — in-place campaign restart at three scopes.

The feedback that shaped this: a dead campaign should restart WITHOUT forcing a
wipe of the character sheets and the loaded module. So `.reset` (default) clears
only the story/progress; `.reset chars` also rolls new characters but keeps the
module; `.reset all` erases everything. Room settings (language, house rules,
enabled skills), keystore keys, `bound_room.*` wiring and other rooms always
survive.

M17: content lives in per-room documents and runtime state in room_state, so
seeding/assertions go through those layers; reset scopes map to document TYPES
plus room_state keys.
"""

import time

from agent.context import AgentCtx
from agent.services import build_services
from core.character_manager import CharacterSheet
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


class _FakeMember:
    transport = "tui"

    def __init__(self, member_id: str) -> None:
        self.id = member_id
        self.user_key = f"user:{member_id}"
        self.name = member_id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _services(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


async def _seed_room(services, chat_key: str) -> None:
    store = services.store
    docs = services.documents
    # Story/progress.
    await store.state_set(chat_key, "chat_history", '[{"role":"user","content":"hi"}]')
    await docs.put(chat_key, "note", "clue_log", {"category": "clue_log", "content": "the attic"})
    await docs.put_singleton(chat_key, "scene", {"name": "Attic"})
    await store.state_set(chat_key, "initiative", '{"order":["Ada"]}')
    # Characters.
    await services.characters.save_character("u1", chat_key, CharacterSheet("Ada", "CoC"))
    # Module + lore.
    await docs.put_singleton(chat_key, "module_pool", {"keeper": {}, "player": {"summary": "old story"}})
    await docs.put(chat_key, "lore", "e1", {"title": "Secret", "content": "x"})
    # Room settings (must survive every scope).
    await store.state_set(chat_key, "rule_variant", "rule2")
    await store.state_set(chat_key, "chat_locale", "zh")
    await store.state_set(chat_key, "skills_enabled", '["mature-mode"]')


async def _settings_survive(services, chat_key):
    assert await services.store.state_get(chat_key, "rule_variant") == "rule2"
    assert await services.store.state_get(chat_key, "chat_locale") == "zh"
    assert await services.store.state_get(chat_key, "skills_enabled") == '["mature-mode"]'


async def test_reset_story_default_keeps_characters_module_and_settings(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t1"
    other = "cli:dm:other"
    await _seed_room(services, chat_key)
    await services.store.state_set(other, "chat_history", "[]")
    await services.store.set(user_key="", store_key="bound_room.discord:group:pub", value=chat_key)

    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")
    armed = await router.dispatch(ctx, ".reset")
    assert armed is not None and "reset confirm" in armed and not armed.startswith("Reset complete")
    assert await services.documents.get(chat_key, "note", "clue_log") is not None  # arming touches nothing

    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("Reset complete")

    # Story is gone...
    assert await services.store.state_get(chat_key, "chat_history") is None
    assert await services.documents.get(chat_key, "note", "clue_log") is None
    assert await services.documents.get_singleton(chat_key, "scene") is None
    assert await services.store.state_get(chat_key, "initiative") is None
    # ...but characters, module, lore and settings all stay.
    assert await services.documents.get(chat_key, "sheet", "Ada") is not None
    assert await services.store.state_get(chat_key, "active_character.u1") == "Ada"
    assert await services.documents.get_singleton(chat_key, "module_pool") is not None
    assert await services.documents.get(chat_key, "lore", "e1") is not None
    await _settings_survive(services, chat_key)
    # Wiring, unrelated rooms, and the consumed pending marker.
    assert await services.store.get(user_key="", store_key="bound_room.discord:group:pub") == chat_key
    assert await services.store.state_get(other, "chat_history") == "[]"
    assert await services.store.state_get(chat_key, "reset_pending") is None


async def test_reset_chars_also_wipes_characters_but_keeps_module(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t2"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    assert (await router.dispatch(ctx, ".reset chars")) is not None
    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("Reset complete")

    # Story AND characters gone...
    assert await services.store.state_get(chat_key, "chat_history") is None
    assert await services.documents.get(chat_key, "sheet", "Ada") is None
    assert await services.store.state_get(chat_key, "active_character.u1") is None
    # ...module, lore and settings kept.
    assert await services.documents.get_singleton(chat_key, "module_pool") is not None
    assert await services.documents.get(chat_key, "lore", "e1") is not None
    await _settings_survive(services, chat_key)


async def test_reset_all_wipes_module_and_lore_but_never_settings(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t3"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    assert (await router.dispatch(ctx, ".reset all")) is not None
    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("Reset complete")

    assert await services.store.state_get(chat_key, "chat_history") is None
    assert await services.documents.get(chat_key, "sheet", "Ada") is None
    assert await services.documents.get_singleton(chat_key, "module_pool") is None
    assert await services.documents.get(chat_key, "lore", "e1") is None
    assert await services.documents.list(chat_key) == []
    # Room settings survive even a full reset.
    await _settings_survive(services, chat_key)


async def test_reset_confirm_without_arming_shows_usage_and_wipes_nothing(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t4"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    reply = await router.dispatch(ctx, ".reset confirm")
    assert reply is not None and not reply.startswith("Reset complete")
    assert await services.documents.get(chat_key, "note", "clue_log") is not None


async def test_reset_stale_confirm_shows_usage_and_wipes_nothing(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t5"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    await router.dispatch(ctx, ".reset")
    # A pending marker older than the confirm window (correctly shaped `<ts>:<scope>`).
    await services.store.state_set(chat_key, "reset_pending", f"{time.time() - 3600}:story")
    reply = await router.dispatch(ctx, ".reset confirm")
    assert reply is not None and not reply.startswith("Reset complete")
    assert await services.documents.get(chat_key, "note", "clue_log") is not None


async def test_reset_denied_for_networked_player(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "tui:group:room-1"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", extra={"role": "player"})

    assert await router.dispatch(ctx, ".reset") == "Only the keeper can reset the campaign."
    assert await router.dispatch(ctx, ".reset all") == "Only the keeper can reset the campaign."
    assert await router.dispatch(ctx, ".reset confirm") == "Only the keeper can reset the campaign."
    assert await services.documents.get(chat_key, "note", "clue_log") is not None


async def test_reset_zh_alias_and_scope_words(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "tui:group:room-2"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="zh", extra={"role": "keeper"})

    # `.重开 全部` arms the full-wipe scope in Chinese.
    armed = await router.dispatch(ctx, ".重开 全部")
    assert armed is not None and "reset confirm" in armed
    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("重置完成")
    assert await services.documents.get(chat_key, "note", "clue_log") is None
    assert await services.documents.get_singleton(chat_key, "module_pool") is None  # `全部` reached module scope


async def test_reset_confirm_pushes_a_reset_flagged_state_frame(tmp_path):
    # Regression for the "panel + chat log stay stale until the next message" report:
    # the wipe must proactively broadcast a fresh state frame flagged reset=True so
    # connected clients refresh their panel and drop their local scrollback at once.
    services = _services(tmp_path)
    hub = RoomHub()
    chat_key = "tui:group:room-3"
    member = _FakeMember("k1")
    await hub.subscribe(chat_key, member)
    router = CommandRouter(services, hub=hub)
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="en", extra={"role": "keeper"})

    await router.dispatch(ctx, ".reset")
    member.events.clear()  # only care about what the confirm publishes
    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("Reset complete")

    state_events = [e for e in member.events if e.kind == "state"]
    assert state_events, "reset confirm must broadcast a state frame"
    assert state_events[-1].data.get("reset") is True
