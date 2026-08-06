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
import os
import sqlite3
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

from infra.file_permissions import restrict_sqlite_files


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
        # Self-heal files created by older versions before synchronous runtime
        # credential reads can touch them during service construction.
        restrict_sqlite_files(self._db_path)

    @property
    def path(self) -> str:
        """The backing database path (``":memory:"`` for the in-memory store)."""
        return self._db_path

    def _connect(self) -> sqlite3.Connection:
        # SQLite otherwise creates a new database through the process umask. Pre-create
        # ordinary path-backed databases as 0600 so credentials are never briefly readable
        # before ``restrict_sqlite_files`` runs after the first commit.
        if self._db_path != ":memory:" and not self._db_path.startswith("file:"):
            try:
                fd = os.open(self._db_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                os.close(fd)
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
        # M17 unified document model: every piece of room CONTENT lives in one
        # `documents` table (room, type, id); `seq` preserves insertion order per
        # (room, type) so listing never needs a separate index row. Room-scoped
        # RUNTIME/machinery state (clocks, histories, timers, caches) lives in
        # `room_state`, room-scoped by COLUMN — which is what lets backup/export/
        # reset enumerate a room without any per-store key allowlist. The old kv
        # table keeps only non-room-scoped data (config, credentials, bindings,
        # per-user caches).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                room TEXT NOT NULL,
                type TEXT NOT NULL,
                id TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                data TEXT NOT NULL,
                meta TEXT NOT NULL,
                grants TEXT NOT NULL,
                seq INTEGER NOT NULL,
                PRIMARY KEY (room, type, id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS room_state (
                room TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                PRIMARY KEY (room, key)
            )
            """
        )
        conn.commit()
        restrict_sqlite_files(self._db_path)
        return conn

    def _commit(self, conn: sqlite3.Connection) -> None:
        """Commit the current transaction."""
        conn.commit()

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
            self._commit(conn)

    async def delete(self, user_key: str = "", store_key: str = "") -> None:
        async with self._lock:
            conn = self._ensure_conn()
            conn.execute(
                "DELETE FROM kv WHERE user_key = ? AND store_key = ?",
                (user_key, store_key),
            )
            self._commit(conn)

    async def list_rows(self, *, store_key_prefixes: Iterable[str] = ()) -> list[dict[str, str | None]]:
        """Return KV rows whose ``store_key`` starts with any requested prefix.

        With no prefixes this returns every row. This is intentionally small and
        explicit: callers that need room-level export/delete build the prefixes
        for that room and pass them here, rather than gaining arbitrary SQL
        access.
        """
        prefixes = tuple(store_key_prefixes)
        async with self._lock:
            conn = self._ensure_conn()
            if not prefixes:
                rows = conn.execute("SELECT user_key, store_key, value FROM kv").fetchall()
            else:
                # Escape LIKE metacharacters so a prefix containing `%`/`_` (e.g. a room name
                # with an underscore) matches LITERALLY, not as a wildcard — otherwise an
                # export/delete could over-match a different, similarly-named room's rows.
                def _esc(prefix: str) -> str:
                    return prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

                where = " OR ".join("store_key LIKE ? ESCAPE '\\'" for _ in prefixes)
                rows = conn.execute(
                    f"SELECT user_key, store_key, value FROM kv WHERE {where}",  # noqa: S608 - fixed clause shape.
                    tuple(f"{_esc(prefix)}%" for prefix in prefixes),
                ).fetchall()
            return [{"user_key": row[0], "store_key": row[1], "value": row[2]} for row in rows]

    async def delete_rows(self, rows: Iterable[tuple[str, str]]) -> int:
        """Delete exact ``(user_key, store_key)`` rows; return the affected count."""
        items = list(rows)
        if not items:
            return 0
        async with self._lock:
            conn = self._ensure_conn()
            cursor = conn.executemany("DELETE FROM kv WHERE user_key = ? AND store_key = ?", items)
            self._commit(conn)
            return cursor.rowcount if cursor.rowcount != -1 else len(items)

    async def delete_rows_if_value(
        self, rows: Iterable[tuple[str, str, str]]
    ) -> int:
        """Delete rows only while their value still matches the caller's read."""
        items = list(rows)
        if not items:
            return 0
        async with self._lock:
            conn = self._ensure_conn()
            cursor = conn.executemany(
                "DELETE FROM kv WHERE user_key = ? AND store_key = ? AND value = ?",
                items,
            )
            self._commit(conn)
            return cursor.rowcount if cursor.rowcount != -1 else len(items)

    async def set_rows_if_values(
        self,
        *,
        expected: Iterable[tuple[str, str, str | None]],
        updates: Iterable[tuple[str, str, str | None]],
    ) -> bool:
        """Atomically update rows only while all expected values still match.

        This compare-and-set primitive prevents a multi-record deterministic
        mutation from committing a partial or stale result.
        """
        expected_items = list(expected)
        update_items = list(updates)
        if not update_items:
            return True

        async with self._lock:
            conn = self._ensure_conn()
            conn.execute("BEGIN IMMEDIATE")
            try:
                for user_key, store_key, expected_value in expected_items:
                    row = conn.execute(
                        "SELECT value FROM kv WHERE user_key = ? AND store_key = ?",
                        (user_key, store_key),
                    ).fetchone()
                    current_value = row[0] if row is not None else None
                    if current_value != expected_value:
                        conn.rollback()
                        return False
                conn.executemany(
                    "INSERT OR REPLACE INTO kv (user_key, store_key, value) VALUES (?, ?, ?)",
                    update_items,
                )
                self._commit(conn)
                return True
            except Exception:
                conn.rollback()
                raise

    # ------------------------------------------------------------------
    # Documents table (M17) — raw row transport; typed semantics (schema
    # validation, projections) live in `core.documents`, never here.
    # ------------------------------------------------------------------

    async def doc_get(self, room: str, doc_type: str, doc_id: str) -> dict | None:
        async with self._lock:
            conn = self._ensure_conn()
            row = conn.execute(
                "SELECT room, type, id, schema_version, data, meta, grants, seq"
                " FROM documents WHERE room = ? AND type = ? AND id = ?",
                (room, doc_type, doc_id),
            ).fetchone()
            return self._doc_row(row) if row is not None else None

    async def doc_put(
        self,
        room: str,
        doc_type: str,
        doc_id: str,
        *,
        schema_version: int,
        data: str,
        meta: str,
        grants: str,
    ) -> None:
        """Insert or update one document row, preserving its insertion `seq`."""
        async with self._lock:
            conn = self._ensure_conn()
            existing = conn.execute(
                "SELECT seq FROM documents WHERE room = ? AND type = ? AND id = ?",
                (room, doc_type, doc_id),
            ).fetchone()
            if existing is not None:
                seq = existing[0]
            else:
                row = conn.execute(
                    "SELECT COALESCE(MAX(seq) + 1, 0) FROM documents WHERE room = ? AND type = ?",
                    (room, doc_type),
                ).fetchone()
                seq = row[0]
            conn.execute(
                "INSERT OR REPLACE INTO documents (room, type, id, schema_version, data, meta, grants, seq)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (room, doc_type, doc_id, schema_version, data, meta, grants, seq),
            )
            self._commit(conn)

    async def doc_list(self, room: str, doc_type: str | None = None) -> list[dict]:
        """All of `room`'s document rows (optionally one type), in insertion order."""
        async with self._lock:
            conn = self._ensure_conn()
            if doc_type is None:
                rows = conn.execute(
                    "SELECT room, type, id, schema_version, data, meta, grants, seq"
                    " FROM documents WHERE room = ? ORDER BY type, seq",
                    (room,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT room, type, id, schema_version, data, meta, grants, seq"
                    " FROM documents WHERE room = ? AND type = ? ORDER BY seq",
                    (room, doc_type),
                ).fetchall()
            return [self._doc_row(row) for row in rows]

    async def doc_delete(self, room: str, doc_type: str, doc_id: str) -> bool:
        async with self._lock:
            conn = self._ensure_conn()
            cursor = conn.execute(
                "DELETE FROM documents WHERE room = ? AND type = ? AND id = ?",
                (room, doc_type, doc_id),
            )
            self._commit(conn)
            return cursor.rowcount > 0

    async def doc_delete_type(self, room: str, doc_type: str) -> int:
        async with self._lock:
            conn = self._ensure_conn()
            cursor = conn.execute(
                "DELETE FROM documents WHERE room = ? AND type = ?", (room, doc_type)
            )
            self._commit(conn)
            return cursor.rowcount if cursor.rowcount != -1 else 0

    async def doc_delete_room(self, room: str) -> int:
        async with self._lock:
            conn = self._ensure_conn()
            cursor = conn.execute("DELETE FROM documents WHERE room = ?", (room,))
            self._commit(conn)
            return cursor.rowcount if cursor.rowcount != -1 else 0

    @staticmethod
    def _doc_row(row: tuple) -> dict:
        return {
            "room": row[0],
            "type": row[1],
            "id": row[2],
            "schema_version": row[3],
            "data": row[4],
            "meta": row[5],
            "grants": row[6],
            "seq": row[7],
        }

    # ------------------------------------------------------------------
    # Room-state table (M17) — room-scoped runtime/machinery values. The
    # room lives in its own COLUMN, so a whole room enumerates/backs up/
    # deletes without any key allowlist.
    # ------------------------------------------------------------------

    async def state_get(self, room: str, key: str) -> str | None:
        async with self._lock:
            conn = self._ensure_conn()
            row = conn.execute(
                "SELECT value FROM room_state WHERE room = ? AND key = ?", (room, key)
            ).fetchone()
            return row[0] if row is not None else None

    async def state_set(self, room: str, key: str, value: str | None) -> None:
        async with self._lock:
            conn = self._ensure_conn()
            conn.execute(
                "INSERT OR REPLACE INTO room_state (room, key, value) VALUES (?, ?, ?)",
                (room, key, value),
            )
            self._commit(conn)

    async def state_delete(self, room: str, key: str) -> None:
        async with self._lock:
            conn = self._ensure_conn()
            conn.execute("DELETE FROM room_state WHERE room = ? AND key = ?", (room, key))
            self._commit(conn)

    async def state_list(self, room: str, prefix: str | None = None) -> list[dict[str, str | None]]:
        """`room`'s runtime rows, optionally narrowed to keys starting with `prefix`."""
        async with self._lock:
            conn = self._ensure_conn()
            if prefix is None:
                rows = conn.execute(
                    "SELECT key, value FROM room_state WHERE room = ?", (room,)
                ).fetchall()
            else:
                escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                rows = conn.execute(
                    "SELECT key, value FROM room_state WHERE room = ? AND key LIKE ? ESCAPE '\\'",
                    (room, f"{escaped}%"),
                ).fetchall()
            return [{"key": row[0], "value": row[1]} for row in rows]

    async def state_delete_keys(self, room: str, keys: Iterable[str] = (), prefixes: Iterable[str] = ()) -> int:
        """Delete `room` rows matching any exact key or key prefix; return the count."""
        exact = list(keys)
        prefix_list = list(prefixes)
        deleted = 0
        async with self._lock:
            conn = self._ensure_conn()
            if exact:
                cursor = conn.executemany(
                    "DELETE FROM room_state WHERE room = ? AND key = ?",
                    [(room, key) for key in exact],
                )
                deleted += cursor.rowcount if cursor.rowcount != -1 else 0
            for prefix in prefix_list:
                escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                cursor = conn.execute(
                    "DELETE FROM room_state WHERE room = ? AND key LIKE ? ESCAPE '\\'",
                    (room, f"{escaped}%"),
                )
                deleted += cursor.rowcount if cursor.rowcount != -1 else 0
            self._commit(conn)
            return deleted

    async def state_delete_room(self, room: str) -> int:
        async with self._lock:
            conn = self._ensure_conn()
            cursor = conn.execute("DELETE FROM room_state WHERE room = ?", (room,))
            self._commit(conn)
            return cursor.rowcount if cursor.rowcount != -1 else 0

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
            self._store._commit(conn)

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
            self._store._commit(conn)
            return True
