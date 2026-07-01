"""SQLite-backed async key-value store.

The porting of the nekro-derived managers (``character_manager``,
``battle_report``) requires this store to match the ``FakeStore`` contract
used by ``nekro_trpg_dice_plugin``'s tests exactly: two logical key columns,
``user_key`` and ``store_key``. Callers bake ``chat_key`` into ``store_key``
themselves (e.g. ``party_roster.{chat_key}``) — it is NOT a separate column
here.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime
from pathlib import Path


class Store:
    """Async SQLite key-value store.

    Safe to construct with the default ``":memory:"`` path in tests: the
    connection is opened lazily on first use and then kept open for the
    lifetime of the ``Store`` instance, so repeated async calls observe the
    same in-memory database (SQLite otherwise hands each new ``:memory:``
    connection its own private, empty database).
    """

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self._db_path = str(db_path)
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kv (
                user_key TEXT,
                store_key TEXT,
                value TEXT,
                PRIMARY KEY (user_key, store_key)
            )
            """
        )
        conn.commit()
        return conn

    def _ensure_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._connect()
        return self._conn

    async def get(self, user_key: str = "", store_key: str = "") -> str | None:
        async with self._lock:
            conn = self._ensure_conn()
            row = conn.execute(
                "SELECT value FROM kv WHERE user_key = ? AND store_key = ?",
                (user_key, store_key),
            ).fetchone()
            return row[0] if row is not None else None

    async def set(self, user_key: str = "", store_key: str = "", value: str | None = None) -> None:
        async with self._lock:
            conn = self._ensure_conn()
            conn.execute(
                "INSERT OR REPLACE INTO kv (user_key, store_key, value) VALUES (?, ?, ?)",
                (user_key, store_key, value),
            )
            conn.commit()

    async def delete(self, user_key: str = "", store_key: str = "") -> None:
        async with self._lock:
            conn = self._ensure_conn()
            conn.execute(
                "DELETE FROM kv WHERE user_key = ? AND store_key = ?",
                (user_key, store_key),
            )
            conn.commit()

    def close(self) -> None:
        """Close the underlying connection, if one has been opened."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None


class MigrationRunner:
    """Tracks idempotent, named SQL migrations applied to a `Store`'s database.

    A minimal operational baseline for M2: migrations are plain SQL scripts
    identified by a unique ``name``; re-applying an already-applied name is
    a no-op.
    """

    def __init__(self, store: Store) -> None:
        self._store = store

    async def apply(self, name: str, sql: str) -> bool:
        """Apply `sql` under `name` if it has not been applied yet.

        Returns True if the migration was applied now, False if it was
        already recorded as applied (skipped).
        """
        async with self._store._lock:
            conn = self._store._ensure_conn()
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS applied_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at TEXT
                )
                """
            )
            conn.commit()

            already_applied = conn.execute(
                "SELECT 1 FROM applied_migrations WHERE name = ?",
                (name,),
            ).fetchone()
            if already_applied is not None:
                return False

            conn.executescript(sql)
            conn.execute(
                "INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)",
                (name, datetime.utcnow().isoformat()),
            )
            conn.commit()
            return True
