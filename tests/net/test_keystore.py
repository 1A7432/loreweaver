"""Keystore.refresh(): a running server picks up keys minted after it booted,
without a restart (net.tui_server retries auth after a refresh on a key miss)."""
from pathlib import Path

from net.keystore import Keystore


def test_refresh_picks_up_keys_added_to_file_after_load(tmp_path: Path):
    path = tmp_path / "keys.toml"
    server_ks = Keystore.load(path)  # server boots on an empty file
    # Later, `--tui-key add` (a separate process) mints a key into the same file.
    minter = Keystore.load(path)
    key = minter.add(room="shuxue", name="Alice")
    minter.save()
    assert server_ks.get(key) is None  # running server hasn't seen it yet
    server_ks.refresh()
    entry = server_ks.get(key)
    assert entry is not None and entry.room == "shuxue" and entry.name == "Alice"


def test_refresh_keeps_in_memory_keys(tmp_path: Path):
    path = tmp_path / "keys.toml"
    ks = Keystore.load(path)
    mem_key = ks.add(room="r1", name="mem")  # in memory, not yet persisted
    other = Keystore.load(path)
    disk_key = other.add(room="r2")
    other.save()
    ks.refresh()
    assert ks.get(mem_key) is not None  # in-memory entry survives a refresh
    assert ks.get(disk_key) is not None  # newly-on-disk entry is picked up


def test_refresh_noop_for_pathless_keystore():
    ks = Keystore()  # in-memory (tests); no backing file
    ks.refresh()  # must not raise
    assert ks.entries() == []


def test_is_empty_and_bootstrap_mints_one_keeper_key(tmp_path: Path):
    """First-run bootstrap: an empty keystore auto-mints exactly one keeper key + a sidecar,
    and is idempotent (never double-mints once a key exists)."""
    from app import _bootstrap_keystore
    from infra.i18n import I18n

    path = tmp_path / "keys.toml"
    ks = Keystore.load(path)
    assert ks.is_empty()

    _bootstrap_keystore(ks, I18n(), str(path))
    assert not ks.is_empty()
    entries = list(ks._entries.values())
    assert len(entries) == 1 and entries[0].role == "keeper"
    sidecar = (tmp_path / "keeper-key.txt").read_text()
    assert entries[0].key in sidecar and "role=keeper" in sidecar

    reloaded = Keystore.load(path)
    _bootstrap_keystore(reloaded, I18n(), str(path))
    assert len(reloaded._entries) == 1
