"""Deterministic races: a revoked keeper must not mutate after a long preflight.

The transport choke point refreshes authorization when it takes the room lock.
These tests pause at the later commit boundary (after availability / snapshot
parse, before reset/restore/import/export write), revoke the key on another
task, then release — the operation must fail closed.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from agent.chronicle import CHRONICLE_TURN_KEY, chronicle_turn
from agent.context import AgentCtx, LocalFs
from agent.history import append_turn, load_chain
from agent.services import build_services
from agent.undo import capture
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import FakeLLM
from net.keystore import Keystore
from net.room_backup import chat_key_for_room, export_room


def _services(tmp_path: Path | None = None):
    settings = Settings(locale="en", data_dir=str(tmp_path) if tmp_path else "./data")
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _barrier(reached: asyncio.Event, release: asyncio.Event, keystore: Keystore, key: str):
    async def _reauthorize() -> bool:
        reached.set()
        await release.wait()
        entry = keystore.get(key, purpose=None)
        return entry is not None and entry.role == "keeper"

    return _reauthorize


def _keeper_ctx(
    chat_key: str,
    *,
    reauthorize,
    fs=None,
    extra: dict | None = None,
) -> AgentCtx:
    payload = {"role": "keeper", "reauthorize": reauthorize}
    if extra:
        payload.update(extra)
    return AgentCtx(
        chat_key=chat_key,
        user_id="kp",
        platform="tui",
        locale="en",
        fs=fs,
        extra=payload,
    )


async def _revoke_after_preflight(
    reached: asyncio.Event,
    release: asyncio.Event,
    keystore: Keystore,
    key: str,
) -> None:
    await reached.wait()
    keystore.remove(key)
    release.set()


async def test_undo_live_reauth_after_preflight_leaves_the_room_unchanged() -> None:
    services = _services()
    keystore = Keystore()
    caller = keystore.add(room="undo-race", role="keeper")
    chat_key = "undo-race"
    await append_turn(services, chat_key, "chat_history", user_message="one", reply="1", turn=1)
    await services.store.state_set(chat_key, CHRONICLE_TURN_KEY, "1")
    await services.documents.put(chat_key, "note", "log", {"category": "log", "content": "before"})
    await capture(services, chat_key, 1)

    reached = asyncio.Event()
    release = asyncio.Event()
    router = CommandRouter(services)
    ctx = _keeper_ctx(chat_key, reauthorize=_barrier(reached, release, keystore, caller))

    task = asyncio.create_task(router.dispatch(ctx, ".undo 1"))
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply == get_i18n("en").t("commands.undo.denied")
    assert await chronicle_turn(services.store, chat_key) == 1
    note = await services.documents.get(chat_key, "note", "log")
    assert note is not None and note.data.get("content") == "before"
    assert [message["content"] for message in await load_chain(services, chat_key, "chat_history")] == [
        "one",
        "1",
    ]


async def test_save_load_live_reauth_after_preflight_leaves_storage_unchanged(tmp_path) -> None:
    services = _services(tmp_path)
    keystore = Keystore()
    room = "save-load-race"
    caller = keystore.add(room=room, role="keeper")
    chat_key = chat_key_for_room(room)
    await services.store.state_set(chat_key, "scene", "the docks")
    await services.documents.put(chat_key, "note", "log", {"category": "log", "content": "checkpoint"})
    exported = await export_room(services, keystore, room, "checkpoint")
    await services.store.state_set(chat_key, "scene", "OVERWRITTEN")
    await services.documents.put(chat_key, "note", "log", {"category": "log", "content": "live"})

    reached = asyncio.Event()
    release = asyncio.Event()
    router = CommandRouter(services, keystore=keystore)
    ctx = _keeper_ctx(chat_key, reauthorize=_barrier(reached, release, keystore, caller))

    task = asyncio.create_task(router.dispatch(ctx, ".save load checkpoint"))
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply == get_i18n("en").t("commands.save.denied")
    assert Path(exported["path"]).is_file()
    assert await services.store.state_get(chat_key, "scene") == "OVERWRITTEN"
    note = await services.documents.get(chat_key, "note", "log")
    assert note is not None and note.data.get("content") == "live"


async def test_save_export_live_reauth_before_write_does_not_create_or_overwrite(tmp_path) -> None:
    services = _services(tmp_path)
    keystore = Keystore()
    room = "save-export-race"
    caller = keystore.add(room=room, role="keeper")
    chat_key = chat_key_for_room(room)
    await services.store.state_set(chat_key, "scene", "secret docks")
    existing = await export_room(services, keystore, room, "named")
    original = Path(existing["path"]).read_bytes()

    reached = asyncio.Event()
    release = asyncio.Event()
    router = CommandRouter(services, keystore=keystore)
    ctx = _keeper_ctx(chat_key, reauthorize=_barrier(reached, release, keystore, caller))

    task = asyncio.create_task(router.dispatch(ctx, ".save named"))
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply == get_i18n("en").t("commands.save.denied")
    assert Path(existing["path"]).read_bytes() == original
    assert "secret docks" not in reply
    assert existing["path"] not in (reply or "")


async def test_import_world_live_reauth_after_parse_writes_nothing(tmp_path) -> None:
    services = _services(tmp_path)
    keystore = Keystore()
    caller = keystore.add(room="world-race", role="keeper")
    chat_key = "tui:group:world-race"
    card = {
        "name": "Manor",
        "extensions": {"loreweaver_hooks": ["on('turn_start', () => {});"]},
        "character_book": {"entries": [{"comment": "[InitVar]", "content": '{"真凶": ["butler", "t"]}'}]},
    }
    (tmp_path / "w.json").write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")

    reached = asyncio.Event()
    release = asyncio.Event()
    router = CommandRouter(services)
    ctx = _keeper_ctx(
        chat_key,
        reauthorize=_barrier(reached, release, keystore, caller),
        fs=LocalFs(str(tmp_path)),
        extra={"attachment_names": ["w.json"]},
    )

    task = asyncio.create_task(router.dispatch(ctx, ".import world"))
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply == get_i18n("en").t("charcard.commands.import.world_denied")
    assert await services.store.state_get(chat_key, "world_import") is None
    assert await services.store.state_get(chat_key, "room_hooks") is None


def _tui_keeper_without_callback(chat_key: str, **kwargs) -> AgentCtx:
    return AgentCtx(
        chat_key=chat_key,
        user_id="kp",
        platform="tui",
        locale="en",
        extra={"role": "keeper"},
        **kwargs,
    )


async def test_tui_keeper_without_reauthorize_callback_is_denied() -> None:
    """A stamped keeper role on a network platform is not enough: no live callback
    means the key cannot be re-checked, so the commit must fail closed."""
    services = _services()
    router = CommandRouter(services, keystore=Keystore())
    i18n = get_i18n("en")
    chat_key = "tui:group:no-callback"

    reset = await router.dispatch(_tui_keeper_without_callback(chat_key), ".reset")
    assert reset == i18n.t("commands.reset.denied")
    assert await services.store.state_get(chat_key, "reset_pending") is None

    model = await router.dispatch(_tui_keeper_without_callback(chat_key), ".model")
    assert model == i18n.t("commands.model.denied")

    await append_turn(services, chat_key, "chat_history", user_message="one", reply="1", turn=1)
    await services.store.state_set(chat_key, CHRONICLE_TURN_KEY, "1")
    await capture(services, chat_key, 1)
    undo = await router.dispatch(_tui_keeper_without_callback(chat_key), ".undo 1")
    assert undo == i18n.t("commands.undo.denied")
    assert await chronicle_turn(services.store, chat_key) == 1

    save = await router.dispatch(_tui_keeper_without_callback(chat_key), ".save named")
    assert save == i18n.t("commands.save.denied")


async def test_tui_keeper_without_callback_cannot_import_world(tmp_path) -> None:
    services = _services(tmp_path)
    router = CommandRouter(services)
    chat_key = "tui:group:world-no-callback"
    (tmp_path / "w.json").write_text(json.dumps({"name": "Manor"}), encoding="utf-8")
    ctx = AgentCtx(
        chat_key=chat_key,
        user_id="kp",
        platform="tui",
        locale="en",
        fs=LocalFs(str(tmp_path)),
        extra={"role": "keeper", "attachment_names": ["w.json"]},
    )

    reply = await router.dispatch(ctx, ".import world")

    assert reply == get_i18n("en").t("charcard.commands.import.world_denied")
    assert await services.store.state_get(chat_key, "world_import") is None


async def test_module_upload_reauths_after_progress_immediately_before_store(tmp_path, monkeypatch) -> None:
    """Progress emit may await; the live check must sit against store_document, not before it."""
    from agent.kp_tools_knowledge import DocumentTools

    services = _services(tmp_path)
    (tmp_path / "mod.txt").write_text("The marsh holds a secret.", encoding="utf-8")
    order: list[str] = []
    stored = False

    async def _progress(stage: str, detail: str = "") -> None:
        order.append(f"progress:{stage}")
        await asyncio.sleep(0)

    async def _reauthorize() -> bool:
        order.append("reauth")
        return False

    async def _store_document(**kwargs):
        nonlocal stored
        stored = True
        order.append("store")
        return 1

    monkeypatch.setattr(services.vector_db, "store_document", _store_document)
    ctx = AgentCtx(
        chat_key="tui:group:module-order",
        user_id="kp",
        platform="tui",
        locale="en",
        fs=LocalFs(str(tmp_path)),
        extra={"role": "keeper", "reauthorize": _reauthorize},
    )

    reply = await DocumentTools(services).upload_document(
        ctx, file_path="mod.txt", doc_type="module", progress=_progress
    )

    assert reply == get_i18n("en").t("rooms.denied")
    assert stored is False
    assert order == ["progress:read", "progress:embed", "reauth"]
