"""Iron rule #3 sentinel for the MVU lane of the actor-side card-text renderer.

A card-derived NPC/companion actor speaks TO PLAYERS, so the variable space its persona
templates resolve against must be the PLAYER projection of BOTH variable documents. The
`modvars` half is covered by `test_card_text_render.py`; this module pins the `mvu_tree`
half: leaves the keeper has never exposed (`core.mvu_compat.mvu_expose`, the `.var expose`
command) must not reach an actor prompt through `{{getvar::...}}`, through the `core.ejs_lite`
subset, or through the full QuickJS engine's raw `stat_data`/`variables` scope.

Every sentinel assertion ships with a POSITIVE CONTROL (an EXPOSED leaf that must still
render), so a renderer that emitted nothing at all could not make these tests pass.
"""

from __future__ import annotations

import json

import pytest

from agent.npc import NpcRecord
from agent.npc_actor import voice_npc
from agent.services import build_services
from core.mvu_compat import mvu_expose, mvu_init_from_initvar
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

CHAT_KEY = "card-text-mvu-projection-room"
# The un-exposed keeper leaf. If this string appears anywhere in what the actor was handed,
# the projection was bypassed.
MVU_SENTINEL = "THE HARBORMASTER DID IT"

_NPC_REPLY = {"dialogue": "Aye.", "action_intent": "", "mood": "calm"}


def _recording_services(recorded: list[list[dict]], **settings_overrides):
    """FakeLLM services whose every `chat()` call lands in `recorded` (messages only)."""

    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps(_NPC_REPLY))

    return build_services(
        Settings(**settings_overrides), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8)
    )


def _prompt_text(recorded: list[list[dict]]) -> str:
    """All message content of the LAST recorded LLM call, joined (system + user)."""
    return "\n".join(str(message.get("content") or "") for message in recorded[-1])


async def _seed_mvu(services) -> None:
    """One imported-card tree with an EXPOSED branch and an un-exposed keeper branch."""
    await mvu_init_from_initvar(
        services.documents,
        CHAT_KEY,
        {
            "public": {"morale": [3, "party morale"]},
            "keeper": {"true_culprit": [MVU_SENTINEL, "who actually did it"]},
        },
    )
    assert await mvu_expose(services.documents, CHAT_KEY, "public") is True


async def test_unexposed_mvu_leaf_never_reaches_an_actor_prompt_subset_path():
    """`core.ejs_lite` lane (quickjs-independent): un-exposed leaves read as UNSET."""
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, enable_full_ejs=False)
    await _seed_mvu(services)

    npc = NpcRecord(
        id="martha",
        name="Martha",
        persona=(
            "Morale <%= getvar('public.morale') %>."
            " Culprit: <% if (getvar('keeper.true_culprit')) { %><%= getvar('keeper.true_culprit') %>"
            "<% } else { %>unknown<% } %>."
            " Raw: {{getvar::keeper.true_culprit}}(end)."
        ),
    )
    await voice_npc(services, npc, "A stranger asks who did it.", chat_key=CHAT_KEY)

    everything = _prompt_text(recorded)
    # SENTINEL: the un-exposed keeper leaf's value crossed no boundary.
    assert MVU_SENTINEL not in everything
    # POSITIVE CONTROL: the keeper-EXPOSED leaf rendered normally, so this is not a vacuous pass.
    assert "Morale 3." in everything
    # The branch reading the hidden leaf behaves exactly as if it were unset (fail-closed).
    assert "Culprit: unknown." in everything
    assert "Raw: (end)." in everything
    assert "<%" not in everything and "%>" not in everything


async def test_unexposed_mvu_leaf_never_reaches_an_actor_prompt_full_ejs_path():
    """Full QuickJS engine lane: `getvar` AND the raw `stat_data`/`variables` scope."""
    pytest.importorskip("quickjs")

    recorded: list[list[dict]] = []
    services = _recording_services(recorded)  # DEFAULT settings: enable_full_ejs=True
    await _seed_mvu(services)

    npc = NpcRecord(
        id="martha",
        name="Martha",
        persona=(
            # `_.range` proves the FULL engine ran (the subset cannot render it), so the
            # sentinel below is not satisfied merely by a silent fallback.
            "Engine:<%= _.range(2).join('-') %>."
            " Morale <%= getvar('public.morale') %>."
            " Culprit=<%= getvar('keeper.true_culprit') || 'unknown' %>."
            # The card-author escape hatch the finding names: the whole tree, dumped raw.
            " Dump:<%- JSON.stringify(stat_data) %>|<%- JSON.stringify(variables) %>."
        ),
    )
    await voice_npc(services, npc, "A stranger asks who did it.", chat_key=CHAT_KEY)

    everything = _prompt_text(recorded)
    # SENTINEL: not via getvar, and not via a raw dump of the engine's tree scope.
    assert MVU_SENTINEL not in everything
    assert "true_culprit" not in everything  # not even the keeper path's NAME is shipped
    # POSITIVE CONTROLS: the full engine really ran, and the exposed leaf survived it.
    assert "Engine:0-1." in everything
    assert "Morale 3." in everything
    # …and it survived with its SHAPE intact: the projection prunes un-exposed branches
    # out of the tree rather than flattening it, so a real card's ValueWithDescription
    # pair still reads as `[value, description]` through `stat_data`.
    assert '"morale":[3,"party morale"]' in everything.replace(", ", ",").replace('" :', '":')
    assert "Culprit=unknown." in everything
    assert "<%" not in everything and "%>" not in everything
