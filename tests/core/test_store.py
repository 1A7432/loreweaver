"""Tests for infra.store.Store and infra.store.MigrationRunner.

Covers the `FakeStore`-compatible contract (get/set/delete keyed by
user_key + store_key) for both the in-memory default and a file-backed
database, plus MigrationRunner idempotency.
"""

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from infra.store import MigrationRunner, Store


async def test_memory_store_get_set_delete_round_trip():
    store = Store()  # defaults to ":memory:"

    assert await store.get(user_key="u1", store_key="k1") is None

    await store.set(user_key="u1", store_key="k1", value="v1")
    assert await store.get(user_key="u1", store_key="k1") == "v1"

    await store.delete(user_key="u1", store_key="k1")
    assert await store.get(user_key="u1", store_key="k1") is None


async def test_memory_store_shares_one_connection_across_calls():
    # Regression guard: a fresh sqlite3 ":memory:" connection per call would
    # make writes invisible to subsequent reads.
    store = Store(":memory:")
    await store.set(user_key="u1", store_key="a", value="1")
    await store.set(user_key="u1", store_key="b", value="2")

    assert await store.get(user_key="u1", store_key="a") == "1"
    assert await store.get(user_key="u1", store_key="b") == "2"


async def test_file_store_get_set_delete_round_trip(tmp_path: Path):
    db_path = tmp_path / "kv.sqlite3"
    store = Store(db_path)

    assert await store.get(user_key="u1", store_key="k1") is None

    await store.set(user_key="u1", store_key="k1", value="v1")
    assert await store.get(user_key="u1", store_key="k1") == "v1"

    await store.delete(user_key="u1", store_key="k1")
    assert await store.get(user_key="u1", store_key="k1") is None
    assert db_path.exists()


async def test_file_store_persists_across_instances(tmp_path: Path):
    db_path = tmp_path / "kv.sqlite3"

    store1 = Store(db_path)
    await store1.set(user_key="u1", store_key="k1", value="persisted")

    store2 = Store(db_path)
    assert await store2.get(user_key="u1", store_key="k1") == "persisted"


async def test_set_overwrites_existing_value():
    store = Store()
    await store.set(user_key="u1", store_key="k1", value="first")
    await store.set(user_key="u1", store_key="k1", value="second")

    assert await store.get(user_key="u1", store_key="k1") == "second"


async def test_delete_missing_is_a_noop():
    store = Store()

    # Must not raise even though nothing was ever set for this key.
    await store.delete(user_key="ghost", store_key="ghost")
    assert await store.get(user_key="ghost", store_key="ghost") is None


async def test_default_keys_are_empty_strings():
    store = Store()
    await store.set(value="v")
    assert await store.get() == "v"


async def test_keys_are_scoped_by_user_key_and_store_key():
    store = Store()
    await store.set(user_key="u1", store_key="k", value="a")
    await store.set(user_key="u2", store_key="k", value="b")
    await store.set(user_key="u1", store_key="other", value="c")

    assert await store.get(user_key="u1", store_key="k") == "a"
    assert await store.get(user_key="u2", store_key="k") == "b"
    assert await store.get(user_key="u1", store_key="other") == "c"


async def test_json_string_values_survive_round_trip():
    store = Store()
    payload = {"name": "Alice", "hp": 12, "tags": ["kp", "coc"], "nested": {"a": 1}}
    raw = json.dumps(payload)

    # Mirrors how character_manager/battle_report store JSON blobs, e.g.
    # `characters.{chat_key}.{char_name}`.
    await store.set(user_key="u1", store_key="characters.chat1.Alice", value=raw)
    stored = await store.get(user_key="u1", store_key="characters.chat1.Alice")

    assert stored == raw
    assert json.loads(stored) == payload


async def test_migration_runner_apply_is_idempotent():
    store = Store()
    runner = MigrationRunner(store)
    sql = "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)"

    assert await runner.apply("0001_create_widgets", sql) is True
    # Second call with the same name must be a skipped no-op, not an error
    # (re-running the CREATE TABLE would otherwise raise sqlite3.OperationalError).
    assert await runner.apply("0001_create_widgets", sql) is False


async def test_migration_runner_distinct_names_both_apply():
    store = Store()
    runner = MigrationRunner(store)

    assert await runner.apply("0001_init", "CREATE TABLE t1 (id INTEGER PRIMARY KEY)") is True
    assert await runner.apply("0002_init", "CREATE TABLE t2 (id INTEGER PRIMARY KEY)") is True


async def test_migration_runner_records_name_and_applied_at(tmp_path: Path):
    db_path = tmp_path / "migrations.sqlite3"
    store = Store(db_path)
    runner = MigrationRunner(store)

    assert await runner.apply("0001_init", "CREATE TABLE t (id INTEGER PRIMARY KEY)") is True

    # Verify persisted state independently via a raw connection to the same file.
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT name, applied_at FROM applied_migrations WHERE name = ?",
            ("0001_init",),
        ).fetchone()
    finally:
        conn.close()

    assert row is not None
    name, applied_at = row
    assert name == "0001_init"
    # Must be a valid ISO-8601 timestamp (datetime.utcnow().isoformat()).
    datetime.fromisoformat(applied_at)
