"""M18 oracle: the `.recap` / `.chronicle` command family (`gateway.commands`).

Written FIRST (red). The DoD surfaces: a player-facing spoiler-free `.recap`
("previously on…") rendered purely from document projections, and the keeper's
`.chronicle` family — list/summary/threads/fold/edit/note — with the keeper
edit round-trip: what the keeper edits is what the player's `.recap` renders,
minus the keeper margin, structurally.
"""

from __future__ import annotations

from agent.chronicle import CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, CHRONICLE_DOC_TYPE, THREAD_DOC_TYPE
from agent.context import AgentCtx
from agent.services import build_services
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

ROOM = "tui:group:room1"
SENTINEL = "THE SUNKEN BELL MUST NEVER RING"


def _services(*, enabled: bool = True, llm: FakeLLM | None = None):
    services = build_services(Settings(), llm=llm or FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    services.settings.chronicle.enabled = enabled
    return services


def _keeper_ctx() -> AgentCtx:
    return AgentCtx(chat_key=ROOM, user_id="kp", platform="cli", locale="en")


def _player_ctx() -> AgentCtx:
    return AgentCtx(chat_key=ROOM, user_id="p1", platform="tui", locale="en", extra={"role": "player"})


async def _seed_summary_and_tail(services) -> None:
    await services.documents.put(
        ROOM,
        CAMPAIGN_SUMMARY_DOC_TYPE,
        CAMPAIGN_SUMMARY_ID,
        {
            "text": "Previously: the party freed the bell ringer.",
            "keeper": SENTINEL,
            "through_turn": 40,
            "fold_count": 2,
        },
    )
    await services.documents.put(
        ROOM,
        CHRONICLE_DOC_TYPE,
        "c00041",
        {
            "text": "They camped by the pier.",
            "keeper": SENTINEL,
            "turn": 41,
            "pcs": [],
            "scene": "",
            "folded": False,
            "tokens": 30,
        },
    )


# ---------------------------------------------------------------------------
# .recap (any member; spoiler-free by construction)
# ---------------------------------------------------------------------------


async def test_recap_empty_room_gives_a_localized_notice():
    services = _services()
    router = CommandRouter(services)
    i18n = services.i18n.with_locale("en")

    reply = await router.dispatch(_player_ctx(), ".recap")
    assert reply == i18n.t("commands.recap.empty")


async def test_recap_renders_the_player_projection_without_keeper_annotations():
    services = _services()
    router = CommandRouter(services)
    await _seed_summary_and_tail(services)

    reply = await router.dispatch(_player_ctx(), ".recap")

    assert "freed the bell ringer" in reply, "the rolling summary is the 'previously on…'"
    assert "camped by the pier" in reply, "the raw recent tail rides along"
    assert SENTINEL not in reply and "keeper" not in reply, "structurally spoiler-free"

    keeper_reply = await router.dispatch(_keeper_ctx(), ".recap")
    assert SENTINEL not in keeper_reply, ".recap is the player surface even for the keeper"


# ---------------------------------------------------------------------------
# .chronicle keeper family
# ---------------------------------------------------------------------------


async def test_chronicle_subcommands_are_keeper_gated():
    services = _services()
    router = CommandRouter(services)
    i18n = services.i18n.with_locale("en")

    for text in (".chronicle", ".chronicle list", ".chronicle summary", ".chronicle fold", ".chronicle edit x"):
        reply = await router.dispatch(_player_ctx(), text)
        assert reply == i18n.t("commands.chronicle.denied"), text


async def test_chronicle_list_and_summary_show_the_keeper_the_full_truth():
    services = _services()
    router = CommandRouter(services)
    await _seed_summary_and_tail(services)
    await services.documents.put(ROOM, THREAD_DOC_TYPE, "t-1", {"label": "The armed bell", "status": "open", "notes": ""})

    listing = await router.dispatch(_keeper_ctx(), ".chronicle list")
    assert "c00041" in listing and "camped by the pier" in listing
    assert SENTINEL in listing, "the keeper view carries the annotations"

    summary = await router.dispatch(_keeper_ctx(), ".chronicle summary")
    assert "freed the bell ringer" in summary and SENTINEL in summary

    threads = await router.dispatch(_keeper_ctx(), ".chronicle threads")
    assert "The armed bell" in threads


async def test_chronicle_edit_round_trips_into_the_player_recap():
    services = _services()
    router = CommandRouter(services)
    await _seed_summary_and_tail(services)

    edited = await router.dispatch(_keeper_ctx(), ".chronicle edit The party freed the bell ringer, at a price.")
    assert edited == services.i18n.with_locale("en").t("commands.chronicle.edit_done")

    player_view = await router.dispatch(_player_ctx(), ".recap")
    assert "at a price" in player_view, "the keeper's edit is what the player's recap renders"
    assert SENTINEL not in player_view, "...while the keeper margin still never crosses"

    noted = await router.dispatch(_keeper_ctx(), ".chronicle note The price comes due at the eclipse.")
    assert noted == services.i18n.with_locale("en").t("commands.chronicle.note_done")
    assert "eclipse" not in (await router.dispatch(_player_ctx(), ".recap"))
    keeper_summary = await router.dispatch(_keeper_ctx(), ".chronicle summary")
    assert "eclipse" in keeper_summary and "at a price" in keeper_summary, "edit + note both persist keeper-side"


async def test_chronicle_edit_without_a_summary_gives_a_notice():
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_keeper_ctx(), ".chronicle edit anything")
    assert reply == services.i18n.with_locale("en").t("commands.chronicle.no_summary")


async def test_chronicle_fold_runs_the_manual_fold():
    def responder(messages, tools):
        return assistant_text("condensed campaign history")

    services = _services(llm=FakeLLM(responder=responder))
    router = CommandRouter(services)
    await services.store.state_set(ROOM, "chronicle_turn", "20")
    for turn in range(1, 7):
        await services.documents.put(
            ROOM,
            CHRONICLE_DOC_TYPE,
            f"c{turn:05d}",
            {"text": f"turn{turn} things happened", "keeper": "", "turn": turn, "pcs": [], "scene": "", "folded": False, "tokens": 80},
        )

    reply = await router.dispatch(_keeper_ctx(), ".chronicle fold")

    i18n = services.i18n.with_locale("en")
    assert reply and reply.startswith(i18n.t("commands.chronicle.fold_done", count=6, turn=6).split("{")[0]), reply
    entries = await services.documents.list(ROOM, CHRONICLE_DOC_TYPE)
    assert all(entry.data["folded"] for entry in entries), "the manual fold folds every record past the lag window"
    summary = await services.documents.get(ROOM, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None and summary.data["text"] == "condensed campaign history"


async def test_chronicle_fold_with_nothing_foldable_says_so():
    services = _services()
    router = CommandRouter(services)
    await services.store.state_set(ROOM, "chronicle_turn", "3")

    reply = await router.dispatch(_keeper_ctx(), ".chronicle fold")
    assert reply == services.i18n.with_locale("en").t("commands.chronicle.fold_none")


async def test_chronicle_family_reports_when_the_feature_is_disabled():
    services = _services(enabled=False)
    router = CommandRouter(services)
    reply = await router.dispatch(_keeper_ctx(), ".chronicle fold")
    assert reply == services.i18n.with_locale("en").t("commands.chronicle.disabled")


async def test_chronicle_zh_dialect_aliases_and_localized_replies():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=ROOM, user_id="kp", platform="cli", locale="zh")

    reply = await router.dispatch(ctx, "。前情提要")
    assert reply == services.i18n.with_locale("zh").t("commands.recap.empty")

    denied = await router.dispatch(
        AgentCtx(chat_key=ROOM, user_id="p1", platform="tui", locale="zh", extra={"role": "player"}),
        "。编年史 折页",
    )
    assert denied == services.i18n.with_locale("zh").t("commands.chronicle.denied")
