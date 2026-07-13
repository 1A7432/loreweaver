"""POSIX integration checks for owner-only local persistence."""

from __future__ import annotations

import os
import stat
from unittest.mock import patch

import pytest

from app import _app_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.file_permissions import atomic_write_private
from infra.llm import FakeLLM


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
async def test_default_data_directory_and_database_are_owner_only(tmp_path):
    data_dir = tmp_path / "private-data"
    services = _app_services(
        Settings(data_dir=str(data_dir)),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(64),
    )

    assert stat.S_IMODE(data_dir.stat().st_mode) == 0o700
    await services.store.set(
        user_key="", store_key="runtime_config.credentials", value="secret"
    )
    db_path = data_dir / "loreweaver.db"
    assert stat.S_IMODE(db_path.stat().st_mode) == 0o600
    services.store.close()


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
def test_data_directory_stays_private_with_an_external_database(tmp_path):
    data_dir = tmp_path / "private-data"
    shared_db_parent = tmp_path / "shared-db"
    shared_db_parent.mkdir(mode=0o755)
    services = _app_services(
        Settings(data_dir=str(data_dir), db_path=str(shared_db_parent / "state.db")),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(64),
    )

    assert stat.S_IMODE(data_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(shared_db_parent.stat().st_mode) == 0o755
    services.store.close()


@pytest.mark.skipif(os.name != "posix", reason="exact permission bits are POSIX-only")
def test_atomic_private_write_never_exposes_the_new_file(tmp_path):
    target = tmp_path / "secret.txt"

    atomic_write_private(target, "top-secret")

    assert target.read_text(encoding="utf-8") == "top-secret"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not list(tmp_path.glob(".secret.txt.*.tmp"))


def test_atomic_private_write_preserves_old_file_when_replace_fails(tmp_path):
    target = tmp_path / "secret.txt"
    target.write_text("old", encoding="utf-8")

    with patch("infra.file_permissions.os.replace", side_effect=OSError("disk full")):
        with pytest.raises(OSError, match="disk full"):
            atomic_write_private(target, "new")

    assert target.read_text(encoding="utf-8") == "old"
    assert not list(tmp_path.glob(".secret.txt.*.tmp"))
