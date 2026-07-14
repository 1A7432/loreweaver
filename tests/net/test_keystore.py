import os
import stat
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from net.keystore import KeyEntry, Keystore, member_id_for_key


def test_legacy_toml_defaults_to_join_purpose(tmp_path: Path):
    path = tmp_path / "keys.toml"
    path.write_text('["legacy"]\nroom = "arkham"\nrole = "keeper"\n', encoding="utf-8")

    entry = Keystore.load(path).get("legacy")

    assert entry is not None
    assert entry.purpose == "join"


def test_chat_bind_token_is_single_use(tmp_path: Path):
    keystore = Keystore.load(tmp_path / "keys.toml")
    with keystore.persisted_mutation():
        token = keystore.add(
            room="arkham",
            role="keeper",
            purpose="chat_bind",
            expires_at=time.time() + 60,
        )

    assert keystore.get(token) is None
    assert keystore.authorize_member(member_id_for_key(token), room="arkham") is None
    consumed = keystore.consume(token, purpose="chat_bind", required_role="keeper")
    assert consumed is not None and consumed.room == "arkham"
    assert keystore.consume(token, purpose="chat_bind", required_role="keeper") is None
    assert Keystore.load(keystore.path).get(token, purpose=None) is None


def test_expired_tokens_are_hidden_and_removed_when_consumed(tmp_path: Path):
    keystore = Keystore.load(tmp_path / "keys.toml")
    with keystore.persisted_mutation():
        token = keystore.add(
            room="arkham",
            role="keeper",
            purpose="chat_bind",
            expires_at=time.time() - 1,
        )

    assert keystore.entries(purpose=None) == []
    assert keystore.consume(token, purpose="chat_bind", required_role="keeper") is None
    assert Keystore.load(keystore.path).get(token, purpose=None) is None


def test_only_active_join_keys_count_for_bootstrap():
    keystore = Keystore(
        {
            "expired": KeyEntry(
                key="expired",
                room="arkham",
                expires_at=time.time() - 1,
            ),
            "bind": KeyEntry(
                key="bind",
                room="arkham",
                role="keeper",
                purpose="chat_bind",
                expires_at=time.time() + 60,
            ),
        }
    )

    assert keystore.is_empty()


def test_authorization_refreshes_external_role_and_revocation(tmp_path: Path):
    path = tmp_path / "keys.toml"
    running = Keystore.load(path)
    with running.persisted_mutation():
        key = running.add(room="arkham", role="keeper")
    member_id = member_id_for_key(key)

    assert running.authorize_member(member_id, room="arkham", required_role="keeper")

    external = Keystore.load(path)
    with external.persisted_mutation():
        assert external.update(key, role="player")
    assert running.authorize_member(member_id, room="arkham", required_role="keeper") is None
    assert running.authorize_member(member_id, room="arkham", required_role="player")

    with external.persisted_mutation():
        assert external.remove(key)
    assert running.authorize_member(member_id, room="arkham") is None


def test_authorization_does_not_reparse_unchanged_file(tmp_path: Path):
    keystore = Keystore.load(tmp_path / "keys.toml")
    with keystore.persisted_mutation():
        key = keystore.add(room="arkham", role="keeper")

    with patch("net.keystore._read_entries") as read_entries:
        assert keystore.authorize_member(
            member_id_for_key(key),
            room="arkham",
            required_role="keeper",
        )
        assert keystore.authorize_member(
            member_id_for_key(key),
            room="arkham",
            required_role="keeper",
        )

    read_entries.assert_not_called()


def test_persisted_mutation_starts_from_latest_file(tmp_path: Path):
    path = tmp_path / "keys.toml"
    stale = Keystore.load(path)
    external = Keystore.load(path)
    with external.persisted_mutation():
        external_key = external.add(room="dunwich", name="External")

    with stale.persisted_mutation():
        local_key = stale.add(room="arkham", name="Local")

    reloaded = Keystore.load(path)
    assert reloaded.get(external_key) is not None
    assert reloaded.get(local_key) is not None


def test_failed_write_leaves_file_intact(tmp_path: Path):
    path = tmp_path / "keys.toml"
    keystore = Keystore.load(path)
    with keystore.persisted_mutation():
        original = keystore.add(room="arkham", name="Ada")
    before = path.read_bytes()
    attempted = ""

    with patch("net.keystore.atomic_write_private", side_effect=OSError("disk full")):
        with pytest.raises(OSError, match="disk full"):
            with keystore.persisted_mutation():
                keystore.remove(original)
                attempted = keystore.add(room="dunwich", name="Eve")

    assert path.read_bytes() == before
    assert keystore.get(original) is not None
    assert keystore.get(attempted) is None


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
def test_persisted_mutation_creates_private_file(tmp_path: Path):
    path = tmp_path / "private" / "keys.toml"
    keystore = Keystore.load(path)

    with keystore.persisted_mutation():
        keystore.add(room="arkham", role="keeper")

    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_bootstrap_mints_one_keeper_key(tmp_path: Path):
    from app import _bootstrap_keystore
    from infra.i18n import I18n

    path = tmp_path / "keys.toml"
    keystore = Keystore.load(path)
    _bootstrap_keystore(keystore, I18n(), str(path))
    _bootstrap_keystore(Keystore.load(path), I18n(), str(path))

    entries = Keystore.load(path).entries()
    assert len(entries) == 1
    assert entries[0].role == "keeper"
    assert entries[0].key in (tmp_path / "keeper-key.txt").read_text(encoding="utf-8")
