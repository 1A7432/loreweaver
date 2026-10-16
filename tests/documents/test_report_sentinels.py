"""Secrecy sentinels for the HTML session report (`gateway.report_export`).

One keeper sentinel is seeded in EACH reveal category — (a) a hidden `.rh` roll, (b) a
chronicle keeper margin, (c) module truths/threats/unfound clues/NPC secrets, (d) a
keeper-only module variable and an unexposed MVU leaf. The player edition must carry
none of them; the reveal edition must carry all of them. A world-card room (no module
pool) must still produce a reveal edition.
"""

from __future__ import annotations

import pytest

from agent.context import AgentCtx
from agent.services import build_services
from gateway.report_export import build_report_html
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from tests.documents.report_fixtures import POOL_SENTINELS, SENTINELS, seed_report_room

CHAT_KEY = "tui:group:lamp-room"


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(16))


def _ctx(locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=CHAT_KEY, user_id="u-nora", platform="tui", locale=locale)


@pytest.mark.parametrize("locale", ["en", "zh"])
async def test_player_edition_holds_no_keeper_sentinel_and_reveal_holds_all(locale):
    services = _services()
    await seed_report_room(services, CHAT_KEY)
    i18n = services.i18n.with_locale(locale)

    player = await build_report_html(services, _ctx(locale), i18n, reveal=False)
    reveal = await build_report_html(services, _ctx(locale), i18n, reveal=True)
    assert player is not None and reveal is not None
    assert player.variant == "player" and reveal.variant == "reveal"

    leaked = [name for name, value in SENTINELS.items() if value in player.html]
    assert leaked == [], f"player edition leaked keeper material: {leaked}"
    missing = [name for name, value in SENTINELS.items() if value not in reveal.html]
    assert missing == [], f"reveal edition is missing keeper material: {missing}"

    # The table content both editions share is really there.
    for html in (player.html, reveal.html):
        assert "Nora Vale" in html and "Ash Morrow" in html
        assert "<strong>wet</strong>" in html
        assert "The Lamplighter&#x27;s Debt" in html


async def test_player_visible_documents_do_not_leak_into_the_reveal_as_secrets():
    services = _services()
    await seed_report_room(services, CHAT_KEY)
    reveal = await build_report_html(services, _ctx(), services.i18n.with_locale("en"), reveal=True)
    assert reveal is not None
    # The unlocked clue, the exposed MVU leaf and the player-visible variable are not
    # keeper-only, so the behind-the-screen part does not list them.
    assert "A list of names." not in reveal.html
    assert "world.weather" not in reveal.html
    assert "Lamps lit" not in reveal.html


async def test_world_card_room_without_a_pool_still_reveals():
    services = _services()
    await seed_report_room(services, CHAT_KEY, with_pool=False)
    reveal = await build_report_html(services, _ctx(), services.i18n.with_locale("en"), reveal=True)
    assert reveal is not None
    for name, value in SENTINELS.items():
        if name in POOL_SENTINELS:
            assert value not in reveal.html
        else:
            assert value in reveal.html, name
    assert services.i18n.with_locale("en").t("battle.report.html.reveal.truths") not in reveal.html


async def test_a_room_with_no_session_has_nothing_to_report():
    services = _services()
    assert await build_report_html(services, _ctx(), services.i18n.with_locale("en"), reveal=False) is None
