"""Keeper-gated admin surface for the networked TUI (see `docs/protocol.md`).

The `net.tui_server.TuiServer` routes the v1.1 `admin_*` frames here. A keeper
holds an admin gate BY CONSTRUCTION: the keystore role stamped on the connection
at `join` decides it — a `keeper`-role connection may read/mutate the live LLM
config and mint/list room keys; anyone else gets `admin_error {code:"forbidden"}`.
There is no separate auth system.

Config/model handling REUSES the same primitives the `.model` chat command uses
(`infra.providers`: `is_known_provider`, `describe_settings`, `mask_secret`,
`PRESETS`/`NATIVE_PROVIDER_NAMES`) and the shared `services.runtime_config`, so a
switch made here persists and hot-reconfigures the live `MutableLLM` exactly like
`.model set` — every LLM consumer observes it without a restart.
"""

from __future__ import annotations

from typing import Any

from agent.services import Services
from infra.i18n import I18n
from infra.providers import (
    NATIVE_PROVIDER_NAMES,
    PRESETS,
    describe_settings,
    is_known_provider,
    mask_secret,
)
from net.keystore import Keystore

# The client -> server admin request frames this module answers.
_ADMIN_REQUESTS: frozenset[str] = frozenset(
    {"admin_get_config", "admin_set_model", "admin_list_keys", "admin_mint_key"}
)

_KEEPER_ROLE = "keeper"


def is_admin_frame(kind: Any) -> bool:
    """True if `kind` names one of the admin request frames handled here."""
    return isinstance(kind, str) and kind in _ADMIN_REQUESTS


async def handle_admin_frame(
    services: Services,
    keystore: Keystore,
    role: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    """Handle one admin request `frame`, returning the reply frame to send.

    Gated: every admin request requires a `keeper`-role connection; otherwise the
    reply is `admin_error {code:"forbidden"}` and nothing is read or mutated.
    """
    if role != _KEEPER_ROLE:
        return _error("forbidden", i18n)

    kind = frame.get("type")
    if kind == "admin_get_config":
        return await _config_frame(services)
    if kind == "admin_set_model":
        return await _set_model(services, frame, i18n)
    if kind == "admin_list_keys":
        return _keys_frame(keystore)
    if kind == "admin_mint_key":
        return _mint_key(keystore, frame, i18n)
    return _error("bad_request", i18n)


# -- LLM config -------------------------------------------------------------


async def _config_frame(services: Services) -> dict[str, Any]:
    info = _describe_llm(services)
    overrides = await services.runtime_config.get()
    return {
        "type": "admin_config",
        "provider": info["provider"],
        "chat_model": info["chat_model"],
        "base_url": info["base_url"],
        "api_key_masked": info["api_key"],
        "providers": _provider_names(),
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
    return await _config_frame(services)


def _provider_names() -> list[str]:
    """Every provider `.model`/`is_known_provider` accepts: OpenAI-compatible
    presets first (sorted), then the native-SDK providers."""
    return sorted(PRESETS) + list(NATIVE_PROVIDER_NAMES)


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


def _error(code: str, i18n: I18n) -> dict[str, Any]:
    return {"type": "admin_error", "code": code, "message": i18n.t(f"tui.admin.error.{code}")}
