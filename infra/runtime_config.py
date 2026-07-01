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
