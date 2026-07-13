"""Keystore.refresh(): a running server picks up keys minted after it booted,
without a restart (net.tui_server retries auth after a refresh on a key miss)."""
import multiprocessing
import os
import stat
from pathlib import Path
from unittest.mock import patch

import pytest

from net.keystore import KeyEntry, Keystore, member_id_for_key


def _blocking_keystore_save(path: str, entered, release) -> None:
    """Process helper: pause in the atomic writer while the keystore lock is held."""
    import net.keystore as keystore_module

    keystore = Keystore.load(path)
    keystore.add(room="room-a", name="process-a")
    original_write = keystore_module.atomic_write_private

    def blocked_write(target, data, *, encoding="utf-8"):
        entered.set()
        if not release.wait(10):
            raise TimeoutError("test did not release keystore writer")
        original_write(target, data, encoding=encoding)

    keystore_module.atomic_write_private = blocked_write
    keystore.save()


def _signalling_keystore_save(path: str, finished) -> None:
    keystore = Keystore.load(path)
    keystore.add(room="room-b", name="process-b")
    keystore.save()
    finished.set()


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


def test_stale_saves_merge_independently_added_keys(tmp_path: Path):
    path = tmp_path / "keys.toml"
    first = Keystore.load(path)
    second = Keystore.load(path)

    first_key = first.add(room="arkham", name="Ada")
    second_key = second.add(room="dunwich", name="Eve")
    first.save()
    second.save()

    reloaded = Keystore.load(path)
    assert reloaded.get(first_key) is not None
    assert reloaded.get(second_key) is not None
    assert {entry.name for entry in reloaded.entries()} == {"Ada", "Eve"}


def test_stale_field_edit_does_not_undo_external_role_downgrade(tmp_path: Path):
    path = tmp_path / "keys.toml"
    initial = Keystore.load(path)
    key = initial.add(room="arkham", name="Old", role="keeper")
    initial.save()

    name_editor = Keystore.load(path)
    role_editor = Keystore.load(path)
    assert name_editor.update(key, name="Renamed")
    assert role_editor.update(key, role="player")
    role_editor.save()
    name_editor.save()

    entry = Keystore.load(path).get(key)
    assert entry is not None
    assert entry.name == "Renamed"
    assert entry.role == "player"


@pytest.mark.skipif(os.name != "posix", reason="cross-process lock assertion uses POSIX flock")
def test_cross_process_save_waits_for_lock_and_merges_latest_file(tmp_path: Path):
    path = tmp_path / "keys.toml"
    Keystore.load(path).save()
    context = multiprocessing.get_context("spawn")
    entered = context.Event()
    release = context.Event()
    finished = context.Event()
    first = context.Process(target=_blocking_keystore_save, args=(str(path), entered, release))
    second = context.Process(target=_signalling_keystore_save, args=(str(path), finished))
    try:
        first.start()
        assert entered.wait(5), "first process never reached the locked writer"
        second.start()
        assert not finished.wait(0.25), "second writer bypassed the cross-process lock"
        release.set()
        first.join(10)
        second.join(10)
        assert first.exitcode == 0
        assert second.exitcode == 0
    finally:
        release.set()
        if first.is_alive():
            first.terminate()
            first.join(5)
        if second.is_alive():
            second.terminate()
            second.join(5)

    assert {entry.name for entry in Keystore.load(path).entries()} == {"process-a", "process-b"}


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
def test_save_tightens_keystore_to_owner_only(tmp_path: Path):
    path = tmp_path / "keys.toml"
    path.write_text("", encoding="utf-8")
    os.chmod(path, 0o666)
    keystore = Keystore.load(path)
    keystore.add(room="arkham", role="keeper")

    keystore.save()

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
def test_save_creates_new_keystore_directories_owner_only(tmp_path: Path):
    private_dir = tmp_path / "one" / "two"
    path = private_dir / "keys.toml"
    keystore = Keystore.load(path)
    keystore.add(room="arkham", role="keeper")

    keystore.save()

    assert stat.S_IMODE((tmp_path / "one").stat().st_mode) == 0o700
    assert stat.S_IMODE(private_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


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


def test_refresh_reflects_disk_deletion_and_role_downgrade(tmp_path: Path):
    path = tmp_path / "keys.toml"
    writer = Keystore.load(path)
    downgraded = writer.add(room="r1", name="Keeper", role="keeper")
    deleted = writer.add(room="r1", name="Revoked", role="keeper")
    writer.save()
    running = Keystore.load(path)

    external = Keystore.load(path)
    assert external.update(downgraded, role="player")
    assert external.remove(deleted)
    external.save()
    # The running process still has its boot-time view until an authoritative refresh.
    assert running.get(downgraded).role == "keeper"
    assert running.get(deleted) is not None

    running.refresh()

    entry = running.get(downgraded)
    assert entry is not None and entry.role == "player"
    assert running.get(deleted) is None


def test_refresh_treats_missing_backing_file_as_revocation(tmp_path: Path):
    path = tmp_path / "keys.toml"
    keystore = Keystore.load(path)
    key = keystore.add(room="r1", role="keeper")
    keystore.save()

    path.unlink()
    keystore.refresh()

    assert keystore.get(key) is None


def test_authorize_member_uses_current_disk_role_room_and_revocation(tmp_path: Path):
    path = tmp_path / "keys.toml"
    running = Keystore.load(path)
    key = running.add(room="arkham", name="Keeper", role="keeper")
    running.save()
    member_id = member_id_for_key(key)

    active = running.authorize_member(member_id, room="arkham", required_role="keeper")
    assert active is not None and active.key == key
    assert running.authorize_member(member_id, room="dunwich") is None

    external = Keystore.load(path)
    assert external.update(key, role="player")
    external.save()
    assert running.authorize_member(member_id, room="arkham", required_role="keeper") is None
    downgraded = running.authorize_member(member_id, room="arkham", required_role="player")
    assert downgraded is not None and downgraded.role == "player"
    assert running.get(key).role == "player"  # adjacent reads cannot observe the stale keeper role

    external = Keystore.load(path)
    assert external.remove(key)
    external.save()
    assert running.authorize_member(member_id, room="arkham") is None
    assert running.get(key) is None


def test_authorize_member_fails_closed_on_derived_id_collision():
    keystore = Keystore(
        {
            "key-a": KeyEntry(key="key-a", room="arkham", role="keeper"),
            "key-b": KeyEntry(key="key-b", room="arkham", role="keeper"),
        }
    )
    with patch("net.keystore.member_id_for_key", return_value="tui:collision"):
        assert keystore.authorize_member("tui:collision", room="arkham", required_role="keeper") is None


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
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE((tmp_path / "keeper-key.txt").stat().st_mode) == 0o600

    reloaded = Keystore.load(path)
    _bootstrap_keystore(reloaded, I18n(), str(path))
    assert len(reloaded._entries) == 1


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
def test_ticket_sidecar_is_owner_only(tmp_path: Path):
    from app import _announce_iroh_ticket
    from infra.i18n import I18n

    _announce_iroh_ticket(I18n(), "secret-ticket", str(tmp_path / "keys.toml"))

    ticket = tmp_path / "iroh-ticket.txt"
    assert "secret-ticket" in ticket.read_text(encoding="utf-8")
    assert stat.S_IMODE(ticket.stat().st_mode) == 0o600


def test_persisted_mutation_rolls_memory_and_disk_back_on_write_failure(tmp_path: Path):
    path = tmp_path / "keys.toml"
    keystore = Keystore.load(path)
    original = keystore.add(room="arkham", name="Ada")
    keystore.save()
    before = path.read_bytes()

    with patch("net.keystore.atomic_write_private", side_effect=OSError("disk full")):
        with pytest.raises(OSError, match="disk full"):
            with keystore.persisted_mutation():
                keystore.remove(original)
                keystore.add(room="dunwich", name="Eve")

    assert keystore.get(original) is not None
    assert [entry.room for entry in keystore.entries()] == ["arkham"]
    assert path.read_bytes() == before


def test_direct_save_failure_discards_unpersisted_memory_mutation(tmp_path: Path):
    path = tmp_path / "keys.toml"
    keystore = Keystore.load(path)
    original = keystore.add(room="arkham", name="Ada")
    keystore.save()
    attempted = keystore.add(room="dunwich", name="Eve")
    before = path.read_bytes()

    with patch("net.keystore.atomic_write_private", side_effect=OSError("disk full")):
        with pytest.raises(OSError, match="disk full"):
            keystore.save()

    assert keystore.get(original) is not None
    assert keystore.get(attempted) is None
    assert path.read_bytes() == before


def test_read_failure_before_persist_also_discards_pending_memory_mutation(tmp_path: Path):
    path = tmp_path / "keys.toml"
    keystore = Keystore.load(path)
    original = keystore.add(room="arkham", name="Ada")
    keystore.save()
    attempted = keystore.add(room="dunwich", name="Eve")

    with patch("net.keystore._read_entries", side_effect=OSError("read failed")):
        with pytest.raises(OSError, match="read failed"):
            keystore.save()

    assert keystore.get(original) is not None
    assert keystore.get(attempted) is None


def test_failed_persisted_mutation_rolls_memory_to_latest_locked_snapshot(tmp_path: Path):
    path = tmp_path / "keys.toml"
    running = Keystore.load(path)
    original = running.add(room="arkham", name="Ada")
    running.save()

    external = Keystore.load(path)
    external_key = external.add(room="dunwich", name="External")
    external.save()
    attempted = ""
    with patch("net.keystore.atomic_write_private", side_effect=OSError("disk full")):
        with pytest.raises(OSError, match="disk full"):
            with running.persisted_mutation():
                attempted = running.add(room="innsmouth", name="Attempted")

    assert running.get(original) is not None
    assert running.get(external_key) is not None
    assert running.get(attempted) is None
    assert {entry.name for entry in Keystore.load(path).entries()} == {"Ada", "External"}
