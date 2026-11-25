"""Dev rooms (`gateway.dev_room`) — mount a pack SOURCE dir, reload on save.

Covers the three properties that make the feature shippable: confinement (a server
path read gets the networked-admin posture — off by default, root-confined when on),
reload correctness (edits land, orphans leave, live variable values survive), and
lifecycle (watcher armed/cancelled, mount record is the ground truth).
"""

from __future__ import annotations

import asyncio
import json

import pytest

from agent.context import AgentCtx
from agent.services import build_services
from gateway import dev_room
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

CHAT = "tui:group:devroom"

LOREBOOK = {
    "entries": [
        {"comment": "Lighthouse", "key": ["lighthouse"], "content": "It burns green."},
        {"comment": "Cellar", "key": ["cellar"], "content": "Sealed."},
    ]
}

WORLD_CARD = {
    "format": "loreweaver.card",
    "format_version": 1,
    "name": "回廊公寓",
    "description": "A corridor building.",
    "scenario": "Find the missing tenant.",
    "opening": "Rain again.",
    "variables": [
        {"id": "suspicion", "kind": "number", "default": 0, "minimum": 0, "maximum": 10}
    ],
    "worldbook": [],
}

SKILL_MD = "---\nname: Dev Omen\ndescription: dev-mounted skill\n---\nSpeak in omens.\n"
RULEPACK_YAML = "names: [devpulp]\ndefaults:\n  力量: 7\n"

MANIFEST = (
    "id: devpack\nversion: 0.1.0\nname: Devpack\ndescription: dev fixture\nauthors: [ada]\n"
    "license: MIT\nengine: {}\ncontents:\n"
    "  cards: [cards/corridor.lorecard.json]\n"
    "  lorebooks: [lorebooks/manor.json]\n"
    "  skills: [skills/dev-omen]\n"
    "  rulepacks: [rulepacks/devpulp.yaml]\n"
)


def _write_source(root):
    src = root / "src-root" / "devpack"
    (src / "cards").mkdir(parents=True)
    (src / "cards/corridor.lorecard.json").write_text(json.dumps(WORLD_CARD, ensure_ascii=False), encoding="utf-8")
    (src / "lorebooks").mkdir()
    (src / "lorebooks/manor.json").write_text(json.dumps(LOREBOOK), encoding="utf-8")
    (src / "skills/dev-omen").mkdir(parents=True)
    (src / "skills/dev-omen/SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (src / "rulepacks").mkdir()
    (src / "rulepacks/devpulp.yaml").write_text(RULEPACK_YAML, encoding="utf-8")
    (src / "pack.yaml").write_text(MANIFEST, encoding="utf-8")
    return src


def _services(tmp_path, *, root=True):
    settings = Settings(
        data_dir=str(tmp_path / "data"),
        dev={"source_root": str(tmp_path / "src-root")} if root else {},
    )
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


@pytest.fixture(autouse=True)
def _clean_globals():
    yield
    for task in dev_room._WATCHERS.values():
        task.cancel()
    dev_room._WATCHERS.clear()
    dev_room._MOUNTS.clear()
    dev_room._sync_registries()


async def test_mount_is_confined_and_off_by_default(tmp_path):
    src = _write_source(tmp_path)
    off = _services(tmp_path, root=False)
    assert dev_room.resolve_source(off, str(src)) == "dev.commands.disabled"

    services = _services(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    assert dev_room.resolve_source(services, str(outside)) == "dev.commands.outside_root"
    assert dev_room.resolve_source(services, str(tmp_path / "src-root" / "nope")) == "dev.commands.outside_root"
    empty = tmp_path / "src-root" / "empty"
    empty.mkdir(parents=True)
    assert dev_room.resolve_source(services, str(empty)) == "dev.commands.no_manifest"
    assert dev_room.resolve_source(services, str(src)) == src.resolve()


async def test_mount_reload_edit_cycle_syncs_the_room(tmp_path):
    from core.modvars import load_modvars, set_modvar
    from core.rulepacks import load_rulepack
    from core.skills import load_skill
    from gateway.panels import installed_pack_homes

    src = _write_source(tmp_path)
    services = _services(tmp_path)

    reply = await dev_room.mount(services, None, CHAT, str(src), "en")
    assert "devpack" in reply

    # Everything from the source is live: lore, skill, rulepack, virtual pack home.
    titles = {entry.title: entry for entry in await services.worldbook.list(CHAT)}
    assert titles["Lighthouse"].content == "It burns green."
    assert "Cellar" in titles
    assert load_skill("dev-omen") is not None
    assert load_rulepack("devpulp") is not None
    assert installed_pack_homes(services.settings.data_dir).get("devpack") == src.resolve()
    # The world card seeded its typed variable.
    assert "suspicion" in (await load_modvars(services.documents, CHAT))["specs"]

    # A live value written between reloads survives the next reload (InitVar-merge
    # semantics for the tree, keep-current-value semantics for typed specs).
    await set_modvar(services.documents, CHAT, "suspicion", 7)
    # The hooks' private `setstate` store is preserved the same way: nothing on the reload
    # path touches it.
    await services.store.state_set(CHAT, "hook_state:ledger", '{"crossed":475}')

    # The author edits one entry and deletes another; the reload replaces, never stacks.
    edited = {
        "entries": [
            {"comment": "Lighthouse", "key": ["lighthouse"], "content": "It burns RED now."}
        ]
    }
    (src / "lorebooks/manor.json").write_text(json.dumps(edited), encoding="utf-8")
    summary = await dev_room.reload(services, None, CHAT, "en")
    assert "1" in summary

    titles = {entry.title: entry for entry in await services.worldbook.list(CHAT)}
    assert titles["Lighthouse"].content == "It burns RED now."
    assert "Cellar" not in titles  # the orphan left with its source
    assert (await load_modvars(services.documents, CHAT))["values"]["suspicion"] == 7
    assert await services.store.state_get(CHAT, "hook_state:ledger") == '{"crossed":475}'

    # A source tree that stops parsing reports and changes nothing.
    (src / "pack.yaml").write_text("id: [broken", encoding="utf-8")
    failed = await dev_room.reload(services, None, CHAT, "en")
    assert failed == services.i18n.with_locale("en").t("dev.commands.reload_failed", error=failed.split(": ", 1)[-1])
    titles = {entry.title for entry in await services.worldbook.list(CHAT)}
    assert "Lighthouse" in titles


class _Recorder:
    """A room member that keeps what it was sent."""

    transport = "test"

    def __init__(self, user_key: str) -> None:
        self.id = f"conn-{user_key}"
        self.user_key = user_key
        self.texts: list[str] = []

    async def deliver(self, event) -> None:
        self.texts.append(event.text)


async def test_pack_check_follows_a_reload_and_stays_advisory(tmp_path):
    """The check is run on the tree that was just reloaded, cut to a chat-sized head, and
    never part of the reload itself: the mount lands either way, a fixed file clears it."""
    src = _write_source(tmp_path)
    services = _services(tmp_path)

    reply = await dev_room.mount(services, None, CHAT, str(src), "en")
    assert "var-unused" not in reply  # the reload summary is counts, as it always was
    assert "suspicion" in (await _modvar_specs(services))
    # The fixture declares `suspicion` and nothing in the pack ever mentions it.
    check = await dev_room.lint_summary(services, CHAT, "en")
    assert "[var-unused]" in check and "variables[suspicion]" in check

    (src / "skills/dev-omen/SKILL.md").write_text(
        SKILL_MD + "Raise `suspicion` by one whenever the tenant lies.\n", encoding="utf-8"
    )
    await dev_room.reload(services, None, CHAT, "en")
    assert await dev_room.lint_summary(services, CHAT, "en") == ""

    card = dict(WORLD_CARD)
    card["variables"] = [
        {"id": f"orphan_{index}", "kind": "number", "default": 0, "minimum": 0, "maximum": 10}
        for index in range(dev_room.MAX_LINT_LINES + 3)
    ]
    (src / "cards/corridor.lorecard.json").write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
    await dev_room.reload(services, None, CHAT, "en")
    check = await dev_room.lint_summary(services, CHAT, "en")
    assert check.count("[var-unused]") == dev_room.MAX_LINT_LINES
    assert services.i18n.with_locale("en").t("dev.commands.lint_more", count=3) in check


async def test_pack_check_reaches_the_mounting_admin_and_no_one_else(tmp_path):
    """Iron rule #3. A finding names what it is about — here a SECRET entry's title and a
    keeper-visibility variable — so it may only ever reach the admin who mounted the
    source: not the room, on either the command path or the file watcher's."""
    from gateway.commands import CommandRouter
    from gateway.hub import RoomHub

    src = _write_source(tmp_path)
    card = dict(WORLD_CARD)
    card["variables"] = [
        {"id": "mastermind_is_wen", "kind": "bool", "default": False, "visibility": "keeper"}
    ]
    card["worldbook"] = [
        {"title": "SECRET: Wen poisoned the well", "secret": True, "keys": [], "content": "He did."}
    ]
    (src / "cards/corridor.lorecard.json").write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")

    services = _services(tmp_path)
    hub = RoomHub()
    admin, player = _Recorder("admin-1"), _Recorder("player-1")
    await hub.subscribe(CHAT, admin)
    await hub.subscribe(CHAT, player)
    router = CommandRouter(services, hub=hub)
    keeper = AgentCtx(
        chat_key=CHAT, user_id="admin-1", platform="tui", locale="en",
        extra={"role": "keeper", "member_user_key": "admin-1"},
    )

    def leaked(member: _Recorder) -> bool:
        blob = "\n".join(member.texts)
        return "Wen poisoned" in blob or "mastermind_is_wen" in blob

    # Command path: the reply is an ordinary (broadcastable) command reply and carries
    # nothing; the check arrives as a separate event addressed to the issuer alone.
    reply = await router.dispatch(keeper, ".dev mount " + str(src))
    assert "Wen poisoned" not in reply and "mastermind_is_wen" not in reply
    assert leaked(admin) and not leaked(player)
    assert dev_room._MOUNTS[CHAT].owner == "admin-1"

    # Watcher path: one cycle after a save, driven by hand.
    admin.texts.clear()
    reply = await router.dispatch(keeper, ".dev reload")
    assert "Wen poisoned" not in reply
    assert leaked(admin) and not leaked(player)

    admin.texts.clear()
    await dev_room.send_lint(services, hub, CHAT, dev_room._MOUNTS[CHAT].owner)
    assert leaked(admin) and not leaked(player)

    # No recipient is never widened to "everyone": a mount record from before the owner
    # field existed simply gets no check until an admin asks again.
    admin.texts.clear()
    await dev_room.send_lint(services, hub, CHAT, "")
    await dev_room.send_lint(services, None, CHAT, "admin-1")
    assert admin.texts == [] and not leaked(player)

    # ...and the owner survives a restart with the rest of the record.
    dev_room._MOUNTS.clear()
    assert (await dev_room.rearm(services, hub, CHAT)).owner == "admin-1"


async def _modvar_specs(services):
    from core.modvars import load_modvars

    return (await load_modvars(services.documents, CHAT))["specs"]


async def test_dev_command_surface_and_watcher_lifecycle(tmp_path):
    from gateway.commands import CommandRouter

    src = _write_source(tmp_path)
    services = _services(tmp_path)
    router = CommandRouter(services)
    en = services.i18n.with_locale("en")

    player = AgentCtx(chat_key=CHAT, user_id="p1", platform="tui", locale="en", extra={"role": "player"})
    assert await router.dispatch(player, ".dev mount " + str(src)) == en.t("dev.commands.denied")

    keeper = AgentCtx(chat_key=CHAT, user_id="k1", platform="cli", locale="en")
    assert await router.dispatch(keeper, ".dev") == en.t("dev.commands.not_mounted")

    mounted = await router.dispatch(keeper, ".dev mount " + str(src))
    assert mounted is not None and "devpack" in mounted
    task = dev_room._WATCHERS.get(CHAT)
    assert task is not None and not task.done()

    status = await router.dispatch(keeper, ".dev status")
    assert status is not None and "devpack" in status

    assert await router.dispatch(keeper, ".dev unmount") == en.t("dev.commands.unmounted")
    assert CHAT not in dev_room._WATCHERS
    assert await services.store.state_get(CHAT, dev_room.DEV_MOUNT_KEY) == ""
    # Content stays after unmount — only the sync stops.
    assert {entry.title for entry in await services.worldbook.list(CHAT)}


async def test_watcher_stops_itself_when_the_record_is_cleared(tmp_path, monkeypatch):
    """`.reset all` / room import clear the persisted record; the watcher notices and
    stands down instead of re-seeding a fresh room."""
    src = _write_source(tmp_path)
    services = _services(tmp_path)
    monkeypatch.setattr(dev_room, "POLL_SECONDS", 0.01)

    await dev_room.mount(services, None, CHAT, str(src), "en")
    assert CHAT in dev_room._WATCHERS
    await services.store.state_set(CHAT, dev_room.DEV_MOUNT_KEY, "")

    task = dev_room._WATCHERS[CHAT]
    await asyncio.wait_for(task, timeout=2)
    assert CHAT not in dev_room._MOUNTS


def test_fingerprint_tracks_edits_and_ignores_hidden_files(tmp_path):
    src = _write_source(tmp_path)
    before = dev_room.fingerprint(src)
    (src / ".DS_Store").write_text("junk", encoding="utf-8")
    assert dev_room.fingerprint(src) == before
    (src / "lorebooks/manor.json").write_text(json.dumps({"entries": []}), encoding="utf-8")
    assert dev_room.fingerprint(src) != before
