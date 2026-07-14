"""Tests for room binding + the `.room` command family (M7 §4).

`resolve_session_key` maps a channel to its shared session (default vs bound),
and the `.room` handlers (driven here through a real `CommandRouter` + an
in-memory `Store`) set/emit those bindings and mint terminal join keys.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.hub import RoomHub
from gateway.rooms import (
    get_binding,
    resolve_session_key,
    session_key_for_room,
    set_keeper_binding,
)
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import FakeLLM
from net.keystore import Keystore


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _router(services, *, keystore=None, hub=None) -> CommandRouter:
    # NB: an empty Keystore is falsy (len 0), so default with `is None`, not `or`.
    return CommandRouter(
        services,
        keystore=Keystore() if keystore is None else keystore,
        hub=RoomHub() if hub is None else hub,
    )


def _admin_ctx(source: SessionSource) -> AgentCtx:
    # Network transports only gain Keeper commands after chat_bind authentication.
    return AgentCtx(
        chat_key=source.chat_key(),
        user_id=source.user_key(),
        platform=source.platform,
        locale="en",
        extra={"source": source, "raw": {}, "role": "keeper"},
    )


async def test_resolve_session_key_default_then_bound() -> None:
    services = _services()
    source = SessionSource(platform="discord", chat_type="group", chat_id="c-1", user_id="u-1")

    # unbound: a channel is its own private session
    assert await resolve_session_key(services.store, source) == source.chat_key()

    # bound: it resolves to the shared session id instead
    await services.store.set(
        user_key="", store_key=f"bound_room.{source.chat_key()}", value="tui:group:room-x"
    )
    assert await resolve_session_key(services.store, source) == "tui:group:room-x"


async def test_direct_keeper_identity_resolves_without_a_second_channel_binding() -> None:
    services = _services()
    source = SessionSource(
        platform="discord", chat_type="dm", chat_id="dm-1", user_id="keeper-1"
    )

    await set_keeper_binding(services.store, "discord", "keeper-1", "arkham")

    assert await get_binding(services.store, source.chat_key()) is None
    assert await resolve_session_key(services.store, source) == session_key_for_room(
        "arkham"
    )


async def test_room_open_mints_join_key_and_binds_channel() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    source = SessionSource(platform="discord", chat_type="dm", chat_id="c-1", user_id="u-1")

    reply = await router.dispatch(_admin_ctx(source), ".room open")

    assert reply is not None
    assert len(keystore) == 1
    entry = keystore.entries()[0]
    expected_session = session_key_for_room(entry.room)
    # the reply hands out the terminal join key + the shared session id
    assert entry.key in reply and expected_session in reply
    # and this channel is now bound to that same terminal session
    assert await get_binding(services.store, source.chat_key()) == expected_session


async def test_room_link_by_join_key_binds_to_that_rooms_session() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    join_key = keystore.add(room="blackmoor")
    source = SessionSource(platform="discord", chat_type="dm", chat_id="c-2", user_id="u-2")
    ctx = _admin_ctx(source)

    # link by a keystore join key -> the terminal session for that key's room
    await router.dispatch(ctx, f".room link {join_key}")
    assert await get_binding(services.store, source.chat_key()) == session_key_for_room("blackmoor")


async def test_room_link_refuses_arbitrary_session_id_and_does_not_bind_or_leak() -> None:
    # Regression (cross-session hijack): `.room link` must accept ONLY a valid keystore
    # join key. A raw/guessable session id is refused outright — no binding is written,
    # so the caller cannot alias their channel onto (and then read/eavesdrop) a foreign
    # session.
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    source = SessionSource(platform="discord", chat_type="dm", chat_id="c-2b", user_id="u-2b")
    ctx = _admin_ctx(source)

    victim_session = SessionSource(platform="discord", chat_type="group", chat_id="VICTIMGROUP").chat_key()
    reply = await router.dispatch(ctx, f".room link {victim_session}")

    assert reply == get_i18n("en").t("rooms.link.invalid_key")
    assert await get_binding(services.store, source.chat_key()) is None
    # It still resolves only to its OWN session, never the victim's.
    assert await resolve_session_key(services.store, source) == source.chat_key()


async def test_room_leave_clears_binding() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    join_key = keystore.add(room="leave-room")
    source = SessionSource(platform="discord", chat_type="dm", chat_id="c-3", user_id="u-3")
    ctx = _admin_ctx(source)

    await router.dispatch(ctx, f".room link {join_key}")
    assert await get_binding(services.store, source.chat_key()) == session_key_for_room("leave-room")

    await router.dispatch(ctx, ".room leave")
    assert await get_binding(services.store, source.chat_key()) is None


async def test_room_show_reports_binding_and_online_members() -> None:
    services = _services()
    hub = RoomHub()
    keystore = Keystore()
    router = _router(services, keystore=keystore, hub=hub)
    join_key = keystore.add(room="shared-room")
    source = SessionSource(platform="discord", chat_type="dm", chat_id="c-5", user_id="u-5")
    ctx = _admin_ctx(source)

    assert get_i18n("en").t("rooms.show.none") in (await router.dispatch(ctx, ".room"))

    await router.dispatch(ctx, f".room link {join_key}")
    shown = await router.dispatch(ctx, ".room")
    assert session_key_for_room("shared-room") in shown


async def test_room_command_is_gated_from_ordinary_group_members() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    # a plain group member (no admin marker in raw) is not privileged
    source = SessionSource(platform="discord", chat_type="group", chat_id="c-4", user_id="u-4")
    ctx = AgentCtx(
        chat_key=source.chat_key(),
        user_id=source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {}},
    )

    reply = await router.dispatch(ctx, ".room open")

    assert reply == get_i18n("en").t("rooms.denied")
    assert len(keystore) == 0  # nothing minted
    assert await get_binding(services.store, source.chat_key()) is None  # nothing bound


async def test_room_open_rejects_platform_admin_marker_without_keeper_binding() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    source = SessionSource(platform="discord", chat_type="group", chat_id="c-6", user_id="u-6")
    ctx = AgentCtx(
        chat_key=source.chat_key(),
        user_id=source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {"is_admin": True}},
    )

    reply = await router.dispatch(ctx, ".room open")
    assert reply == get_i18n("en").t("rooms.denied")
    assert await get_binding(services.store, source.chat_key()) is None


async def test_room_link_key_can_explicitly_link_a_group() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    join_key = keystore.add(room="group-room")
    source = SessionSource(platform="discord", chat_type="group", chat_id="c-7", user_id="u-7")
    ctx = AgentCtx(
        chat_key=source.chat_key(),
        user_id=source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {}},
    )

    await router.dispatch(ctx, f".room link {join_key}")

    assert await get_binding(services.store, source.chat_key()) == session_key_for_room("group-room")


async def test_private_interaction_can_open_a_room_from_a_group() -> None:
    services = _services()
    keystore = Keystore()
    router = _router(services, keystore=keystore)
    source = SessionSource(platform="discord", chat_type="group", chat_id="c-8", user_id="keeper")
    ctx = AgentCtx(
        chat_key=source.chat_key(),
        user_id=source.user_key(),
        platform="discord",
        locale="en",
        extra={
            "source": source,
            "raw": {},
            "role": "keeper",
            "private_interaction": True,
        },
    )

    reply = await router.dispatch(ctx, ".room open")

    assert keystore.entries()[0].key in reply
