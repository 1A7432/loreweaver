"""Keeper-gated admin surface for the networked TUI (see `docs/protocol.md`).

The `net.tui_server.TuiServer` routes the v1.1 `admin_*` frames here. A keeper
holds an admin gate BY CONSTRUCTION: the keystore role stamped on the connection
at `join` decides it — a `keeper`-role connection may read/mutate the live LLM
config and mint/list keys for its own room; anyone else gets
`admin_error {code:"forbidden"}`.
There is no separate auth system.

Config/model handling REUSES the same primitives the `.model` chat command uses
(`infra.providers`: `is_known_provider`, `describe_settings`, `mask_secret`,
provider catalogs) and the shared `services.runtime_config`, so a switch made
here persists and hot-reconfigures the live `MutableLLM` exactly like
`.model set` -- every LLM consumer observes it without a restart.
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from agent.context import AgentCtx, FsAdapter
from agent.forge import (
    ForgeResult,
    generate_and_install_module,
    generate_and_install_rulepack,
    generate_and_install_skill,
)
from agent.services import Services
from core.rulepacks import available_systems, built_in_rulepack_ids
from core.skills import available_skills
from gateway.ops import get_enabled_skills, toggle_enabled_skill
from gateway.rooms import (
    clear_bindings_for_session,
    clear_keeper_binding,
    clear_keeper_bindings_for_room,
    list_keeper_bindings_for_room,
    session_key_for_room,
)
from gateway.turn import publish_state
from infra.i18n import I18n
from infra.imagegen import (
    IMAGEGEN_PRESETS,
    apply_imagegen_overrides,
    build_imagegen,
    describe_imagegen_settings,
)
from infra.oauth_flows import (
    SUBSCRIPTION_DEFAULT_MODELS,
    canonical_subscription_provider,
    is_subscription_provider,
)
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
from net.room_backup import (
    RESET_SCOPES,
    chat_key_for_room,
    delete_room_data,
    export_room,
    import_room,
    reset_room_state,
)

logger = logging.getLogger(__name__)

# The client -> server admin request frames this module answers.
_ADMIN_REQUESTS: frozenset[str] = frozenset(
    {
        "admin_get_config",
        "admin_set_model",
        "admin_set_imagegen",
        "admin_list_models",
        "admin_list_keys",
        "admin_mint_key",
        "admin_update_key",
        "admin_delete_key",
        "admin_delete_room",
        "admin_export_room",
        "admin_import_room",
        "admin_delete_room_data",
        "admin_reset_room",
        "admin_list_skills",
        "admin_enable_skill",
        "admin_list_rules",
        "admin_generate",
        "admin_update_server",
    }
)

_KEEPER_ROLE = "keeper"


def is_admin_frame(kind: Any) -> bool:
    """True if `kind` names one of the admin request frames handled here."""
    return isinstance(kind, str) and kind in _ADMIN_REQUESTS


class AdminService:
    """Transport-independent facade over the existing admin frame handlers."""

    def __init__(
        self,
        services: Services,
        keystore: Keystore,
        *,
        fs: FsAdapter | None = None,
        hub: Any = None,
    ) -> None:
        self.services = services
        self.keystore = keystore
        self.fs = fs
        self.hub = hub

    async def dispatch(
        self,
        role: str,
        caller_room: str,
        frame: dict[str, Any],
        i18n: I18n,
        *,
        reauthorize: Any = None,
    ) -> dict[str, Any]:
        if role == _KEEPER_ROLE and frame.get("type") == "admin_delete_key":
            binding = await self._chat_binding_for_id(caller_room, str(frame.get("id") or ""))
            if binding is not None:
                await clear_keeper_binding(
                    self.services.store,
                    *binding,
                    expected_room=caller_room,
                )
                await self._evict_chat_members(caller_room, binding)
                reply = _keys_frame(self.keystore, caller_room)
                return await self._with_chat_bindings(reply, caller_room)
        reply = await _dispatch_admin_frame(
            self.services,
            self.keystore,
            role,
            caller_room,
            frame,
            i18n,
            fs=self.fs,
            reauthorize=reauthorize,
        )
        if reply.get("type") != "admin_error" and frame.get("type") in {
            "admin_delete_room",
            "admin_delete_room_data",
        }:
            await self._evict_chat_members(caller_room)
        if (
            reply.get("type") != "admin_error"
            and frame.get("type") == "admin_reset_room"
            and self.hub is not None
        ):
            # The reset keeps everyone connected (no eviction), so proactively push a
            # fresh reset-flagged state frame: connected clients refresh their info panel
            # and clear their stale chat scrollback without needing to reconnect or send.
            await publish_state(
                self.hub,
                self.services,
                AgentCtx(chat_key=chat_key_for_room(caller_room)),
                reset=True,
            )
        return await self._with_chat_bindings(reply, caller_room)

    async def _evict_chat_members(
        self,
        room: str,
        identity: tuple[str, str] | None = None,
    ) -> None:
        if self.hub is None:
            return
        for member in self.hub.members(session_key_for_room(room)):
            source = getattr(member, "source", None)
            if source is None:
                continue
            if identity is not None and (
                getattr(source, "platform", ""),
                getattr(source, "user_id", ""),
            ) != identity:
                continue
            await self.hub.unsubscribe(member)

    async def _with_chat_bindings(
        self,
        reply: dict[str, Any],
        room: str,
    ) -> dict[str, Any]:
        if reply.get("type") != "admin_keys":
            return reply
        keys = list(reply.get("keys") or [])
        for platform, user_id in await list_keeper_bindings_for_room(self.services.store, room):
            identity = f"{platform}:{user_id}"
            keys.append(
                {
                    "id": _chat_binding_id(identity),
                    "key_masked": identity,
                    "room": room,
                    "name": identity,
                    "role": _KEEPER_ROLE,
                    "purpose": "chat_bind",
                    "expires_at": None,
                }
            )
        return {**reply, "keys": keys}

    async def _chat_binding_for_id(
        self,
        room: str,
        binding_id: str,
    ) -> tuple[str, str] | None:
        for platform, user_id in await list_keeper_bindings_for_room(self.services.store, room):
            if _chat_binding_id(f"{platform}:{user_id}") == binding_id:
                return platform, user_id
        return None


async def _dispatch_admin_frame(
    services: Services,
    keystore: Keystore,
    role: str,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
    *,
    fs: FsAdapter | None = None,
    reauthorize: Any = None,
) -> dict[str, Any]:
    """Handle one admin request `frame`, returning the reply frame to send.

    Gated two ways: (1) every admin request requires a `keeper`-role connection;
    (2) the destructive / room-content ops (export/import/delete_room/
    delete_room_data) and every key operation are scoped to the
    caller's OWN room (`caller_room`, the room the connecting keeper key is bound
    to) — a keeper cannot reach into another room's data or keys. Either gate
    failing yields `admin_error {code:"forbidden"}` and nothing is read or mutated.
    The KP-skills list/enable and the forge (`admin_generate`) requests are ALSO
    scoped to `caller_room` (a room's enabled-skill set, and — for `kind:"module"`
    — the room a generated module is installed into). `fs` is the `FsAdapter` a
    generated module's install needs (see `_generate`); transports without one
    (e.g. no filesystem bridge configured) still answer, but a module generation
    then fails cleanly via `agent.kp_tools_knowledge.DocumentTools.upload_document`'s
    own `ctx.fs is None` guard rather than raising.
    """
    if role != _KEEPER_ROLE:
        return _error("forbidden", i18n)

    kind = frame.get("type")
    if kind == "admin_get_config":
        return await _config_frame(services)
    if kind == "admin_set_model":
        async with services.config_lock:
            if reauthorize is not None and not reauthorize():
                return _error("forbidden", i18n)
            return await _set_model(services, frame, i18n)
    if kind == "admin_set_imagegen":
        async with services.config_lock:
            if reauthorize is not None and not reauthorize():
                return _error("forbidden", i18n)
            return await _set_imagegen(services, frame, i18n)
    if kind == "admin_list_models":
        return await _list_models(services, frame, i18n)
    if kind == "admin_list_keys":
        return _keys_frame(keystore, caller_room)
    if kind == "admin_mint_key":
        return _mint_key(keystore, caller_room, frame, i18n)
    if kind == "admin_update_key":
        return _update_key(keystore, caller_room, frame, i18n)
    if kind == "admin_delete_key":
        return _delete_key(keystore, caller_room, frame, i18n)
    if kind == "admin_delete_room":
        return await _delete_room(services, keystore, caller_room, frame, i18n)
    if kind == "admin_export_room":
        return await _export_room(services, keystore, caller_room, frame, i18n)
    if kind == "admin_import_room":
        return await _import_room(services, keystore, caller_room, frame, i18n)
    if kind == "admin_delete_room_data":
        return await _delete_room_data(services, keystore, caller_room, frame, i18n)
    if kind == "admin_reset_room":
        return await _reset_room(services, keystore, caller_room, frame, i18n)
    if kind == "admin_update_server":
        return await _update_server(services, i18n)
    if kind == "admin_list_skills":
        return await _skills_frame(services, caller_room)
    if kind == "admin_enable_skill":
        return await _enable_skill(services, caller_room, frame, i18n)
    if kind == "admin_list_rules":
        return _rules_frame()
    if kind == "admin_generate":
        return await _generate(services, caller_room, fs, frame, i18n)
    return _error("bad_request", i18n)


# -- LLM config -------------------------------------------------------------


async def _config_frame(services: Services) -> dict[str, Any]:
    info = _describe_llm(services)
    overrides = await services.runtime_config.get()
    saved_providers = await services.llm_credentials.providers()
    # Subscription status for the model screen (no new protocol frames).
    provider = (info["provider"] or "").casefold()
    base_url = info.get("base_url") or ""
    api_key_masked = info["api_key"]
    # Pure OAuth path only: supergrok, or chatgpt/gpt-subscription without a proxy base_url.
    # chatgpt + base_url still means a user-operated proxy (classic key masking).
    oauth_path = provider == "supergrok" or (
        is_subscription_provider(provider) and provider != "supergrok" and not base_url
    )
    subscription_status = ""
    if oauth_path:
        sub = await services.llm_credentials.load_subscription(provider)
        if sub is not None:
            subscription_status = "logged_in"
            from datetime import UTC, datetime

            try:
                api_key_masked = datetime.fromtimestamp(float(sub.expires_at), tz=UTC).strftime("sub:%Y-%m-%dT%H:%MZ")
            except (TypeError, ValueError, OSError):
                api_key_masked = "sub:logged_in"
        else:
            subscription_status = "logged_out"
            api_key_masked = ""
    return {
        "type": "admin_config",
        "provider": info["provider"],
        "chat_model": info["chat_model"],
        "base_url": info["base_url"],
        "api_key_masked": api_key_masked,
        "providers": _provider_names(),
        # Providers that already have a saved key — the model screen marks these 'ready' and
        # switching to one never re-asks for its key (see `_set_model`).
        "saved_providers": saved_providers,
        "override_active": bool(overrides),
        "imagegen": await _imagegen_status(services),
        # Lets connected clients remove a stale guided-demo affordance immediately.
        # A true value is global fallback state, not room authorization; adding the
        # affordance still requires the room-scoped check performed on welcome.
        "using_demo": bool(getattr(services.llm, "using_fallback", False)),
        # Optional hint (clients that ignore unknown fields stay compatible).
        "subscription_status": subscription_status,
    }


async def _set_model(services: Services, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    provider = str(frame.get("provider") or "").strip().casefold()
    if not provider or not is_known_provider(provider):
        return _error("unknown_provider", i18n)

    current = await services.runtime_config.get()
    live = _live_llm_settings(services)
    same_provider = _provider_identity(provider) == _provider_identity(live.provider)
    saved = await _saved_llm_credentials(services, provider)

    api_key_supplied = "api_key" in frame
    base_url_supplied = "base_url" in frame
    supplied_api_key = str(frame.get("api_key") or "").strip()
    supplied_base_url = str(frame.get("base_url") or "").strip()
    if provider == "supergrok":
        # Official SuperGrok OAuth is never sent to a caller-supplied endpoint.
        api_key = ""
        base_url = ""
    else:
        current_api_key = (live.api_key or "") if same_provider else ""
        current_base_url = (live.base_url or "") if same_provider else ""
        fallback_api_key, fallback_base_url = _static_credential_pair(
            same_provider, current_api_key, current_base_url, saved
        )
        base_url = supplied_base_url if base_url_supplied else fallback_base_url
        endpoint_changed = base_url_supplied and not _same_endpoint(
            _effective_llm_endpoint(provider, base_url),
            _effective_llm_endpoint(provider, fallback_base_url),
        )
        # Never couple a credential to a caller-selected endpoint it was not entered for.
        # An explicitly empty api_key clears it; omission also clears it when the URL changed.
        api_key = (
            supplied_api_key
            if api_key_supplied
            else "" if endpoint_changed else fallback_api_key
        )

    oauth_path = provider == "supergrok" or (
        provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES and not base_url
    )
    if oauth_path:
        sub = await services.llm_credentials.load_subscription(provider)
        if sub is None:
            return _error("set_failed", i18n)

    supplied_model = str(frame.get("chat_model") or "").strip()
    if supplied_model:
        chat_model = supplied_model
    elif same_provider:
        chat_model = live.chat_model
    else:
        chat_model = SUBSCRIPTION_DEFAULT_MODELS.get(provider, live.chat_model)

    overrides = {
        key: value
        for key, value in current.items()
        if key not in {"provider", "chat_model", "api_key", "base_url"}
    }
    overrides.update(
        {
            "provider": provider,
            "chat_model": chat_model,
            "api_key": api_key,
            "base_url": base_url,
        }
    )

    try:
        _reconfigure_llm(services, overrides)
        await services.runtime_config.replace(**overrides)
        # Remember this provider's credential so the next switch to it is frictionless.
        if not oauth_path and (api_key_supplied or base_url_supplied or api_key or base_url):
            await _replace_llm_static_credentials(
                services, provider, api_key=api_key, base_url=base_url
            )
    except Exception:
        # The live LLM may already be reconfigured while persistence/credentials failed;
        # surface the cause with a traceback so a real defect is not hidden behind the
        # client-facing "set failed". Never log the key/base_url themselves.
        logger.exception("admin_set_model failed (provider=%s)", provider)
        return _error("set_failed", i18n)
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

    api_key_supplied = "api_key" in frame
    base_url_supplied = "base_url" in frame
    supplied_api_key = str(frame.get("api_key") or "").strip()
    supplied_base_url = str(frame.get("base_url") or "").strip()
    saved = await services.llm_credentials.get(provider)
    same_provider = _provider_identity(provider) == _provider_identity(current_provider)
    fallback_api_key, fallback_base_url = _static_credential_pair(
        same_provider,
        base_llm.api_key or "",
        base_llm.base_url or "",
        saved,
    )
    base_url = supplied_base_url if base_url_supplied else fallback_base_url
    endpoint_changed = base_url_supplied and not _same_endpoint(
        _effective_llm_endpoint(provider, base_url),
        _effective_llm_endpoint(provider, fallback_base_url),
    )
    api_key = (
        supplied_api_key
        if api_key_supplied
        else "" if endpoint_changed else fallback_api_key
    )

    candidate = base_llm.model_copy(update={"provider": provider, "api_key": api_key, "base_url": base_url})
    models = await list_models(candidate)
    return {"type": "admin_models", "provider": provider, "models": models, "imagegen": await _imagegen_status(services)}


async def _set_imagegen(services: Services, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    provider = str(frame.get("provider") or "").strip().casefold()
    model = str(frame.get("model") or "").strip()
    if not provider or not model:
        return _error("bad_request", i18n)

    size = str(frame.get("size") or services.settings.imagegen.size or "1024x1024").strip()
    if not _valid_image_size(size):
        return _error("bad_request", i18n)

    api_key_supplied = "api_key" in frame
    base_url_supplied = "base_url" in frame
    supplied_api_key = str(frame.get("api_key") or "").strip()
    supplied_base_url = str(frame.get("base_url") or "").strip()
    live = services.settings.imagegen
    same_provider = provider == (live.provider or "").casefold()
    saved = await services.imagegen_credentials.get(provider)
    if provider == "supergrok":
        api_key = ""
        base_url = ""
    else:
        current_api_key = (live.api_key or "") if same_provider else ""
        current_base_url = (live.base_url or "") if same_provider else ""
        fallback_api_key, fallback_base_url = _static_credential_pair(
            same_provider, current_api_key, current_base_url, saved
        )
        base_url = supplied_base_url if base_url_supplied else fallback_base_url
        endpoint_changed = base_url_supplied and not _same_endpoint(
            _effective_imagegen_endpoint(provider, base_url),
            _effective_imagegen_endpoint(provider, fallback_base_url),
        )
        api_key = (
            supplied_api_key
            if api_key_supplied
            else "" if endpoint_changed else fallback_api_key
        )

    overrides: dict[str, str] = {
        "provider": provider,
        "model": model,
        "size": size,
        "api_key": api_key,
        "base_url": base_url,
    }

    try:
        _reconfigure_imagegen(services, overrides)
        await services.imagegen_runtime_config.replace(**overrides)
        if provider != "supergrok" and (
            api_key_supplied or base_url_supplied or api_key or base_url
        ):
            await services.imagegen_credentials.replace_static(
                provider, api_key=api_key, base_url=base_url
            )
    except Exception:
        # As in _set_model: keep a traceback so a genuine bug is not masked by the
        # generic client error. Never log the key/base_url themselves.
        logger.exception("admin_set_imagegen failed (provider=%s)", provider)
        return _error("set_failed", i18n)
    return await _config_frame(services)


async def _imagegen_status(services: Services) -> dict[str, Any]:
    saved = await services.imagegen_credentials.providers()
    status = describe_imagegen_settings(services.settings.imagegen, configured=services.imagegen is not None)
    status["saved_providers"] = saved
    return status


def _provider_names() -> list[str]:
    """Every provider `.model`/`is_known_provider` accepts: OpenAI-compatible
    presets first (sorted), then subscription aliases and native SDK providers."""
    from infra.oauth_flows import SUBSCRIPTION_PROVIDER_NAMES

    names = sorted(PRESETS) + list(CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES) + list(NATIVE_PROVIDER_NAMES)
    # Ensure supergrok is listed even if already in PRESETS.
    for name in SUBSCRIPTION_PROVIDER_NAMES:
        if name not in names:
            names.append(name)
    return names


def _live_llm_settings(services: Services) -> Any:
    """Return the effective mutable LLM settings, including unmasked credentials."""
    live = getattr(services.llm, "settings", None)
    return live.llm if live is not None else services.settings.llm


def _provider_identity(provider: str) -> str:
    return canonical_subscription_provider((provider or "").casefold())


def _same_endpoint(left: str, right: str) -> bool:
    """Compare endpoint spellings without treating a trailing slash as a move."""
    return (left or "").strip().rstrip("/") == (right or "").strip().rstrip("/")


def _effective_llm_endpoint(provider: str, base_url: str) -> str:
    """Resolve the endpoint a preset-backed LLM actually uses.

    Admin config returns this effective URL.  When a client sends that value
    back unchanged, compare it with the same effective fallback instead of the
    raw empty setting; otherwise a harmless round-trip looks like an endpoint
    move and drops the provider's API key.
    """
    return (base_url or PRESETS.get((provider or "").casefold(), "")).strip()


def _effective_imagegen_endpoint(provider: str, base_url: str) -> str:
    """Resolve the endpoint an image-generation preset actually uses."""
    preset = IMAGEGEN_PRESETS.get((provider or "").casefold(), {})
    return (base_url or preset.get("base_url", "")).strip()


def _static_credential_pair(
    same_provider: bool,
    current_api_key: str,
    current_base_url: str,
    saved: dict[str, str],
) -> tuple[str, str]:
    """Keep a key and its endpoint paired instead of mixing two sources."""
    if same_provider and (current_api_key or current_base_url):
        return current_api_key, current_base_url
    return saved.get("api_key", ""), saved.get("base_url", "")


async def _replace_llm_static_credentials(
    services: Services, provider: str, *, api_key: str, base_url: str
) -> None:
    """Replace exact + canonical alias credentials so no fallback revives an old key."""
    canonical = canonical_subscription_provider(provider)
    await services.llm_credentials.replace_static(
        canonical, api_key=api_key, base_url=base_url
    )
    if canonical != provider:
        await services.llm_credentials.replace_static(
            provider, api_key=api_key, base_url=base_url
        )


async def _saved_llm_credentials(services: Services, provider: str) -> dict[str, str]:
    """Load target-scoped static credentials, with canonical alias fallback."""
    provider = (provider or "").casefold()
    canonical = canonical_subscription_provider(provider)
    canonical_saved = await services.llm_credentials.get(canonical) if canonical != provider else {}
    exact_saved = await services.llm_credentials.get(provider)
    return {**canonical_saved, **exact_saved}


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


def _reconfigure_imagegen(services: Services, overrides: dict[str, str]) -> None:
    effective = apply_imagegen_overrides(services.settings, overrides)
    candidate = build_imagegen(effective, llm_credentials=services.llm_credentials)
    # Publish the new settings/client as one synchronous step only after the
    # candidate was constructed successfully.  In particular, a raising builder
    # must leave the old live settings and client untouched.
    services.settings.imagegen = effective.imagegen
    services.imagegen = candidate


def _valid_image_size(value: str) -> bool:
    parts = value.lower().split("x", 1)
    if len(parts) != 2:
        return False
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return 128 <= width <= 4096 and 128 <= height <= 4096


# -- room keys --------------------------------------------------------------


def _keys_frame(
    keystore: Keystore, caller_room: str, *, minted: dict[str, Any] | None = None
) -> dict[str, Any]:
    keys = [
        {
            "id": _key_id(entry.key),
            "key_masked": mask_secret(entry.key),
            "room": entry.room,
            "name": entry.name,
            "role": entry.role,
            "purpose": entry.purpose,
            "expires_at": entry.expires_at,
        }
        for entry in keystore.entries(purpose=None)
        if entry.room == caller_room
    ]
    frame: dict[str, Any] = {"type": "admin_keys", "keys": keys}
    if minted is not None:
        frame["minted"] = minted
    return frame


def _key_id(key: str) -> str:
    """Stable, non-secret handle for admin mutations over the wire."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _chat_binding_id(identity: str) -> str:
    return f"chat:{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]}"


def _resolve_key(keystore: Keystore, key_id: str) -> str | None:
    for entry in keystore.entries(purpose=None):
        if _key_id(entry.key) == key_id:
            return entry.key
    return None


def _mint_key(
    keystore: Keystore, caller_room: str, frame: dict[str, Any], i18n: I18n
) -> dict[str, Any]:
    requested_room = str(frame.get("room") or caller_room).strip()
    if not caller_room or requested_room != caller_room:
        return _error("forbidden", i18n)
    room = caller_room
    name = str(frame.get("name") or "").strip()
    purpose = str(frame.get("purpose") or "join").strip()
    if purpose not in {"join", "chat_bind"}:
        return _error("bad_request", i18n)
    role = str(frame.get("role") or ("keeper" if purpose == "chat_bind" else "player")).strip()
    if purpose == "chat_bind" and role != _KEEPER_ROLE:
        return _error("bad_request", i18n)
    expires_at: float | None = None
    if purpose == "chat_bind":
        try:
            expires_at = time.time() + int(frame.get("expires_in") or 600)
        except (TypeError, ValueError):
            return _error("bad_request", i18n)

    with keystore.persisted_mutation():
        key = keystore.add(
            room=room,
            name=name,
            role=role,
            purpose=purpose,
            expires_at=expires_at,
        )
    entry = keystore.get(key, purpose=None)
    assert entry is not None  # just added
    # The full key travels once, here, so the keeper can copy it; list views mask.
    minted = {
        "key": key,
        "room": entry.room,
        "name": entry.name,
        "role": entry.role,
        "purpose": entry.purpose,
        "expires_at": entry.expires_at,
    }
    return _keys_frame(keystore, caller_room, minted=minted)


def _update_key(keystore: Keystore, caller_room: str, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    key_id = str(frame.get("id") or "").strip()
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

    with keystore.persisted_mutation():
        # Resolve and authorize only after persisted_mutation has reloaded the authoritative
        # on-disk snapshot while holding its cross-process lock. Checking before the lock would
        # allow another process to move this key between rooms in the intervening window.
        key = _resolve_key(keystore, key_id)
        if key is None:
            return _error("not_found", i18n)
        entry = keystore.get(key, purpose=None)
        if entry is None or entry.room != caller_room:
            return _error("forbidden", i18n)
        keystore.update(key, **updates)
    return _keys_frame(keystore, caller_room)


def _delete_key(keystore: Keystore, caller_room: str, frame: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    key_id = str(frame.get("id") or "").strip()
    with keystore.persisted_mutation():
        key = _resolve_key(keystore, key_id)
        if key is None:
            return _error("not_found", i18n)
        entry = keystore.get(key, purpose=None)
        if entry is None or entry.room != caller_room:
            return _error("forbidden", i18n)
        keystore.remove(key)
    return _keys_frame(keystore, caller_room)


async def _delete_room(
    services: Services,
    keystore: Keystore,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    room = str(frame.get("room") or "").strip()
    if not room:
        return _error("bad_request", i18n)
    if room != caller_room:  # a keeper can only delete its OWN room
        return _error("forbidden", i18n)
    with keystore.persisted_mutation():
        removed = keystore.remove_room(room)
        if removed <= 0:
            return _error("not_found", i18n)
    await clear_keeper_bindings_for_room(services.store, room)
    await clear_bindings_for_session(services.store, session_key_for_room(room))
    return _keys_frame(keystore, caller_room)


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
        await clear_keeper_bindings_for_room(services.store, room)
        await clear_bindings_for_session(services.store, session_key_for_room(room))
    except Exception:
        return _error("op_failed", i18n)
    if backup_path:
        result["path"] = backup_path
    return _room_op_frame("delete", result)


async def _reset_room(
    services: Services,
    keystore: Keystore,
    caller_room: str,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    """Wipe one room's campaign state in place — the button behind an in-place
    campaign restart. Unlike ``_delete_room_data`` it takes NO backup and removes
    NO keys/bindings, so the room's members stay connected and re-provisioning is
    unnecessary (this is why ``admin_reset_room`` is deliberately absent from the
    member-eviction set above)."""
    room = str(frame.get("room") or "").strip()
    if not room:
        return _error("bad_request", i18n)
    if room != caller_room:  # a keeper can only reset its OWN room
        return _error("forbidden", i18n)
    scope = str(frame.get("scope") or "story").strip().casefold()
    if scope not in RESET_SCOPES:
        return _error("bad_request", i18n)
    try:
        result = await reset_room_state(services, chat_key_for_room(room), scope=scope, keystore=keystore)
    except Exception:
        return _error("op_failed", i18n)
    result["room"] = room
    return _room_op_frame("reset", result)


async def _update_server(services: Services, i18n: I18n) -> dict[str, Any]:
    """Run the operator-configured self-update command, then re-exec into the new code.

    Keeper-gated (like every admin frame). The command is `services.settings.tui.update_command`
    — the operator's own, never client input — and is a no-op unless configured. On success the
    server schedules a re-exec so the client should expect a brief disconnect + reconnect."""
    command = (services.settings.tui.update_command or "").strip()
    if not command:
        return _error("not_configured", i18n)
    from net.updater import run_update_command, schedule_reexec

    try:
        result = await run_update_command(command)
    except Exception:
        logger.exception("server self-update failed to run")
        return _error("op_failed", i18n)
    if not result.ok:
        return {"type": "admin_update", "status": "failed", "output": result.output}
    schedule_reexec()
    return {"type": "admin_update", "status": "restarting", "output": result.output}


def _room_op_frame(action: str, result: dict[str, Any]) -> dict[str, Any]:
    frame: dict[str, Any] = {
        "type": "admin_room_op",
        "action": action,
        "room": str(result.get("room") or ""),
        "keys": int(result.get("keys") or 0),
        "store_rows": int(result.get("store_rows") or 0),
        "vector_points": int(result.get("vector_points") or 0),
        "media_files": int(result.get("media_files") or 0),
    }
    path = str(result.get("path") or "")
    if path:
        frame["path"] = path
    scope = result.get("scope")
    if scope:
        frame["scope"] = str(scope)
    return frame


# -- KP skills (Layer B.1/B.2) ----------------------------------------------


async def _skills_frame(services: Services, caller_room: str) -> dict[str, Any]:
    """Answer `admin_list_skills`/a fresh post-`admin_enable_skill` reply: every discoverable
    skill (`core.skills.available_skills`), each marked `enabled` per the CALLER'S room."""
    chat_key = chat_key_for_room(caller_room)
    enabled_ids = set(await get_enabled_skills(services.store, chat_key))
    skills = [
        {
            "id": skill.id,
            "name": skill.name,
            "description": skill.description,
            "content_rating": skill.content_rating,
            "enabled": skill.id in enabled_ids,
        }
        for skill in available_skills()
    ]
    return {"type": "admin_skills", "skills": skills}


async def _enable_skill(
    services: Services, caller_room: str, frame: dict[str, Any], i18n: I18n
) -> dict[str, Any]:
    skill_id = str(frame.get("id") or "").strip()
    known_ids = {skill.id for skill in available_skills()}
    if not skill_id or skill_id not in known_ids:
        return _error("bad_request", i18n)

    chat_key = chat_key_for_room(caller_room)
    await toggle_enabled_skill(services.store, chat_key, skill_id, on=bool(frame.get("on")))
    return await _skills_frame(services, caller_room)


# -- rule systems (Layer A) ---------------------------------------------------


def _rules_frame() -> dict[str, Any]:
    """Answer `admin_list_rules`: every discoverable rule system
    (`core.rulepacks.available_systems`), each marked `built_in` per
    `core.rulepacks.built_in_rulepack_ids` (a generated/user-installed pack is `False`)."""
    built_in = built_in_rulepack_ids()
    systems = [{"id": system_id, "built_in": system_id in built_in} for system_id in available_systems()]
    return {"type": "admin_rules", "systems": systems}


# -- self-extension forge (Layer B.3) ----------------------------------------

_FORGE_KINDS: frozenset[str] = frozenset({"skill", "rule", "module"})


async def _generate(
    services: Services,
    caller_room: str,
    fs: FsAdapter | None,
    frame: dict[str, Any],
    i18n: I18n,
) -> dict[str, Any]:
    """Answer `admin_generate`: run the matching `agent.forge` engine and reply
    `admin_generated`. Never `eval`/`exec`s anything — see `agent.forge`'s module docstring;
    this is only the wire-level dispatch to it, mirroring the gated `generate_*` KP tools
    (`agent.kp_tools_forge.ForgeTools`) but without requiring a forge skill to be enabled (the
    admin surface is already keeper-gated by construction)."""
    kind = str(frame.get("kind") or "").strip()
    if kind not in _FORGE_KINDS:
        return _error("bad_request", i18n)
    description = str(frame.get("description") or "").strip()
    if not description:
        return _error("bad_request", i18n)

    room_chat_key = chat_key_for_room(caller_room)
    if kind == "skill":
        result = await generate_and_install_skill(services, description, chat_key=room_chat_key)
    elif kind == "rule":
        result = await generate_and_install_rulepack(services, description, chat_key=room_chat_key)
    else:
        # Mirrors `net.session.SessionCore._ctx_for`'s AgentCtx construction: a keeper-role
        # context scoped to the CALLER'S room, so the generated module lands in the calling
        # keeper's own knowledge pool via `agent.kp_tools_knowledge.DocumentTools.upload_document`.
        ctx = AgentCtx(
            chat_key=room_chat_key,
            user_id="keeper",
            platform="tui",
            locale=i18n.locale,
            fs=fs,
            extra={"role": _KEEPER_ROLE},
        )
        result = await generate_and_install_module(services, ctx, description)
    return _generated_frame(kind, result)


def _generated_frame(kind: str, result: ForgeResult) -> dict[str, Any]:
    return {
        "type": "admin_generated",
        "kind": kind,
        "ok": result.ok,
        "id": result.skill_id,
        "name": result.name,
        "error": result.error,
        # `detail` carries the per-room install outcome — for kind="module" it is the ONLY signal
        # of whether the generated module actually landed in the room's knowledge pool (`ok` merely
        # means a valid module was authored + written). Empty for skill/rule (no per-room step).
        "detail": result.detail,
    }


def _error(code: str, i18n: I18n) -> dict[str, Any]:
    return {"type": "admin_error", "code": code, "message": i18n.t(f"tui.admin.error.{code}")}
