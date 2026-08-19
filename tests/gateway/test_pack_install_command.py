"""`.pack install <ref>` — landing a content pack on a RUNNING server, from the table.

Until this existed, installing a module meant shell access to the box: a keeper playing
over the wire could enable only what someone had already installed for them. The owner's
2026-08-19 verdict is that on a remote table install IS enable — the CLI's per-item
confirmation cannot be reproduced honestly across the wire, and a keeper who typed the ref
has already made the trust decision — so the reply carries the terminal's own disclosure
card plus one line saying plainly that the pack's code now runs in this room.

It shares ONE implementation with `python -m app --install` (`gateway.pack_install`), so
the two doors cannot drift over which directories a pack lands in or which caches are
cleared afterwards.
"""

from __future__ import annotations

from pathlib import Path

import core.rulepacks as rulepacks_module
import core.skills as skills_module
import pytest
from agent.context import AgentCtx
from agent.services import build_services
from core.pack import MANIFEST_NAME, build_pack
from gateway.commands import CommandRouter
from gateway.ops import get_enabled_panel_packs
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

SKILL_MD = """---
name: Tideline
description: Reads the tide.
---
Answer with the tide.
"""

MANIFEST = """\
id: tidepack
version: 1.0.0
name:
  en: Tide Pack
  zh: 潮汐扩展包
description: A fixture pack for the in-room installer.
authors: [ada]
license: MIT
engine:
  protocol: "2.0"
contents:
  skills: [skills/tideline]
  rulepacks: [rulepacks/tiderules.yaml]
"""

RULEPACK_YAML = "names: [tiderules, 潮汐规则]\ndefaults:\n  力量: 7\n"


def _built_pack(tmp_path: Path) -> Path:
    src = tmp_path / "pack-src"
    (src / "skills/tideline").mkdir(parents=True)
    (src / "skills/tideline/SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (src / "rulepacks").mkdir()
    (src / "rulepacks/tiderules.yaml").write_text(RULEPACK_YAML, encoding="utf-8")
    (src / MANIFEST_NAME).write_text(MANIFEST, encoding="utf-8")
    return build_pack(src, tmp_path / "tidepack.lwpack").path


@pytest.fixture
def server(tmp_path):
    """A services bundle whose discovery dirs are wired the way `app.py` wires them."""
    settings = Settings(locale="en")
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    original = (skills_module._USER_SKILL_DIR, rulepacks_module._USER_RULEPACK_DIR)
    skills_module._USER_SKILL_DIR = Path(settings.data_dir) / "skills"
    rulepacks_module._USER_RULEPACK_DIR = Path(settings.data_dir) / "rulepacks"
    skills_module.reload_skills()
    rulepacks_module.reload_rulepacks()
    try:
        yield services
    finally:
        skills_module._USER_SKILL_DIR, rulepacks_module._USER_RULEPACK_DIR = original
        skills_module.reload_skills()
        rulepacks_module.reload_rulepacks()


def _keeper(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="kp", platform="cli", locale="en")


def _player(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", locale="en", extra={"role": "player"})


async def test_a_keeper_installs_a_pack_and_it_is_live_in_this_room(server, tmp_path):
    router = CommandRouter(server)
    chat_key = "cli:dm:install"
    pack = _built_pack(tmp_path)

    reply = await router.dispatch(_keeper(chat_key), f".pack install {pack}")

    i18n = server.i18n.with_locale("en")
    assert i18n.t("commands.pack.installed", id="tidepack", version="1.0.0") in reply
    # The terminal's own disclosure card, verbatim — counts and the code flags.
    assert "1 skill(s)" in reply and "1 rulepack(s)" in reply
    assert "hooks code: no" in reply
    # ...and the one line the wire adds, because nothing confirmed item by item.
    assert reply.endswith(i18n.t("commands.pack.risk"))

    # It landed on THIS server, in the dirs `--install` uses.
    assert (Path(server.settings.data_dir) / "skills" / "tideline" / "SKILL.md").is_file()
    assert (Path(server.settings.data_dir) / "rulepacks" / "tiderules.yaml").is_file()

    # Enabled for this room — install IS enable on a remote table.
    assert "tidepack" in await get_enabled_panel_packs(server.store, chat_key)

    # And immediately usable: the rulepack resolves by every name it declares, with no
    # restart and no cache to clear by hand (see `core.rulepacks` discovery self-heal).
    assert rulepacks_module.load_rulepack("tiderules").system == "tiderules"
    assert rulepacks_module.load_rulepack("潮汐规则").system == "tiderules"
    assert skills_module.load_skill("tideline") is not None


async def test_a_player_cannot_install_anything(server, tmp_path):
    router = CommandRouter(server)
    chat_key = "tui:group:install"
    pack = _built_pack(tmp_path)

    reply = await router.dispatch(_player(chat_key), f".pack install {pack}")

    assert reply == server.i18n.with_locale("en").t("rooms.denied")
    assert not (Path(server.settings.data_dir) / "rulepacks" / "tiderules.yaml").exists()
    assert await get_enabled_panel_packs(server.store, chat_key) == []


async def test_an_unresolvable_ref_reports_and_changes_nothing(server):
    router = CommandRouter(server)

    reply = await router.dispatch(_keeper("cli:dm:badref"), ".pack install gh:not-a-ref")

    assert "gh ref" in reply
    assert await get_enabled_panel_packs(server.store, "cli:dm:badref") == []


async def test_a_bare_or_unknown_subcommand_prints_the_usage(server):
    router = CommandRouter(server)
    usage = server.i18n.with_locale("en").t("commands.pack.usage")

    assert await router.dispatch(_keeper("cli:dm:usage"), ".pack") == usage
    assert await router.dispatch(_keeper("cli:dm:usage"), ".pack install") == usage
    assert await router.dispatch(_keeper("cli:dm:usage"), ".pack remove tidepack") == usage
