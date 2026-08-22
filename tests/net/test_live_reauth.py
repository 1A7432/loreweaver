"""Admin / room_backup live-reauth at the commit boundary.

A revoked keeper must not import or delete after the expensive preflight, and
a failed reauth must not create or overwrite a backup. The last successful
reauth is the linearization point.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from agent.services import build_services
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import FakeLLM
from infra.providers import MutableLLM
from infra.live_auth import (
    AuthorizationRevoked,
    confirm_live_authorization,
    invoke_reauthorize,
)
from net.admin import AdminService
from net.keystore import Keystore
from net.room_backup import chat_key_for_room, export_room


def _services(data_dir: str = "./data"):
    settings = Settings(
        locale="en",
        data_dir=data_dir,
        llm=LLMSettings(provider="openai", chat_model="gpt-4o"),
    )
    llm = MutableLLM(settings, builder=lambda s: FakeLLM(script=[]))
    return build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))


def _barrier(reached: asyncio.Event, release: asyncio.Event, keystore: Keystore, key: str):
    async def _reauthorize() -> bool:
        reached.set()
        await release.wait()
        entry = keystore.get(key, purpose=None)
        return entry is not None and entry.role == "keeper"

    return _reauthorize


async def _revoke_after_preflight(
    reached: asyncio.Event,
    release: asyncio.Event,
    keystore: Keystore,
    key: str,
) -> None:
    await reached.wait()
    keystore.remove(key)
    release.set()


async def test_invoke_reauthorize_accepts_sync_and_awaitable_and_fails_closed() -> None:
    assert await invoke_reauthorize(None) is True
    assert await invoke_reauthorize(None, missing_ok=False) is False
    assert await invoke_reauthorize(lambda: True) is True
    assert await invoke_reauthorize(lambda: False) is False

    async def _ok() -> bool:
        return True

    async def _no() -> bool:
        return False

    assert await invoke_reauthorize(_ok) is True
    assert await invoke_reauthorize(_no) is False

    def _boom() -> bool:
        raise RuntimeError("refresh failed")

    assert await invoke_reauthorize(_boom) is False
    assert await invoke_reauthorize("not-callable") is False

    try:
        await confirm_live_authorization(lambda: False)
    except AuthorizationRevoked as exc:
        assert str(exc) == ""
    else:
        raise AssertionError("expected AuthorizationRevoked")


async def test_admin_import_live_reauth_after_preflight_leaves_room_unchanged(tmp_path) -> None:
    services = _services(str(tmp_path))
    keystore = Keystore()
    room = "arkham"
    caller = keystore.add(room=room, role="keeper", name="Keeper")
    chat_key = chat_key_for_room(room)
    await services.store.state_set(chat_key, "scene", "the docks")
    await services.documents.put(chat_key, "note", "log", {"category": "log", "content": "checkpoint"})
    exported = await export_room(services, keystore, room, "checkpoint")
    await services.store.state_set(chat_key, "scene", "OVERWRITTEN")
    await services.documents.put(chat_key, "note", "log", {"category": "log", "content": "live"})

    reached = asyncio.Event()
    release = asyncio.Event()
    admin = AdminService(services, keystore)
    task = asyncio.create_task(
        admin.dispatch(
            "keeper",
            room,
            {"type": "admin_import_room", "path": Path(exported["path"]).name},
            get_i18n("en"),
            reauthorize=_barrier(reached, release, keystore, caller),
        )
    )
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply["type"] == "admin_error"
    assert reply["code"] == "forbidden"
    assert reply["message"] == get_i18n("en").t("tui.admin.error.forbidden")
    assert exported["path"] not in reply["message"]
    assert await services.store.state_get(chat_key, "scene") == "OVERWRITTEN"
    note = await services.documents.get(chat_key, "note", "log")
    assert note is not None and note.data.get("content") == "live"


async def test_admin_delete_live_reauth_after_preflight_leaves_storage_and_skips_backup(
    tmp_path,
) -> None:
    services = _services(str(tmp_path))
    keystore = Keystore()
    room = "arkham"
    caller = keystore.add(room=room, role="keeper", name="Keeper")
    backup_keeper = keystore.add(room=room, role="keeper", name="Other")
    chat_key = chat_key_for_room(room)
    await services.store.state_set(chat_key, "scene", "the docks")
    await services.documents.put(chat_key, "lore", "l1", {"title": "Secret", "content": "do not leak"})
    backups_before = set((tmp_path / "room_backups").glob("**/*")) if (tmp_path / "room_backups").exists() else set()

    reached = asyncio.Event()
    release = asyncio.Event()
    admin = AdminService(services, keystore)
    task = asyncio.create_task(
        admin.dispatch(
            "keeper",
            room,
            {"type": "admin_delete_room_data", "room": room, "backup": True, "path": "must-not-write"},
            get_i18n("en"),
            reauthorize=_barrier(reached, release, keystore, caller),
        )
    )
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply["type"] == "admin_error"
    assert reply["code"] == "forbidden"
    assert reply["message"] == get_i18n("en").t("tui.admin.error.forbidden")
    assert "must-not-write" not in reply["message"]
    assert "do not leak" not in reply["message"]
    assert await services.store.state_get(chat_key, "scene") == "the docks"
    lore = await services.documents.get(chat_key, "lore", "l1")
    assert lore is not None and lore.data.get("content") == "do not leak"
    assert keystore.get(backup_keeper, purpose=None) is not None
    backups_after = set((tmp_path / "room_backups").glob("**/*")) if (tmp_path / "room_backups").exists() else set()
    new_files = {path for path in backups_after - backups_before if path.is_file()}
    assert new_files == set()


async def test_admin_delete_without_backup_live_reauth_leaves_storage_unchanged(tmp_path) -> None:
    services = _services(str(tmp_path))
    keystore = Keystore()
    room = "arkham"
    caller = keystore.add(room=room, role="keeper", name="Keeper")
    spare = keystore.add(room=room, role="keeper", name="Spare")
    chat_key = chat_key_for_room(room)
    await services.store.state_set(chat_key, "scene", "the docks")
    await services.documents.put(chat_key, "lore", "l1", {"title": "Secret", "content": "keep"})

    reached = asyncio.Event()
    release = asyncio.Event()
    admin = AdminService(services, keystore)
    task = asyncio.create_task(
        admin.dispatch(
            "keeper",
            room,
            {"type": "admin_delete_room_data", "room": room, "backup": False},
            get_i18n("en"),
            reauthorize=_barrier(reached, release, keystore, caller),
        )
    )
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply["type"] == "admin_error"
    assert reply["code"] == "forbidden"
    assert await services.store.state_get(chat_key, "scene") == "the docks"
    lore = await services.documents.get(chat_key, "lore", "l1")
    assert lore is not None and lore.data.get("content") == "keep"
    assert keystore.get(spare, purpose=None) is not None


async def test_admin_export_live_reauth_before_write_does_not_create_file(tmp_path) -> None:
    services = _services(str(tmp_path))
    keystore = Keystore()
    room = "arkham"
    caller = keystore.add(room=room, role="keeper", name="Keeper")
    chat_key = chat_key_for_room(room)
    await services.store.state_set(chat_key, "scene", "secret docks")

    reached = asyncio.Event()
    release = asyncio.Event()
    admin = AdminService(services, keystore)
    task = asyncio.create_task(
        admin.dispatch(
            "keeper",
            room,
            {"type": "admin_export_room", "room": room, "path": "must-not-write"},
            get_i18n("en"),
            reauthorize=_barrier(reached, release, keystore, caller),
        )
    )
    await _revoke_after_preflight(reached, release, keystore, caller)
    reply = await task

    assert reply["type"] == "admin_error"
    assert reply["code"] == "forbidden"
    leftovers = list((tmp_path / "room_backups").glob("**/must-not-write.json")) if (tmp_path / "room_backups").exists() else []
    assert leftovers == []
    assert "must-not-write" not in reply["message"]
    assert "secret docks" not in reply["message"]
