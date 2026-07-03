"""Keeper-gated admin surface for the networked TUI (see `docs/protocol.md`).

The `net.tui_server.TuiServer` routes the v1.1 `admin_*` frames here. A keeper
holds an admin gate BY CONSTRUCTION: the keystore role stamped on the connection
at `join` decides it — a `keeper`-role connection may read/mutate the live LLM
config and mint/list room keys; anyone else gets `admin_error {code:"forbidden"}`.
There is no separate auth system.

Config/model handling REUSES the same primitives the `.model` chat command uses
(`infra.providers`: `is_known_provider`, `describe_settings`, `mask_secret`,
provider catalogs) and the shared `services.runtime_config`, so a switch made
here persists and hot-reconfigures the live `MutableLLM` exactly like
`.model set` -- every LLM consumer observes it without a restart.
"""

from __future__ import annotations

import hashlib
from typing import Any

from agent.services import Services
from infra.i18n import I18n
from infra.providers import (
    CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES,
    NATIVE_PROVIDER_NAMES,
    PRESETS,
    describe_settings,
    is_known_provider,
    list_models,
    mask_secret,
)
from net.keystore import Keystore
from net.room_backup import delete_room_data, export_room, import_room

# The client -> server admin request frames this module answers.
_ADMIN_REQUESTS: frozenset[str] = frozenset(
    {
        "admin_get_config",
        "admin_set_model",
        "admin_list_models",
        "admin_list_keys",
        "admin_mint_key",
        "admin_update_key",
        "admin_delete_key",
        "admin_delete_room",
        "admin_export_room",
        "admin_import_room",
        "admin_delete_room_data",
    }
)

_KEEPER_ROLE = "keeper"


def is_admin_frame(kind: Any) -> bool:
    """True if `kind` names one of the admin request frames handled here."""
    return isinstance(kind, str) and kind in _ADMIN_REQUESTS


async def handle_admin_frame(
    services: Services,
    keystore: Keystore,
    role: str,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    """Handle one admin request `frame`, returning the reply frame to send.

    Gated two ways: (1) every admin request requires a `keeper`-role connection;
    (2) the destructive / room-content ops (export/import/delete_room/
    delete_room_data) and the key mutations (update/delete_key) are scoped to the
    caller's OWN room (`caller_room`, the room the connecting keeper key is bound
    to) — a keeper cannot reach into another room's data or keys. Either gate
    failing yields `admin_error {code:"forbidden"}` and nothing is read or mutated.
    (Minting/listing keys stay deployment-global, matching their prior behavior.)
    """
    if role != _KEEPER_ROLE:
        return _error("forbidden", i18n)

    kind = frame.get("type")
    if kind == "admin_get_config":
        return await _config_frame(services)
    if kind == "admin_set_model":
        return await _set_model(services, frame, i18n)
    if kind == "admin_list_models":
        return await _list_models(services, frame, i18n)
    if kind == "admin_list_keys":
        return _keys_frame(keystore)
    if kind == "admin_mint_key":
        return _mint_key(keystore, frame, i18n)
    if kind == "admin_update_key":
        return _update_key(keystore, caller_room, frame, i18n)
    if kind == "admin_delete_key":
        return _delete_key(keystore, caller_room, frame, i18n)
    if kind == "admin_delete_room":
        return _delete_room(keystore, caller_room, frame, i18n)
    if kind == "admin_export_room":
        return await _export_room(services, keystore, caller_room, frame, i18n)
    if kind == "admin_import_room":
        return await _import_room(services, keystore, caller_room, frame, i18n)
    if kind == "admin_delete_room_data":
        return await _delete_room_data(services, keystore, caller_room, frame, i18n)
    return _error("bad_request", i18n)


# -- LLM config -------------------------------------------------------------


async def _config_frame(services: Services) -> dict[str, Any]:
    info = _describe_llm(services)
    overrides = await services.runtime_config.get()
    saved_providers = await services.llm_credentials.providers()
    return {
        "type": "admin_config",
        "provider": info["provider"],
        "chat_model": info["chat_model"],
        "base_url": info["base_url"],
        "api_key_masked": info["api_key"],
        "providers": _provider_names(),
        # Providers that already have a saved key — the model screen marks these 'ready' and
        # switching to one never re-asks for its key (see `_set_model`).
        "saved_providers": saved_providers,
        "override_active": bool(overrides),
    }


async def _set_model(services: Services, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    provider = str(frame.get("provider") or "").strip().casefold()
    if not provider or not is_known_provider(provider):
        return _error("unknown_provider", i18n)

    overrides: dict[str, str] = {"provider": provider}
    chat_model = str(frame.get("chat_model") or "").strip()
    if chat_model:
        overrides["chat_model"] = chat_model
    api_key = str(frame.get("api_key") or "").strip()
    base_url = str(frame.get("base_url") or "").strip()
    # Fall back to a previously-saved credential for this provider when the caller didn't supply
    # one, so switching back to a provider you've configured before doesn't re-ask for its key.
    saved = await services.llm_credentials.get(provider)
    if not api_key and saved.get("api_key"):
        api_key = saved["api_key"]
    if not base_url and saved.get("base_url"):
        base_url = saved["base_url"]
    if api_key:
        overrides["api_key"] = api_key
    if base_url:
        overrides["base_url"] = base_url

    # Reconfigure the LIVE LLM FIRST; persist only on success (mirrors gateway.commands._model_set):
    # a native provider with a missing SDK/key raises here, and persisting a bad override would also
    # brick the next `build_services()` boot. On failure, roll the live LLM back and persist nothing.
    current = await services.runtime_config.get()
    candidate = {**current, **overrides}
    try:
        _reconfigure_llm(services, candidate)
    except Exception:
        _reconfigure_llm(services, current)
        return _error("set_failed", i18n)
    await services.runtime_config.set(**overrides)
    # Remember this provider's credential so the next switch to it is frictionless.
    if api_key or base_url:
        await services.llm_credentials.remember(provider, api_key=api_key, base_url=base_url)
    return await _config_frame(services)


async def _list_models(services: Services, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    """Answer `admin_list_models` with the provider's LIVE model catalog (OpenAI `/models`).

    Resolves the credential to try in priority order: an api_key/base_url supplied on the
    frame (previewing before Save), else this provider's saved credential, else the current
    live config (only when it's the same provider). Unsupported/unreachable → `models: []`,
    which the client renders as a free-text model field."""
    live = getattr(services.llm, "settings", None)
    base_llm = live.llm if live is not None else services.settings.llm
    current_provider = (base_llm.provider or "openai").lower()
    provider = str(frame.get("provider") or "").strip().casefold() or current_provider
    if not is_known_provider(provider):
        return _error("unknown_provider", i18n)

    api_key = str(frame.get("api_key") or "").strip()
    base_url = str(frame.get("base_url") or "").strip()
    saved = await services.llm_credentials.get(provider)
    if not api_key:
        api_key = saved.get("api_key", "") or (base_llm.api_key if provider == current_provider else "")
    if not base_url:
        base_url = saved.get("base_url", "") or (base_llm.base_url if provider == current_provider else "")

    candidate = base_llm.model_copy(update={"provider": provider, "api_key": api_key, "base_url": base_url})
    models = await list_models(candidate)
    return {"type": "admin_models", "provider": provider, "models": models}


def _provider_names() -> list[str]:
    """Every provider `.model`/`is_known_provider` accepts: OpenAI-compatible
    presets first (sorted), then subscription-proxy aliases and native SDK providers."""
    return sorted(PRESETS) + list(CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES) + list(NATIVE_PROVIDER_NAMES)


def _describe_llm(services: Services) -> dict[str, str]:
    """The live LLM's display snapshot — from the `MutableLLM` if present, else
    from the (possibly injected) settings. Mirrors `gateway.commands._describe_llm`."""
    describe = getattr(services.llm, "describe", None)
    if callable(describe):
        return describe()
    return describe_settings(services.settings.llm)


def _reconfigure_llm(services: Services, overrides: dict[str, str]) -> bool:
    """Hot-reconfigure the `MutableLLM` if present (else the override is still
    persisted and applies on restart). Mirrors `gateway.commands._reconfigure_llm`."""
    apply = getattr(services.llm, "apply", None)
    if callable(apply):
        apply(overrides)
        return True
    return False


# -- room keys --------------------------------------------------------------


def _keys_frame(keystore: Keystore, *, minted: dict[str, str] | None = None) -> dict[str, Any]:
    keys = [
        {
            "id": _key_id(entry.key),
            "key_masked": mask_secret(entry.key),
            "room": entry.room,
            "name": entry.name,
            "role": entry.role,
        }
        for entry in keystore.entries()
    ]
    frame: dict[str, Any] = {"type": "admin_keys", "keys": keys}
    if minted is not None:
        frame["minted"] = minted
    return frame


def _key_id(key: str) -> str:
    """Stable, non-secret handle for admin mutations over the wire."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _resolve_key(keystore: Keystore, key_id: str) -> str | None:
    for entry in keystore.entries():
        if _key_id(entry.key) == key_id:
            return entry.key
    return None


def _mint_key(keystore: Keystore, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    room = str(frame.get("room") or "").strip()
    if not room:
        return _error("bad_request", i18n)
    name = str(frame.get("name") or "").strip()
    role = str(frame.get("role") or "player").strip()

    key = keystore.add(room=room, name=name, role=role)
    keystore.persist()  # write back to the keys file if one is configured (no-op in tests)
    entry = keystore.get(key)
    assert entry is not None  # just added
    # The full key travels once, here, so the keeper can copy it; list views mask.
    minted = {"key": key, "room": entry.room, "name": entry.name, "role": entry.role}
    return _keys_frame(keystore, minted=minted)


def _update_key(keystore: Keystore, caller_room: str, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    key_id = str(frame.get("id") or "").strip()
    key = _resolve_key(keystore, key_id)
    if key is None:
        return _error("not_found", i18n)
    entry = keystore.get(key)
    if entry is None or entry.room != caller_room:  # only the caller's own room's keys
        return _error("forbidden", i18n)

    updates: dict[str, str] = {}
    if "room" in frame:
        room = str(frame.get("room") or "").strip()
        if not room:
            return _error("bad_request", i18n)
        if room != caller_room:  # and never move a key OUT of the caller's room
            return _error("forbidden", i18n)
        updates["room"] = room
    if "name" in frame:
        updates["name"] = str(frame.get("name") or "").strip()
    if "role" in frame:
        role = str(frame.get("role") or "").strip()
        if role not in {"player", "keeper"}:
            return _error("bad_request", i18n)
        updates["role"] = role
    if not updates:
        return _error("bad_request", i18n)

    keystore.update(key, **updates)
    keystore.persist()
    return _keys_frame(keystore)


def _delete_key(keystore: Keystore, caller_room: str, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    key_id = str(frame.get("id") or "").strip()
    key = _resolve_key(keystore, key_id)
    if key is None:
        return _error("not_found", i18n)
    entry = keystore.get(key)
    if entry is None or entry.room != caller_room:  # only the caller's own room's keys
        return _error("forbidden", i18n)
    keystore.remove(key)
    keystore.persist()
    return _keys_frame(keystore)


def _delete_room(keystore: Keystore, caller_room: str, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    room = str(frame.get("room") or "").strip()
    if not room:
        return _error("bad_request", i18n)
    if room != caller_room:  # a keeper can only delete its OWN room
        return _error("forbidden", i18n)
    removed = keystore.remove_room(room)
    if removed <= 0:
        return _error("not_found", i18n)
    keystore.persist()
    return _keys_frame(keystore)


async def _export_room(
    services: Services,
    keystore: Keystore,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    room = str(frame.get("room") or "").strip()
    if not room:
        return _error("bad_request", i18n)
    if room != caller_room:  # a keeper can only export its OWN room
        return _error("forbidden", i18n)
    path = str(frame.get("path") or "").strip()
    try:
        return _room_op_frame("export", await export_room(services, keystore, room, path))
    except Exception:
        return _error("op_failed", i18n)


async def _import_room(
    services: Services,
    keystore: Keystore,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    path = str(frame.get("path") or "").strip()
    if not path:
        return _error("bad_request", i18n)
    # A named target room must be the caller's own; the snapshot is always imported INTO the
    # caller's room, and `import_room` additionally requires the file to be a backup OF it.
    room = str(frame.get("room") or "").strip()
    if room and room != caller_room:
        return _error("forbidden", i18n)
    try:
        return _room_op_frame(
            "import", await import_room(services, keystore, path, expected_room=caller_room)
        )
    except Exception:
        return _error("op_failed", i18n)


async def _delete_room_data(
    services: Services,
    keystore: Keystore,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    room = str(frame.get("room") or "").strip()
    if not room:
        return _error("bad_request", i18n)
    if room != caller_room:  # a keeper can only wipe its OWN room
        return _error("forbidden", i18n)

    backup = frame.get("backup", True) is not False
    path = str(frame.get("path") or "").strip()
    backup_path = ""
    try:
        if backup:
            backup_result = await export_room(services, keystore, room, path)
            backup_path = str(backup_result.get("path") or "")
        result = await delete_room_data(services, keystore, room)
    except Exception:
        return _error("op_failed", i18n)
    if backup_path:
        result["path"] = backup_path
    return _room_op_frame("delete", result)


def _room_op_frame(action: str, result: dict[str, Any]) -> dict[str, Any]:
    frame: dict[str, Any] = {
        "type": "admin_room_op",
        "action": action,
        "room": str(result.get("room") or ""),
        "keys": int(result.get("keys") or 0),
        "store_rows": int(result.get("store_rows") or 0),
        "vector_points": int(result.get("vector_points") or 0),
    }
    path = str(result.get("path") or "")
    if path:
        frame["path"] = path
    return frame


def _error(code: str, i18n: I18n) -> dict[str, Any]:
    return {"type": "admin_error", "code": code, "message": i18n.t(f"tui.admin.error.{code}")}
