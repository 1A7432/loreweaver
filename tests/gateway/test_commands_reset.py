"""`.reset` — in-place campaign restart (wipe room state, keep keys/bindings).

The feedback scenario this covers: a solo table whose campaign died wants a new
character and a new module without re-provisioning the server. The wipe reuses
`net.room_backup`'s room-state vocabulary, so anything a room backup would
capture is cleared, while keystore keys, `bound_room.*` wiring and other rooms
survive untouched.
"""

import time

from agent.context import AgentCtx
from agent.services import build_services
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


async def _seed_room(services, chat_key: str) -> None:
    store = services.store
    await store.set(user_key="", store_key=f"chat_history.{chat_key}", value='[{"role":"user","content":"hi"}]')
    await store.set(user_key="u1", store_key=f"characters.{chat_key}.Ada", value='{"name":"Ada"}')
    await store.set(user_key="u1", store_key=f"active_character.{chat_key}", value="Ada")
    await store.set(user_key="", store_key=f"module_player_pool.{chat_key}", value='{"summary":"old story"}')
    await store.set(user_key="", store_key=f"kp_notes.{chat_key}", value='{"current_scene":"Attic"}')
    await store.set(user_key="", store_key=f"initiative.{chat_key}", value='{"order":["Ada"]}')
    await store.set(user_key="", store_key=f"worldbook.{chat_key}.e1", value='{"title":"Secret"}')
    await store.set(user_key="", store_key=f"worldbook_index.{chat_key}", value='["e1"]')


async def test_reset_two_step_wipes_room_and_keeps_wiring(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t1"
    other = "cli:dm:other"
    await _seed_room(services, chat_key)
    await services.store.set(user_key="", store_key=f"chat_history.{other}", value="[]")
    # A channel linked into this room: reset must NOT unbind it.
    await services.store.set(user_key="", store_key="bound_room.discord:group:pub", value=chat_key)

    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")
    armed = await router.dispatch(ctx, ".reset")
    assert armed is not None and "reset confirm" in armed
    # Still intact after arming.
    assert await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}") is not None

    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("Campaign reset")

    for user_key, store_key in [
        ("", f"chat_history.{chat_key}"),
        ("u1", f"characters.{chat_key}.Ada"),
        ("u1", f"active_character.{chat_key}"),
        ("", f"module_player_pool.{chat_key}"),
        ("", f"kp_notes.{chat_key}"),
        ("", f"initiative.{chat_key}"),
        ("", f"worldbook.{chat_key}.e1"),
        ("", f"worldbook_index.{chat_key}"),
    ]:
        assert await services.store.get(user_key=user_key, store_key=store_key) is None, store_key
    # Wiring and unrelated rooms survive.
    assert await services.store.get(user_key="", store_key="bound_room.discord:group:pub") == chat_key
    assert await services.store.get(user_key="", store_key=f"chat_history.{other}") == "[]"
    # The pending-confirm marker is consumed.
    assert await services.store.get(user_key="", store_key=f"reset_pending.{chat_key}") is None


async def test_reset_confirm_without_arming_only_arms(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t2"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    first = await router.dispatch(ctx, ".reset confirm")
    assert first is not None and "reset confirm" in first and not first.startswith("Campaign reset")
    assert await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}") is not None

    second = await router.dispatch(ctx, ".reset confirm")
    assert second is not None and second.startswith("Campaign reset")
    assert await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}") is None


async def test_reset_stale_confirm_rearms_instead_of_wiping(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "cli:dm:t3"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    await router.dispatch(ctx, ".reset")
    stale = str(time.time() - 3600)
    await services.store.set(user_key="", store_key=f"reset_pending.{chat_key}", value=stale)
    reply = await router.dispatch(ctx, ".reset confirm")
    assert reply is not None and not reply.startswith("Campaign reset")
    assert await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}") is not None


async def test_reset_denied_for_networked_player(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "tui:group:room-1"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", extra={"role": "player"})

    reply = await router.dispatch(ctx, ".reset")
    assert reply == "Only the keeper can reset the campaign."
    reply = await router.dispatch(ctx, ".reset confirm")
    assert reply == "Only the keeper can reset the campaign."
    assert await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}") is not None


async def test_reset_allowed_for_tui_keeper_and_zh_alias(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "tui:group:room-2"
    await _seed_room(services, chat_key)
    ctx = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="zh", extra={"role": "keeper"})

    armed = await router.dispatch(ctx, ".重开")
    assert armed is not None and "reset confirm" in armed
    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("战役已重置")
    assert await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}") is None
