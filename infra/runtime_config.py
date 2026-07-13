"""Runtime LLM configuration overrides, persisted in the ``Store``.

A deployer/admin can switch the Keeper's LLM provider/model at runtime (via the
``.model`` command) without restarting the process. Overrides are stored as a
single JSON blob under one global ``Store`` key (``runtime_config.llm``) and
re-applied on the next startup, so a switch survives restarts.

SECURITY NOTE: an ``api_key`` override is stored in the same local SQLite
``Store`` as the rest of the campaign state -- in plaintext, exactly like every
other value the ``Store`` already holds (it is a local, single-tenant DB). This
is intentional so a restart keeps a runtime-set key working. Prefer setting
``TRPG_LLM__API_KEY`` in the environment for production, and do not point the
``Store`` at shared/untrusted storage if you set keys through ``.model key``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from typing import TYPE_CHECKING, Any

from infra.config import Settings
from infra.imagegen import IMAGEGEN_OVERRIDE_FIELDS
from infra.store import Store

if TYPE_CHECKING:
    from infra.oauth_flows import TokenManager

# The ``llm`` fields a runtime override may set. ``embedding_*``/``temperature``
# are deliberately left to env config: switching the chat model should not
# silently change the embedding space a campaign's vectors were built in.
OVERRIDE_FIELDS: tuple[str, ...] = (
    "provider",
    "chat_model",
    "api_key",
    "base_url",
    "analysis_model",
    "npc_model",
)

DEFAULT_KEY = "runtime_config.llm"

# The per-provider credential book (see `CredentialBook`) remembers each provider's
# secret so switching providers in the model screen never re-asks for a key. Stored
# under its own `Store` key, same plaintext-local-DB caveat as the overrides above.
CREDENTIALS_KEY = "runtime_config.credentials"
# api_key/base_url for classic providers; subscription OAuth adds optional
# access_token/refresh_token/expires_at/account_id (unknown keys dropped on load).
_CREDENTIAL_FIELDS: tuple[str, ...] = (
    "api_key",
    "base_url",
    "access_token",
    "refresh_token",
    "expires_at",
    "account_id",
)
_SUBSCRIPTION_FIELDS: tuple[str, ...] = ("access_token", "refresh_token", "expires_at", "account_id")
IMAGEGEN_DEFAULT_KEY = "runtime_config.imagegen"
IMAGEGEN_CREDENTIALS_KEY = "runtime_config.imagegen.credentials"


def apply_overrides(base: Settings, overrides: dict) -> Settings:
    """Return a copy of ``base`` with the given llm ``overrides`` overlaid.

    Pure: ``base`` is never mutated. Only known ``OVERRIDE_FIELDS`` are applied;
    an explicit empty string clears the corresponding base setting. Anything
    else is ignored. An empty/irrelevant ``overrides`` yields a fresh deep copy.
    """
    filtered = {
        key: value
        for key, value in (overrides or {}).items()
        if key in OVERRIDE_FIELDS and value is not None
    }
    if not filtered:
        return base.model_copy(deep=True)
    return base.model_copy(update={"llm": base.llm.model_copy(update=filtered)})


def _decode(raw: str | None) -> dict[str, str]:
    """Parse a persisted overrides blob, preserving explicit empty fields."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: str(value)
        for key, value in data.items()
        if key in OVERRIDE_FIELDS and value is not None
    }


class RuntimeConfig:
    """Load/store the persisted LLM overrides through the async ``Store``.

    Async ``load``/``get``/``set``/``clear`` drive the shared ``Store``; the
    synchronous ``load_sync`` reads via a short-lived connection so overrides can
    be applied inside the (synchronous) ``build_services`` before the app's event
    loop exists, without binding the shared ``Store`` to a throwaway loop.
    """

    def __init__(self, store: Store, *, key: str = DEFAULT_KEY) -> None:
        self._store = store
        self._key = key
        self._cache: dict[str, str] | None = None

    async def load(self) -> dict[str, str]:
        """Read the persisted overrides from the ``Store`` (refreshing the cache)."""
        raw = await self._store.get(user_key="", store_key=self._key)
        self._cache = _decode(raw)
        return dict(self._cache)

    async def get(self) -> dict[str, str]:
        """Return the current overrides, loading them once if not cached."""
        if self._cache is None:
            await self.load()
        return dict(self._cache or {})

    async def set(self, **overrides: str) -> dict[str, str]:
        """Merge non-empty ``overrides`` into the persisted set; return the result."""
        current = await self.get()
        for key, value in overrides.items():
            if key not in OVERRIDE_FIELDS:
                raise ValueError(key)
            if value in (None, ""):
                continue
            current[key] = str(value)
        await self._store.set(user_key="", store_key=self._key, value=json.dumps(current))
        self._cache = current
        return dict(current)

    async def replace(self, **overrides: str) -> dict[str, str]:
        """Replace the persisted snapshot, preserving explicit empty strings."""
        for key in overrides:
            if key not in OVERRIDE_FIELDS:
                raise ValueError(key)
        current = {key: str(value) for key, value in overrides.items() if value is not None}
        await self._store.set(user_key="", store_key=self._key, value=json.dumps(current))
        self._cache = current
        return dict(current)

    async def clear(self) -> None:
        """Drop all persisted overrides (revert to env/``Settings``)."""
        await self._store.delete(user_key="", store_key=self._key)
        self._cache = {}

    def load_sync(self) -> dict[str, str]:
        """Synchronously read the persisted overrides via a short-lived connection."""
        path = self._store.path
        if path == ":memory:" or not os.path.exists(path):
            self._cache = {}
            return {}
        row = None
        try:
            conn = sqlite3.connect(path)
            try:
                row = conn.execute(
                    "SELECT value FROM kv WHERE user_key = '' AND store_key = ?",
                    (self._key,),
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.Error:
            row = None
        self._cache = _decode(row[0]) if row else {}
        return dict(self._cache)


def _decode_imagegen(raw: str | None) -> dict[str, str]:
    """Parse persisted image-generation overrides."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: str(value)
        for key, value in data.items()
        if key in IMAGEGEN_OVERRIDE_FIELDS and value is not None
    }


class ImageGenRuntimeConfig:
    """Load/store persisted image-generation runtime overrides."""

    def __init__(self, store: Store, *, key: str = IMAGEGEN_DEFAULT_KEY) -> None:
        self._store = store
        self._key = key
        self._cache: dict[str, str] | None = None

    async def load(self) -> dict[str, str]:
        raw = await self._store.get(user_key="", store_key=self._key)
        self._cache = _decode_imagegen(raw)
        return dict(self._cache)

    async def get(self) -> dict[str, str]:
        if self._cache is None:
            await self.load()
        return dict(self._cache or {})

    async def set(self, **overrides: str) -> dict[str, str]:
        current = await self.get()
        for key, value in overrides.items():
            if key not in IMAGEGEN_OVERRIDE_FIELDS:
                raise ValueError(key)
            if value in (None, ""):
                continue
            current[key] = str(value)
        await self._store.set(user_key="", store_key=self._key, value=json.dumps(current))
        self._cache = current
        return dict(current)

    async def replace(self, **overrides: str) -> dict[str, str]:
        """Replace the persisted snapshot, preserving explicit empty strings."""
        for key in overrides:
            if key not in IMAGEGEN_OVERRIDE_FIELDS:
                raise ValueError(key)
        current = {key: str(value) for key, value in overrides.items() if value is not None}
        await self._store.set(user_key="", store_key=self._key, value=json.dumps(current))
        self._cache = current
        return dict(current)

    async def clear(self) -> None:
        await self._store.delete(user_key="", store_key=self._key)
        self._cache = {}

    def load_sync(self) -> dict[str, str]:
        path = self._store.path
        if path == ":memory:" or not os.path.exists(path):
            self._cache = {}
            return {}
        row = None
        try:
            conn = sqlite3.connect(path)
            try:
                row = conn.execute(
                    "SELECT value FROM kv WHERE user_key = '' AND store_key = ?",
                    (self._key,),
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.Error:
            row = None
        self._cache = _decode_imagegen(row[0]) if row else {}
        return dict(self._cache)

def _decode_book(raw: str | None) -> dict[str, dict[str, str]]:
    """Parse a persisted credential book, keeping only known, non-empty fields."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    book: dict[str, dict[str, str]] = {}
    for provider, cred in data.items():
        if not isinstance(cred, dict):
            continue
        entry = {
            key: str(value)
            for key, value in cred.items()
            if key in _CREDENTIAL_FIELDS and value not in (None, "")
        }
        if entry:
            book[str(provider).casefold()] = entry
    return book


class CredentialBook:
    """Per-provider LLM credentials, persisted in the ``Store`` under one JSON key.

    Classic providers store ``{api_key, base_url}``. Subscription providers
    (ChatGPT / SuperGrok) additionally store
    ``{access_token, refresh_token, expires_at, account_id}`` via
    :meth:`save_subscription` / :meth:`load_subscription`.

    This is what lets the model screen offer *multiple* provider/key combos: set a
    key once for ``deepseek`` and once for ``openai``, then switching between them
    never re-asks — the admin ``set_model`` path reads the saved credential back.
    Same plaintext-local-DB security note as :class:`RuntimeConfig`.
    """

    def __init__(self, store: Store, *, key: str = CREDENTIALS_KEY) -> None:
        self._store = store
        self._key = key
        self._cache: dict[str, dict[str, str]] | None = None
        self._subscription_managers: dict[str, TokenManager] = {}
        self._disabled_subscriptions: set[str] = set()
        self._mutation_lock = asyncio.Lock()

    async def _load(self) -> dict[str, dict[str, str]]:
        raw = await self._store.get(user_key="", store_key=self._key)
        self._cache = _decode_book(raw)
        return self._cache

    def load_sync(self) -> dict[str, dict[str, str]]:
        """Synchronously read the credential book (for boot / build_llm)."""
        path = self._store.path
        if path == ":memory:" or not os.path.exists(path):
            if self._cache is None:
                self._cache = {}
            return {provider: dict(cred) for provider, cred in self._cache.items()}
        row = None
        try:
            conn = sqlite3.connect(path)
            try:
                row = conn.execute(
                    "SELECT value FROM kv WHERE user_key = '' AND store_key = ?",
                    (self._key,),
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.Error:
            row = None
        self._cache = _decode_book(row[0]) if row else {}
        return {provider: dict(cred) for provider, cred in self._cache.items()}

    async def all(self) -> dict[str, dict[str, str]]:
        """The whole book (a copy), loading once if not cached."""
        if self._cache is None:
            await self._load()
        return {provider: dict(cred) for provider, cred in (self._cache or {}).items()}

    async def get(self, provider: str) -> dict[str, str]:
        """The saved credential for `provider` (empty dict if none)."""
        book = await self.all()
        return book.get((provider or "").casefold(), {})

    def get_sync(self, provider: str) -> dict[str, str]:
        """Sync credential lookup (uses cache, or load_sync when cold)."""
        provider = (provider or "").casefold()
        if self._cache is None:
            self.load_sync()
        return dict((self._cache or {}).get(provider, {}))

    async def providers(self) -> list[str]:
        """Sorted providers that have a saved API key or subscription token."""
        book = await self.all()
        return sorted(
            name
            for name, cred in book.items()
            if cred.get("api_key") or cred.get("access_token")
        )

    async def remember(self, provider: str, *, api_key: str = "", base_url: str = "") -> None:
        """Upsert `provider`'s credential, keeping any field left blank."""
        provider = (provider or "").casefold()
        if not provider:
            return
        async with self._mutation_lock:
            if self._cache is None:
                await self._load()
            assert self._cache is not None
            entry = dict(self._cache.get(provider, {}))
            if api_key:
                entry["api_key"] = api_key
            if base_url:
                entry["base_url"] = base_url
            if not entry:
                return
            updated = dict(self._cache)
            updated[provider] = entry
            await self._store.set(user_key="", store_key=self._key, value=json.dumps(updated))
            self._cache = updated

    async def replace_static(self, provider: str, *, api_key: str = "", base_url: str = "") -> None:
        """Replace a provider's static endpoint credential, including explicit clears.

        OAuth fields, if any, are preserved.  This is intentionally different
        from :meth:`remember`: when an endpoint changes, retaining a blank field
        could pair the old API key with the new URL on a later switch.
        """
        provider = (provider or "").casefold()
        if not provider:
            return
        async with self._mutation_lock:
            if self._cache is None:
                await self._load()
            assert self._cache is not None
            # Build a replacement snapshot off to the side.  Store.set can fail
            # (disk full/read-only database); publishing the new cache before that
            # succeeds would make this process believe an old key was cleared while
            # a restart would load that key again from disk.
            updated = dict(self._cache)
            entry = dict(updated.get(provider, {}))
            entry.pop("api_key", None)
            entry.pop("base_url", None)
            if api_key:
                entry["api_key"] = api_key
            if base_url:
                entry["base_url"] = base_url
            if entry:
                updated[provider] = entry
            else:
                updated.pop(provider, None)
            await self._store.set(user_key="", store_key=self._key, value=json.dumps(updated))
            self._cache = updated

    async def save_subscription(self, provider: str, token: Any) -> None:
        """Persist a :class:`~infra.oauth_flows.SubscriptionToken` under ``provider``.

        Accepts a ``SubscriptionToken`` dataclass or a plain mapping with the same fields.
        Stored under the canonical subscription name (``chatgpt`` / ``supergrok``).
        """
        from infra.oauth_flows import SubscriptionToken, canonical_subscription_provider

        provider = canonical_subscription_provider(provider)
        if not provider:
            return
        if isinstance(token, SubscriptionToken):
            fields = {
                "access_token": token.access_token,
                "refresh_token": token.refresh_token,
                "expires_at": str(token.expires_at),
                "account_id": token.account_id or "",
            }
        elif isinstance(token, dict):
            fields = {
                "access_token": str(token.get("access_token") or ""),
                "refresh_token": str(token.get("refresh_token") or ""),
                "expires_at": str(token.get("expires_at") or ""),
                "account_id": str(token.get("account_id") or ""),
            }
        else:
            raise TypeError("token")
        if not fields["access_token"] or not fields["refresh_token"]:
            return
        async with self._mutation_lock:
            if self._cache is None:
                await self._load()
            assert self._cache is not None
            updated = self._with_subscription_fields(self._cache, provider, fields)
            await self._store.set(user_key="", store_key=self._key, value=json.dumps(updated))
            self._cache = updated
            self._disabled_subscriptions.discard(provider)
            # A successful new login supersedes live clients holding the old
            # token. Never invalidate them before the durable write succeeds.
            manager = self._subscription_managers.pop(provider, None)
            if manager is not None:
                manager.invalidate()

    @staticmethod
    def _with_subscription_fields(
        book: dict[str, dict[str, str]],
        provider: str,
        fields: dict[str, str],
    ) -> dict[str, dict[str, str]]:
        """Return a copied book with subscription fields applied."""
        updated = dict(book)
        entry = dict(updated.get(provider, {}))
        for key in _SUBSCRIPTION_FIELDS:
            value = fields.get(key, "")
            if value:
                entry[key] = value
            elif key == "account_id":
                entry.pop(key, None)
        # Official subscription paths use neither a static key nor a proxy URL.
        entry.pop("api_key", None)
        entry.pop("base_url", None)
        updated[provider] = entry
        return updated

    async def _persist_manager_update(
        self,
        provider: str,
        manager: TokenManager,
        token: Any,
    ) -> None:
        """Persist a refresh only while its manager is still current and active."""
        from infra.oauth_flows import SubscriptionToken

        if not isinstance(token, SubscriptionToken):
            return
        fields = {
            "access_token": token.access_token,
            "refresh_token": token.refresh_token,
            "expires_at": str(token.expires_at),
            "account_id": token.account_id or "",
        }
        async with self._mutation_lock:
            if self._subscription_managers.get(provider) is not manager or not manager.active:
                return
            if self._cache is None:
                await self._load()
            assert self._cache is not None
            updated = self._with_subscription_fields(self._cache, provider, fields)
            await self._store.set(user_key="", store_key=self._key, value=json.dumps(updated))
            self._cache = updated

    def subscription_manager_sync(self, provider: str) -> TokenManager | None:
        """Return the one shared live token manager for a subscription provider."""
        from infra.oauth_flows import canonical_subscription_provider, flow_for

        provider = canonical_subscription_provider(provider)
        if not provider or provider in self._disabled_subscriptions:
            return None
        existing = self._subscription_managers.get(provider)
        if existing is not None and existing.active:
            return existing
        self._subscription_managers.pop(provider, None)
        token = self.load_subscription_sync(provider)
        if token is None:
            return None

        holder: dict[str, TokenManager] = {}

        async def _on_update(updated: Any) -> None:
            await self._persist_manager_update(provider, holder["manager"], updated)

        from infra.oauth_flows import TokenManager

        manager = TokenManager(token, flow_for(provider), on_update=_on_update)
        holder["manager"] = manager
        self._subscription_managers[provider] = manager
        return manager

    async def load_subscription(self, provider: str) -> Any | None:
        """Load a :class:`~infra.oauth_flows.SubscriptionToken` or ``None`` if absent/invalid."""
        from infra.oauth_flows import SubscriptionToken, canonical_subscription_provider

        provider = canonical_subscription_provider(provider)
        cred = await self.get(provider)
        access = cred.get("access_token") or ""
        refresh = cred.get("refresh_token") or ""
        if not access or not refresh:
            return None
        try:
            expires_at = float(cred.get("expires_at") or 0)
        except (TypeError, ValueError):
            expires_at = 0.0
        return SubscriptionToken(
            access_token=access,
            refresh_token=refresh,
            expires_at=expires_at,
            account_id=cred.get("account_id") or "",
        )

    def load_subscription_sync(self, provider: str) -> Any | None:
        """Sync form of :meth:`load_subscription` for boot / build_llm."""
        from infra.oauth_flows import SubscriptionToken, canonical_subscription_provider

        provider = canonical_subscription_provider(provider)
        cred = self.get_sync(provider)
        access = cred.get("access_token") or ""
        refresh = cred.get("refresh_token") or ""
        if not access or not refresh:
            return None
        try:
            expires_at = float(cred.get("expires_at") or 0)
        except (TypeError, ValueError):
            expires_at = 0.0
        return SubscriptionToken(
            access_token=access,
            refresh_token=refresh,
            expires_at=expires_at,
            account_id=cred.get("account_id") or "",
        )

    async def forget(self, provider: str) -> None:
        """Drop `provider`'s saved credential (no-op if absent)."""
        from infra.oauth_flows import canonical_subscription_provider, is_subscription_provider

        raw = (provider or "").casefold()
        # Clear both the alias and the canonical subscription name.
        names = {raw}
        canonical = canonical_subscription_provider(raw) if is_subscription_provider(raw) else ""
        if canonical:
            names.add(canonical)
        async with self._mutation_lock:
            if self._cache is None:
                await self._load()
            assert self._cache is not None
            updated = dict(self._cache)
            for name in names:
                updated.pop(name, None)
            if updated != self._cache:
                await self._store.set(user_key="", store_key=self._key, value=json.dumps(updated))
                self._cache = updated
            if canonical:
                self._disabled_subscriptions.add(canonical)
                manager = self._subscription_managers.pop(canonical, None)
                if manager is not None:
                    manager.invalidate()

    async def forget_subscription(self, provider: str) -> None:
        """Revoke only OAuth fields/manager, preserving an independent proxy key."""
        from infra.oauth_flows import canonical_subscription_provider

        provider = canonical_subscription_provider(provider)
        if not provider:
            return
        async with self._mutation_lock:
            if self._cache is None:
                await self._load()
            assert self._cache is not None
            entry = dict(self._cache.get(provider, {}))
            changed = False
            for key in _SUBSCRIPTION_FIELDS:
                if entry.pop(key, None) is not None:
                    changed = True
            if changed:
                updated = dict(self._cache)
                if entry:
                    updated[provider] = entry
                else:
                    updated.pop(provider, None)
                await self._store.set(user_key="", store_key=self._key, value=json.dumps(updated))
                self._cache = updated
            self._disabled_subscriptions.add(provider)
            manager = self._subscription_managers.pop(provider, None)
            if manager is not None:
                manager.invalidate()


class ImageGenCredentialBook(CredentialBook):
    """Per-provider image-generation credentials, stored separately from LLM keys."""

    def __init__(self, store: Store, *, key: str = IMAGEGEN_CREDENTIALS_KEY) -> None:
        super().__init__(store, key=key)
