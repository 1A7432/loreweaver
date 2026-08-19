"""The operator's model console: `.model` (show / list / set / key / login / logout / reset),
subscription OAuth flows, and the live LLM hot-switch."""

from __future__ import annotations

import time
from typing import Any

from agent.services import Services
from gateway.commands.rooms import _is_keeper, _is_private_channel, _keeper_still_authorized
from gateway.commands.types import CommandCtx
from infra.oauth_flows import (
    LOGIN_TIMEOUT_SECONDS,
    SUBSCRIPTION_DEFAULT_MODELS,
    SUBSCRIPTION_PROVIDER_NAMES,
    OAuthError,
    canonical_subscription_provider,
    flow_for,
    is_subscription_provider,
)
from infra.providers import (
    CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES,
    NATIVE_PROVIDER_NAMES,
    PRESETS,
    describe_settings,
    is_known_provider,
    mask_secret,
)

# `.model` subcommand vocabularies (EN + a couple of CN synonyms) -- runtime LLM config.
_MODEL_SHOW_WORDS = {"", "show", "status", "info", "查看", "状态", "狀態"}
_MODEL_LIST_WORDS = {"list", "ls", "providers", "列表", "列出"}
_MODEL_SET_WORDS = {"set", "use", "switch", "设置", "設置", "切换", "切換"}
_MODEL_KEY_WORDS = {"key", "apikey", "token", "密钥", "密鑰"}
_MODEL_RESET_WORDS = {"reset", "clear", "revert", "重置", "清除"}
_MODEL_LOGIN_WORDS = {"login", "auth", "signin", "登录", "登入"}
_MODEL_LOGOUT_WORDS = {"logout", "signout", "登出", "退出登录", "退出登入"}


def _model_mutation_failed(ctx: CommandCtx, provider: str) -> str:
    return ctx.i18n.t("commands.model.set_failed", provider=provider)


def _describe_llm(services: Services) -> dict[str, str]:
    """The live LLM's display snapshot — from the `MutableLLM` if present, else
    from the (possibly injected) settings so `.model` still shows something."""
    describe = getattr(services.llm, "describe", None)
    if callable(describe):
        return describe()
    return describe_settings(services.settings.llm)


def _live_llm_settings(services: Services) -> Any:
    """Return the effective mutable LLM settings, including unmasked credentials."""
    live = getattr(services.llm, "settings", None)
    return live.llm if live is not None else services.settings.llm


def _provider_identity(provider: str) -> str:
    """Collapse subscription aliases when deciding whether a provider changed."""
    return canonical_subscription_provider((provider or "").casefold())


async def _saved_llm_credentials(services: Services, provider: str) -> dict[str, str]:
    """Load target-scoped static credentials, with canonical alias fallback."""
    provider = (provider or "").casefold()
    canonical = canonical_subscription_provider(provider)
    canonical_saved = await services.llm_credentials.get(canonical) if canonical != provider else {}
    exact_saved = await services.llm_credentials.get(provider)
    return {**canonical_saved, **exact_saved}


def _reconfigure_llm(services: Services, overrides: dict) -> bool:
    """Hot-reconfigure the `MutableLLM` if present. Returns False when the LLM is
    not swappable (e.g. an injected FakeLLM / offline demo); the override is still
    persisted and takes effect on the next restart."""
    apply = getattr(services.llm, "apply", None)
    if callable(apply):
        apply(overrides)
        return True
    return False


def _subscription_login_sessions(services: Services) -> dict[str, Any]:
    """Per-process map of in-flight `.model login` polls, hung on the Services object."""
    sessions = getattr(services, "_subscription_logins", None)
    if sessions is None:
        sessions = {}
        services._subscription_logins = sessions  # type: ignore[attr-defined]
    return sessions


def _subscription_login_locks(services: Services) -> dict[str, Any]:
    """Per-provider locks protecting device-code flow creation."""
    locks = getattr(services, "_subscription_login_locks", None)
    if locks is None:
        locks = {}
        services._subscription_login_locks = locks  # type: ignore[attr-defined]
    return locks


async def _install_subscription(services: Services, canonical: str, token: Any) -> None:
    await services.llm_credentials.save_subscription(canonical, token)
    await _refresh_active_subscription_clients(services, canonical)


async def _refresh_active_subscription_clients(services: Services, canonical: str) -> None:
    """Rebuild live clients after a successful login replaces their token manager."""
    live = _live_llm_settings(services)
    provider = (live.provider or "").casefold()
    oauth_path = provider == "supergrok" or (
        provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES and not live.base_url
    )
    same_identity = _provider_identity(provider) == canonical
    if same_identity:
        current = await services.runtime_config.get()
        if provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES and live.base_url:
            # Logging in while the current ChatGPT alias is a classic proxy is
            # an explicit mode switch: clear its static endpoint/key, rebuild on
            # the official OAuth path, and persist that exact snapshot.
            overrides = {
                key: value
                for key, value in current.items()
                if key not in {"provider", "chat_model", "api_key", "base_url"}
            }
            overrides.update(
                {
                    "provider": provider,
                    "chat_model": live.chat_model,
                    "api_key": "",
                    "base_url": "",
                }
            )
            _reconfigure_llm(services, overrides)
            await services.runtime_config.replace(**overrides)
        elif oauth_path:
            # A failed persisted override may have left the validated base/env
            # provider live. Rebuild the base snapshot, not an unrelated override.
            persisted_provider = (current.get("provider") or provider).casefold()
            if _provider_identity(persisted_provider) != canonical:
                current = {}
            _reconfigure_llm(services, current)

    # Relogin must refresh an explicitly configured SuperGrok image client, but
    # this is independent of the active LLM and must not turn image generation
    # on when its provider is still empty/other.
    if canonical == "supergrok" and (services.settings.imagegen.provider or "").casefold() == "supergrok":
        _refresh_supergrok_imagegen(services)


def _refresh_supergrok_imagegen(services: Services) -> None:
    """Rebuild an active SuperGrok image client after its shared login changes."""
    from infra.imagegen import build_imagegen

    services.imagegen = build_imagegen(services.settings, llm_credentials=services.llm_credentials)


class LlmCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_model(self, ctx: CommandCtx) -> str:
        """`.model [list | set | login | logout | key | reset]` — inspect or
        switch the Keeper's LLM provider/model at runtime. The provider catalog is public;
        deployment details and mutations require a Keeper. The override persists (see
        `infra.runtime_config`) and hot-reconfigures the live `MutableLLM`, so every LLM
        consumer sees the switch without a restart."""
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        runtime_config = ctx.services.runtime_config
        if sub in _MODEL_LIST_WORDS:
            return self._model_list(ctx)
        if sub in _MODEL_SHOW_WORDS:
            if not await _keeper_still_authorized(
                ctx.raw_ctx, ctx.chat_key, ctx.services.store
            ):
                return ctx.fail(ctx.i18n.t("commands.model.denied"))
            return await self._model_show(ctx, runtime_config)
        if ctx.raw_ctx.platform != "cli" and not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.model.denied"))
        if sub in (
            _MODEL_SET_WORDS
            | _MODEL_LOGIN_WORDS
            | _MODEL_LOGOUT_WORDS
            | _MODEL_KEY_WORDS
            | _MODEL_RESET_WORDS
        ):
            async with ctx.services.config_lock:
                if not await _keeper_still_authorized(
                    ctx.raw_ctx, ctx.chat_key, ctx.services.store
                ):
                    return ctx.fail(ctx.i18n.t("commands.model.denied"))
                if sub in _MODEL_SET_WORDS:
                    return await self._model_set(ctx, runtime_config, rest)
                if sub in _MODEL_LOGIN_WORDS:
                    return await self._model_login(ctx, rest)
                if sub in _MODEL_LOGOUT_WORDS:
                    return await self._model_logout(ctx, rest)
                if sub in _MODEL_KEY_WORDS:
                    return await self._model_key(ctx, runtime_config, rest)
                return await self._model_reset(ctx, runtime_config)
        return ctx.i18n.t("commands.model.usage")

    async def _model_show(self, ctx: CommandCtx, runtime_config: Any) -> str:
        info = _describe_llm(ctx.services)
        overrides = await runtime_config.get()
        override = ctx.i18n.t("commands.model.override_on") if overrides else ctx.i18n.t("commands.model.override_off")
        provider = (info["provider"] or "").casefold()
        api_key_display = info["api_key"] or ctx.i18n.t("commands.model.key_none")
        # Only the official OAuth paths show subscription status. ChatGPT aliases
        # with an explicit base_url are user-operated proxies and keep the normal
        # masked-key display.
        oauth_path = provider == "supergrok" or (
            provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES and not info.get("base_url")
        )
        if oauth_path:
            sub = await ctx.services.llm_credentials.load_subscription(provider)
            if sub is not None:
                from datetime import UTC, datetime

                try:
                    exp = datetime.fromtimestamp(float(sub.expires_at), tz=UTC).strftime("%Y-%m-%d %H:%M UTC")
                except (TypeError, ValueError, OSError):
                    exp = "?"
                api_key_display = ctx.i18n.t("commands.model.subscription_logged_in", expires=exp)
            else:
                api_key_display = ctx.i18n.t("commands.model.subscription_logged_out")
        return ctx.i18n.t(
            "commands.model.show",
            provider=info["provider"],
            chat_model=info["chat_model"],
            base_url=info["base_url"] or ctx.i18n.t("commands.model.base_default"),
            api_key=api_key_display,
            override=override,
        )

    def _model_list(self, ctx: CommandCtx) -> str:
        compatible = ", ".join(
            sorted(name for name in PRESETS if not is_subscription_provider(name))
        )
        native = ", ".join(NATIVE_PROVIDER_NAMES)
        subscription = ", ".join(SUBSCRIPTION_PROVIDER_NAMES)
        return ctx.i18n.t(
            "commands.model.list",
            compatible=compatible,
            native=native,
            subscription=subscription,
        )

    async def _model_set(self, ctx: CommandCtx, runtime_config: Any, rest: str) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.model.denied"))
        tokens = rest.split()
        if not tokens:
            return ctx.i18n.t("commands.model.set_usage")
        provider = tokens[0].casefold()
        if not is_known_provider(provider):
            return ctx.i18n.t("commands.model.unknown_provider", provider=provider)

        current = await runtime_config.get()
        live = _live_llm_settings(ctx.services)
        same_provider = _provider_identity(provider) == _provider_identity(live.provider)
        saved = await _saved_llm_credentials(ctx.services, provider)

        # Credentials are provider-scoped. Retain the live credentials only when
        # re-selecting the same provider; otherwise use that target provider's
        # credential-book entry and explicitly clear absent fields. SuperGrok is
        # OAuth-only and must never inherit or accept a custom endpoint/static key.
        if provider == "supergrok":
            api_key = ""
            base_url = ""
        elif same_provider:
            api_key = live.api_key or ""
            base_url = live.base_url or ""
        else:
            api_key = saved.get("api_key", "")
            base_url = saved.get("base_url", "")

        oauth_path = provider == "supergrok" or (
            provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES and not base_url
        )
        if oauth_path:
            sub = await ctx.services.llm_credentials.load_subscription(provider)
            if sub is None:
                return ctx.i18n.t("commands.model.login_required", provider=canonical_subscription_provider(provider))

        if len(tokens) > 1:
            chat_model = tokens[1]
        elif same_provider:
            # Re-selecting the active subscription provider must not silently
            # replace a custom model with the provider default.
            chat_model = live.chat_model
        else:
            chat_model = SUBSCRIPTION_DEFAULT_MODELS.get(provider, live.chat_model)

        # Preserve non-provider runtime knobs, but replace the complete
        # provider-scoped snapshot. RuntimeConfig.replace persists explicit empty
        # strings so base Settings credentials cannot bleed into the new provider.
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

        # Build/apply first so an invalid provider cannot poison the next boot, then persist it.
        try:
            reconfigured = _reconfigure_llm(ctx.services, overrides)
            await runtime_config.replace(**overrides)
        except Exception:
            return _model_mutation_failed(ctx, provider)
        # Refresh an explicitly configured SuperGrok image client once its
        # shared subscription is ready. Selecting an LLM must not silently turn
        # image generation on (or create an in-memory-only imagegen setting).
        if (
            provider == "supergrok"
            and (ctx.services.settings.imagegen.provider or "").casefold() == "supergrok"
        ):
            _refresh_supergrok_imagegen(ctx.services)
        info = _describe_llm(ctx.services)
        key = "commands.model.set_done" if reconfigured else "commands.model.set_saved"
        return ctx.i18n.t(key, provider=info["provider"], chat_model=info["chat_model"])

    async def _model_login(self, ctx: CommandCtx, rest: str) -> str:
        """`.model login <chatgpt|supergrok>` — start device-code OAuth (keeper-only)."""
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.model.denied"))
        provider = rest.strip().casefold().split()[0] if rest.strip() else ""
        if not provider or not is_subscription_provider(provider):
            return ctx.i18n.t("commands.model.login_usage")
        canonical = canonical_subscription_provider(provider)

        sessions = _subscription_login_sessions(ctx.services)
        existing = sessions.get(canonical)
        if existing is not None and not existing.get("done"):
            login = existing.get("login")
            if login is not None:
                return ctx.i18n.t(
                    "commands.model.login_pending",
                    provider=canonical,
                    url=login.verification_url,
                    code=login.user_code,
                )

        import asyncio

        # Device-code start performs network I/O. Serialize it per provider so
        # two keepers cannot race past the pending-session check and create two
        # competing grants whose rotating refresh tokens invalidate each other.
        lock = _subscription_login_locks(ctx.services).setdefault(canonical, asyncio.Lock())
        async with lock:
            existing = sessions.get(canonical)
            if existing is not None and not existing.get("done"):
                login = existing.get("login")
                if login is not None:
                    return ctx.i18n.t(
                        "commands.model.login_pending",
                        provider=canonical,
                        url=login.verification_url,
                        code=login.user_code,
                    )

            flow = None
            try:
                flow = flow_for(canonical)
                login = await flow.start()
            except (asyncio.CancelledError, Exception) as exc:
                aclose = getattr(flow, "aclose", None) if flow is not None else None
                if callable(aclose):
                    try:
                        await aclose()
                    except Exception:
                        pass
                if isinstance(exc, asyncio.CancelledError):
                    raise
                return ctx.i18n.t("commands.model.login_failed")

            session: dict[str, Any] = {
                "login": login,
                "done": False,
                "error": None,
                "task": None,
            }
            sessions[canonical] = session

        async def _poll() -> None:

            deadline = time.time() + LOGIN_TIMEOUT_SECONDS
            try:
                while time.time() < deadline:
                    try:
                        token = await flow.poll(login)
                    except OAuthError as exc:
                        session["error"] = exc.code
                        session["done"] = True
                        return
                    if token is not None:
                        async with ctx.services.config_lock:
                            await _install_subscription(ctx.services, canonical, token)
                        session["done"] = True
                        session["token_ok"] = True
                        return
                    # RFC 8628 `slow_down` may increase the interval in-place;
                    # re-read it every round instead of freezing the initial value.
                    await asyncio.sleep(max(1.0, float(login.poll_interval or 5.0)))
                session["error"] = "subscription_login_timeout"
                session["done"] = True
            except asyncio.CancelledError:
                session["error"] = "subscription_login_cancelled"
                session["done"] = True
                raise
            except Exception:
                # A malformed provider response or an unexpected persistence
                # failure must not leave a dead task advertised as "pending"
                # forever. Mark it retryable without exposing exception details.
                session["error"] = "subscription_poll_failed"
                session["done"] = True
            finally:
                aclose = getattr(flow, "aclose", None)
                if callable(aclose):
                    try:
                        await aclose()
                    except Exception:
                        pass

        session["task"] = asyncio.create_task(_poll())
        note = ""
        if canonical == "chatgpt":
            note = " " + ctx.i18n.t("commands.model.login_chatgpt_no_imagegen")
        return ctx.i18n.t(
            "commands.model.login_started",
            provider=canonical,
            url=login.verification_url,
            code=login.user_code,
        ) + note

    async def _model_logout(self, ctx: CommandCtx, rest: str) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.model.denied"))
        provider = rest.strip().casefold().split()[0] if rest.strip() else ""
        if not provider or not is_subscription_provider(provider):
            return ctx.i18n.t("commands.model.logout_usage")
        canonical = canonical_subscription_provider(provider)
        sessions = _subscription_login_sessions(ctx.services)
        pending = sessions.pop(canonical, None)
        if pending and pending.get("task") is not None:
            task = pending["task"]
            if not task.done():
                task.cancel()
                import asyncio

                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

        live = _live_llm_settings(ctx.services)
        current_oauth_path = (live.provider or "").casefold() == "supergrok" or (
            (live.provider or "").casefold() in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES
            and not live.base_url
        )
        active_oauth = _provider_identity(live.provider) == canonical and current_oauth_path
        try:
            if active_oauth:
                _reconfigure_llm(ctx.services, {})
                await ctx.services.runtime_config.clear()
            await ctx.services.llm_credentials.forget_subscription(canonical)
        except Exception:
            return _model_mutation_failed(ctx, canonical)

        if canonical == "supergrok" and (ctx.services.settings.imagegen.provider or "").casefold() == "supergrok":
            _refresh_supergrok_imagegen(ctx.services)
        return ctx.i18n.t("commands.model.logout_done", provider=canonical)

    async def _model_key(self, ctx: CommandCtx, runtime_config: Any, rest: str) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.model.denied"))
        if not _is_private_channel(ctx.raw_ctx):
            return ctx.i18n.t("commands.model.key_public")
        api_key = rest.strip()
        if not api_key:
            return ctx.i18n.t("commands.model.key_usage")
        live = _live_llm_settings(ctx.services)
        provider = (live.provider or "openai").casefold()
        oauth_path = provider == "supergrok" or (
            provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES and not live.base_url
        )
        if oauth_path:
            return ctx.i18n.t("commands.model.login_required", provider=canonical_subscription_provider(provider))
        merged = dict(await runtime_config.get())
        merged["api_key"] = api_key
        try:
            _reconfigure_llm(ctx.services, merged)
            await ctx.services.llm_credentials.replace_static(
                provider,
                api_key=api_key,
                base_url=live.base_url or "",
            )
            await runtime_config.replace(**merged)
        except Exception:
            return _model_mutation_failed(ctx, provider)
        return ctx.i18n.t("commands.model.key_done", api_key=mask_secret(api_key))

    async def _model_reset(self, ctx: CommandCtx, runtime_config: Any) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.model.denied"))
        provider = _live_llm_settings(ctx.services).provider or "default"
        try:
            _reconfigure_llm(ctx.services, {})
            await runtime_config.clear()
        except Exception:
            return _model_mutation_failed(ctx, provider)
        info = _describe_llm(ctx.services)
        return ctx.i18n.t("commands.model.reset_done", provider=info["provider"], chat_model=info["chat_model"])
