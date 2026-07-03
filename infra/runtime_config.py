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

import json
import os
import sqlite3

from infra.config import Settings
from infra.store import Store

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
_CREDENTIAL_FIELDS: tuple[str, ...] = ("api_key", "base_url")


def apply_overrides(base: Settings, overrides: dict) -> Settings:
    """Return a copy of ``base`` with the given llm ``overrides`` overlaid.

    Pure: ``base`` is never mutated. Only known, non-empty ``OVERRIDE_FIELDS``
    are applied; anything else is ignored. An empty/irrelevant ``overrides``
    yields a fresh deep copy of ``base``.
    """
    filtered = {
        key: value
        for key, value in (overrides or {}).items()
        if key in OVERRIDE_FIELDS and value not in (None, "")
    }
    if not filtered:
        return base.model_copy(deep=True)
    return base.model_copy(update={"llm": base.llm.model_copy(update=filtered)})


def _decode(raw: str | None) -> dict[str, str]:
    """Parse a persisted overrides blob, keeping only known, non-empty fields."""
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
        if key in OVERRIDE_FIELDS and value not in (None, "")
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
    """Per-provider LLM credentials (``{provider: {api_key, base_url}}``), persisted
    in the ``Store`` under one JSON key.

    This is what lets the model screen offer *multiple* provider/key combos: set a
    key once for ``deepseek`` and once for ``openai``, then switching between them
    never re-asks — the admin ``set_model`` path reads the saved credential back.
    Same plaintext-local-DB security note as :class:`RuntimeConfig`.
    """

    def __init__(self, store: Store, *, key: str = CREDENTIALS_KEY) -> None:
        self._store = store
        self._key = key
        self._cache: dict[str, dict[str, str]] | None = None

    async def _load(self) -> dict[str, dict[str, str]]:
        raw = await self._store.get(user_key="", store_key=self._key)
        self._cache = _decode_book(raw)
        return self._cache

    async def all(self) -> dict[str, dict[str, str]]:
        """The whole book (a copy), loading once if not cached."""
        if self._cache is None:
            await self._load()
        return {provider: dict(cred) for provider, cred in (self._cache or {}).items()}

    async def get(self, provider: str) -> dict[str, str]:
        """The saved credential for `provider` (empty dict if none)."""
        book = await self.all()
        return book.get((provider or "").casefold(), {})

    async def providers(self) -> list[str]:
        """Sorted providers that have a saved API key — what the UI marks 'ready'."""
        book = await self.all()
        return sorted(name for name, cred in book.items() if cred.get("api_key"))

    async def remember(self, provider: str, *, api_key: str = "", base_url: str = "") -> None:
        """Upsert `provider`'s credential, keeping any field left blank."""
        provider = (provider or "").casefold()
        if not provider:
            return
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
        self._cache[provider] = entry
        await self._store.set(user_key="", store_key=self._key, value=json.dumps(self._cache))

    async def forget(self, provider: str) -> None:
        """Drop `provider`'s saved credential (no-op if absent)."""
        provider = (provider or "").casefold()
        if self._cache is None:
            await self._load()
        assert self._cache is not None
        if self._cache.pop(provider, None) is not None:
            await self._store.set(user_key="", store_key=self._key, value=json.dumps(self._cache))
