"""`.pack install <ref>` — landing a content pack on a RUNNING server, from the table.

Until this existed, installing a module meant shell access to the box: a keeper playing
over the wire could enable only what someone had already installed for them. The owner's
2026-08-19 verdict is that on a remote table install IS enable — the CLI's per-item
confirmation cannot be reproduced honestly across the wire, and a keeper who typed the ref
has already made the trust decision — so the reply carries the terminal's own disclosure
card plus one line saying plainly that the pack's code now runs in this room. Sharpened
2026-08-20: install means PLAYABLE, so it throws the pack's OTHER switches too — panels,
KP skills, and the world card when the pack ships exactly one. A per-item approval flow
is the thing this command exists to not have.

It shares ONE implementation with `python -m app --install` (`gateway.pack_install`), so
the two doors cannot drift over which directories a pack lands in or which caches are
cleared afterwards.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import core.rulepacks as rulepacks_module
import core.skills as skills_module
from agent.context import AgentCtx
from agent.services import build_services
from core.pack import MANIFEST_NAME, build_pack
from gateway.commands import CommandRouter
from gateway.ops import get_enabled_panel_packs, get_enabled_skills
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

RULEPACK_YAML = (
    "names: [tiderules, 潮汐规则]\n"
    "defaults:\n  力量: 7\n"
    # A dot-command dialect word, the way a real system pack ships one: the router
    # only routes it once its spec table has seen this pack.
    "commands:\n  tidemake: {action: make_char}\n"
)


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


WORLD_CARD_JSON = json.dumps(
    {
        "spec": "chara_card_v2",
        "data": {
            "name": "Tidewatch",
            "description": "The customs hall itself.",
            "extensions": {"loreweaver_hooks": ["on('turn_start', () => {});"]},
            "character_book": {
                "entries": [{"comment": "[InitVar]", "content": '{"潮位": [3, "tide"]}'}]
            },
        },
    }
)

MODULE_MANIFEST = """\
id: tidemodule
version: 1.0.0
name:
  en: Tide Module
  zh: 潮汐模组
description: A module pack whose install must leave the room playable.
authors: [ada]
license: MIT
engine:
  protocol: "2.0"
contents:
  skills: [skills/tideline]
  cards: [cards/world.json]
"""


def _built_module_pack(tmp_path: Path, *, cards: tuple[str, ...] = ("cards/world.json",)) -> Path:
    src = tmp_path / "module-src"
    (src / "skills/tideline").mkdir(parents=True)
    (src / "skills/tideline/SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (src / "cards").mkdir()
    for index, card in enumerate(cards):
        payload = json.loads(WORLD_CARD_JSON)
        payload["data"]["name"] = f"Tidewatch {index}" if index else "Tidewatch"
        (src / card).write_text(json.dumps(payload), encoding="utf-8")
    listed = "".join(f"    - {card}\n" for card in cards)
    (src / MANIFEST_NAME).write_text(
        MODULE_MANIFEST.replace("  cards: [cards/world.json]\n", f"  cards:\n{listed}"),
        encoding="utf-8",
    )
    return build_pack(src, tmp_path / "tidemodule.lwpack").path


async def test_installing_a_module_pack_leaves_the_room_playable(server, tmp_path):
    """The owner's line: one command, then play. Not one command and a checklist — a
    keeper who typed the ref does not want to be asked again about each switch."""
    router = CommandRouter(server)
    chat_key = "cli:dm:playable"

    reply = await router.dispatch(_keeper(chat_key), f".pack install {_built_module_pack(tmp_path)}")

    i18n = server.i18n.with_locale("en")
    # Panels, the skill, and the module itself — all live, without a second command.
    assert "tidemodule" in await get_enabled_panel_packs(server.store, chat_key)
    assert "tideline" in await get_enabled_skills(server.store, chat_key)
    assert await server.store.state_get(chat_key, "world_import")
    assert i18n.t("commands.pack.live_skill", id="tideline") in reply
    assert "tidemodule/cards/world.json" in reply
    # The risk line is what replaces the confirmations, so it must still be there.
    assert i18n.t("commands.pack.risk") in reply
    # Nothing is left for the keeper to run.
    assert i18n.t("commands.pack.next_header") not in reply

    # The MACHINERY landed, not just the card's name: the world half's `[InitVar]` tree
    # seeded this room's variables, which is what makes the module playable at all.
    from core.documents import MVU_ID

    mvu = await server.documents.get(chat_key, "mvu_tree", MVU_ID)
    assert mvu is not None and "潮位" in json.dumps(mvu.data, ensure_ascii=False)


async def test_several_world_cards_are_the_one_fork_left_to_a_human(server, tmp_path):
    """Which module this table is playing is not a fact an installer can read off a
    manifest — so the ONLY leftover line is that choice, named as the command."""
    router = CommandRouter(server)
    chat_key = "cli:dm:fork"
    pack = _built_module_pack(tmp_path, cards=("cards/world.json", "cards/other.json"))

    reply = await router.dispatch(_keeper(chat_key), f".pack install {pack}")

    i18n = server.i18n.with_locale("en")
    assert i18n.t("commands.pack.next_header") in reply
    assert "tidemodule/cards/world.json" in reply and "tidemodule/cards/other.json" in reply
    # Nothing was imported behind the keeper's back...
    assert await server.store.state_get(chat_key, "world_import") is None
    # ...but everything unambiguous still went live.
    assert "tideline" in await get_enabled_skills(server.store, chat_key)


async def test_a_skill_installed_by_another_process_enables_at_once(server, tmp_path):
    """The half-open door the throttle left: `.skill enable` used to read the LISTING,
    whose staleness check is time-throttled, so a skill installed by the desktop client
    seconds after any other lookup answered "unknown skill". This test deliberately does
    NOT shorten the interval — arming the throttle first is the whole point."""
    router = CommandRouter(server)
    chat_key = "cli:dm:enable-now"

    # Arm the throttle the way a live room does: something resolves, recording the scan.
    skills_module.load_skill("mature-mode")

    # ANOTHER PROCESS installs the pack — the desktop client shells out to the CLI, so
    # nothing in this process clears a cache. Writing the files is exactly what it leaves
    # behind. (Going through `install_pack_here` here would prove nothing: it reloads
    # discovery itself, which is the in-process door that already worked.)
    installed = Path(server.settings.data_dir) / "skills" / "tideline"
    installed.mkdir(parents=True)
    (installed / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")

    reply = await router.dispatch(_keeper(chat_key), ".skill enable tideline")

    i18n = server.i18n.with_locale("en")
    assert reply == i18n.t("commands.skill.enable_done", id="tideline"), reply
    assert "tideline" in await get_enabled_skills(server.store, chat_key)


async def test_a_world_import_that_fails_is_not_reported_as_a_module(server, tmp_path, monkeypatch):
    """`import_world_card` reports refusals as prose and writes its `world_import` marker
    partway through its own work, so a room that ALREADY ran a module keeps a truthy marker
    however the next import ends. Reading that marker back would have printed "module
    loaded" over a failure."""
    router = CommandRouter(server)
    chat_key = "cli:dm:failed-import"
    await server.store.state_set(chat_key, "world_import", "An Earlier Module")

    from agent import kp_tools_charcard

    async def refuse(self, ctx, file_path, system="", *, raise_on_failure=False):
        message = "the card could not be read"
        if raise_on_failure:
            raise kp_tools_charcard.CardImportRefused(message)
        return message

    monkeypatch.setattr(kp_tools_charcard.CharcardTools, "import_world_card", refuse)

    reply = await router.dispatch(_keeper(chat_key), f".pack install {_built_module_pack(tmp_path)}")

    i18n = server.i18n.with_locale("en")
    assert i18n.t("commands.pack.live_card", ref="tidemodule/cards/world.json") not in reply
    assert "tidemodule/cards/world.json" in reply  # named as the import to retry
    assert i18n.t("commands.pack.next_header") in reply
    # The skill still went live: one card failing is not the install failing.
    assert "tideline" in await get_enabled_skills(server.store, chat_key)


async def test_the_system_pin_is_claimed_only_when_the_room_is_really_on_it(server, tmp_path):
    """The summary said "and the pack's character system" unconditionally. A pack with no
    character system of its own pins nothing, and saying otherwise is the kind of line an
    operator would trust and then debug for an hour."""
    router = CommandRouter(server)
    chat_key = "cli:dm:no-pin"

    reply = await router.dispatch(_keeper(chat_key), f".pack install {_built_module_pack(tmp_path)}")

    i18n = server.i18n.with_locale("en")
    # This fixture ships no rulepack, so there is nothing to pin and nothing to claim.
    assert await server.store.state_get(chat_key, "room_system") is None
    assert i18n.t("commands.pack.live_card", ref="tidemodule/cards/world.json") in reply
    assert "coc7" not in reply


WORD_RULEPACK_YAML = "names: [wordrules]\ndefaults:\n  力量: 7\ncommands:\n  wordmake: {action: make_char}\n"


async def test_a_pack_word_installed_by_another_process_routes_at_once(server, tmp_path):
    """The dialect table is a SNAPSHOT: `CommandRouter` folds `all_command_words()` in when
    it is built, and it is built once per process. A pack installed afterwards by ANOTHER
    process (the desktop client shells out to the CLI) declared words that routed nowhere
    until a restart — even though discovery itself self-heals. Like its skills twin, this
    test deliberately does NOT shorten the throttle: arming it first is the whole point."""
    router = CommandRouter(server)
    chat_key = "cli:dm:word-now"

    # Arm the discovery throttle the way a live room does — anything that resolves.
    rulepacks_module.load_rulepack("coc7")

    rulepacks_dir = Path(server.settings.data_dir) / "rulepacks"
    rulepacks_dir.mkdir(parents=True, exist_ok=True)
    (rulepacks_dir / "wordrules.yaml").write_text(WORD_RULEPACK_YAML, encoding="utf-8")

    reply = await router.dispatch(_keeper(chat_key), ".wordmake Tidewalker")

    i18n = server.i18n.with_locale("en")
    assert reply is not None, "the pack's own make_char word routed nowhere"
    assert i18n.t("commands.character.created", name="Tidewalker", system="wordrules") in reply


async def test_installing_here_makes_the_packs_make_char_word_live(server, tmp_path):
    """The in-process door: `.pack install` knows a pack just landed, so its words work in
    the next breath rather than one throttle interval later."""
    router = CommandRouter(server)
    chat_key = "cli:dm:word-install"

    await router.dispatch(_keeper(chat_key), f".pack install {_built_pack(tmp_path)}")
    reply = await router.dispatch(_keeper(chat_key), ".tidemake Tidewalker")

    i18n = server.i18n.with_locale("en")
    assert reply is not None, "the installed pack's make_char word routed nowhere"
    assert i18n.t("commands.character.created", name="Tidewalker", system="tiderules") in reply
