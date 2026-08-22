"""The per-turn model-call budget (audit batch F09 / F13 / item 11).

Three related regressions, all about how many `llm.chat` calls ONE player turn is
allowed to spend:

- **F09** — the post-turn Scribe fired on every companion sub-turn: a companion's
  own turn re-enters `gateway.turn.run_turn` (`gateway.director.run_companion_turn`),
  and the Scribe block carried no `ctx.platform != "companion"` guard, unlike the
  companion-director call ten lines above it. One player turn with N companions
  spent 1+N Scribe calls and reconciled the same trackers 1+N times.
- **F13** — the chronicle fold's accounting compared the WHOLE assembled prompt's
  meter against the token size of the RECORDS it folded, two different things. What
  a fold actually frees is the replayed HISTORY its new watermark lets
  `agent.history.trim_folded` drop, so a room with nothing left to trim can not
  measurably shrink its prompt by folding — yet the meter stayed over the trigger and
  re-armed the fold on the very next turn, forever, for any room whose pressure comes
  from somewhere else (a big module).
- **item 11** — the resulting bound was written down nowhere. One turn is driven
  through a counting fake client and pinned against the ceiling AGENTS.md documents.

Everything here is offline: `FakeLLM` + `FakeEmbeddings`, no network, no keys.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.chronicle import maybe_fold_chronicle
from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, append_turn
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_companion import CompanionTools
from agent.services import build_services
from core.chronicle import CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, CHRONICLE_DOC_TYPE
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from infra.store import Store

# The Scribe prompt's opening line and the fold instruction's stable phrase: the two
# markers that tell the lanes apart when every call arrives on the same fake client.
SCRIBE_MARK = "You are the table Scribe"
FOLD_MARK = "campaign summary"

FILLER = "the party searched the drowned stacks of the archive district and mapped another gallery "


class FakeMember:
    """A recording hub member (mirrors `tests/gateway/test_director.py`'s)."""

    def __init__(self, id: str) -> None:
        self.id = id
        self.user_key = f"user:{id}"
        self.transport = "tui"
        self.name = id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _ctx(chat_key: str, user_id: str = "nora", *, platform: str = "tui") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform=platform, locale="en")


def _counting_responder(counts: dict[str, int]):
    """One responder for every lane, tallying which actor made each call.

    The Scribe and the companion actor both call with `tools=None`; they are told
    apart by the prompt itself, which is what a real deployment sees too.
    """

    def responder(messages, tools):
        counts["total"] += 1
        head = str(messages[0].get("content", ""))
        if tools is None and SCRIBE_MARK in head:
            counts["scribe"] += 1
            return assistant_text('{"ops": [], "whispers": [], "beat": "none"}')
        if tools is None:
            counts["companion"] += 1
            return assistant_text(json.dumps({"action": "I ready my blade.", "dialogue": ""}))
        counts["kp"] += 1
        return assistant_text("The hallway stays quiet.")

    return responder


def _services(responder, *, scribe: bool = True):
    store = Store(":memory:")
    services = build_services(Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8), store=store)
    # The suite-wide conftest turns the Scribe off for every other test; these tests
    # are ABOUT what it costs (the `tests/agent/test_scribe.py` posture).
    services.settings.scribe.enabled = scribe
    return services


async def _room(services, hub: RoomHub, chat_key: str, *, companions: int):
    router = CommandRouter(services, hub=hub)
    toolset = build_kp_toolset(services, hub=hub, command_router=router)
    names = [f"Ada{index}" for index in range(companions)]
    for name in names:
        await CompanionTools(services).add_companion(_ctx(chat_key, user_id="kp"), name=name)
    if names:
        await services.store.state_set(chat_key, "party_auto", "1")
        await services.store.state_set(
            chat_key,
            "initiative",
            json.dumps([{"name": name, "init": 20 - index} for index, name in enumerate(names)]),
        )
    watcher = FakeMember("watcher")
    await hub.subscribe(chat_key, watcher)
    watcher.events.clear()
    return router, toolset, watcher


async def _drain_scribe_tasks() -> None:
    """Await the fire-and-forget Scribe chain `run_turn` scheduled."""
    from agent.scribe_coord import scribe_runtime

    await scribe_runtime.await_all()


# ---------------------------------------------------------------------------
# F09 — the Scribe is a PLAYER-turn pass, not a per-sub-turn pass
# ---------------------------------------------------------------------------


async def test_one_player_turn_fires_exactly_one_scribe_pass_with_companions_acting():
    chat_key = "scribe-budget-room"
    counts = {"total": 0, "scribe": 0, "companion": 0, "kp": 0}
    services = _services(_counting_responder(counts))
    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key, companions=3)

    await run_turn(hub, services, _ctx(chat_key), "I creep down the hallway", command_router=router, toolset=toolset)
    await _drain_scribe_tasks()

    # POSITIVE CONTROL: the companions really did act (otherwise "one scribe pass"
    # would be trivially true because nothing re-entered run_turn at all).
    companion_actions = [event for event in watcher.events if event.kind == "player_action" and event.name.startswith("Ada")]
    assert len(companion_actions) == 3, "the three companions must have auto-acted on the player's turn"
    assert counts["companion"] == 3
    assert counts["scribe"] > 0, "the scribe must run at all (control against a vacuous pass)"

    # The regression: one PLAYER turn = one Scribe pass, whatever the party size.
    assert counts["scribe"] == 1


async def test_a_companion_sub_turn_alone_never_runs_the_scribe():
    # Directly: a companion-platform turn is a SUB-turn of the player's; its parent
    # already reconciles the whole exchange.
    from gateway.director import request_companion

    chat_key = "companion-only-room"
    counts = {"total": 0, "scribe": 0, "companion": 0, "kp": 0}
    services = _services(_counting_responder(counts))
    hub = RoomHub()
    router, toolset, _watcher = await _room(services, hub, chat_key, companions=1)

    result = await request_companion(hub, services, "Ada0", chat_key=chat_key, command_router=router, toolset=toolset)
    await _drain_scribe_tasks()

    assert result is not None, "positive control: the companion turn really ran"
    assert counts["companion"] == 1 and counts["kp"] == 1
    assert counts["scribe"] == 0


# ---------------------------------------------------------------------------
# item 11 — the documented per-turn ceiling
# ---------------------------------------------------------------------------

# AGENTS.md ("Per-turn model-call budget") states the worst case for ONE player
# turn: 3 fold + 12 rounds + 5 end-of-turn check rounds + 1 context-overflow retry
# = 21 per KP turn, plus 1 Scribe + 1 Director beat, plus 6 companion sub-turns of
# (1 actor + 21). This pins the SHAPE of that bound as well as the ceiling itself: a
# turn costs a fixed keeper cost plus a per-companion cost, and never more than the
# ceiling.
#
# M23 WS2 moved it from 148 to 155. The added term is the RETRY, once per KP turn, on
# the disaster path where the provider refuses the prompt as too long: 7 KP-turn
# instances (1 main + 6 companion-nested) × 1. The recovery FOLD is not a new term —
# it shares the same ≤3 batches the routine fold has (`fold_for_overflow`'s
# `batches_spent`), which is why the fold half of the sum is unchanged.
# The arithmetic, executable rather than asserted, so a future change has to edit the
# terms and not just the total.
KP_TURN_WORST_CASE = 3 + 12 + 5 + 1  # fold batches + tool rounds + check rounds + overflow retry
COMPANION_SUB_TURNS = 6  # gateway.director.MAX_COMPANION_TURNS
DOCUMENTED_CEILING = (
    1  # the Scribe pass
    + 1  # the Director call, on a beat
    + KP_TURN_WORST_CASE  # the main KP turn
    + COMPANION_SUB_TURNS * (1 + KP_TURN_WORST_CASE)  # each companion: 1 actor call + a nested KP turn
)


async def test_per_turn_call_count_tracks_the_companion_count_and_stays_under_the_ceiling():
    baseline = {"total": 0, "scribe": 0, "companion": 0, "kp": 0}
    services = _services(_counting_responder(baseline))
    hub = RoomHub()
    router, toolset, _watcher = await _room(services, hub, "budget-solo", companions=0)
    await run_turn(hub, services, _ctx("budget-solo"), "I wait for a moment.", command_router=router, toolset=toolset)
    await _drain_scribe_tasks()

    party = {"total": 0, "scribe": 0, "companion": 0, "kp": 0}
    services = _services(_counting_responder(party))
    hub = RoomHub()
    router, toolset, _watcher = await _room(services, hub, "budget-party", companions=3)
    await run_turn(hub, services, _ctx("budget-party"), "I wait for a moment.", command_router=router, toolset=toolset)
    await _drain_scribe_tasks()

    # POSITIVE CONTROL: the counter counts something, and it tracks the party size.
    assert baseline["total"] > 0
    assert party["total"] > baseline["total"]
    # A settled turn: one keeper round + one scribe pass; each companion adds its
    # own actor call plus the keeper resolving its action, and nothing else.
    assert baseline["total"] == 2
    assert party["total"] == baseline["total"] + 3 * 2

    assert baseline["total"] <= DOCUMENTED_CEILING
    assert party["total"] <= DOCUMENTED_CEILING


# ---------------------------------------------------------------------------
# F13 — the fold must not re-arm on savings it never made
# ---------------------------------------------------------------------------

WINDOW = 2000


async def _set_meter(services, chat_key: str, prompt_tokens: int, window: int = WINDOW) -> None:
    payload = {
        "last": {"prompt": prompt_tokens, "completion": 0, "cache_hit": 0, "cache_miss": 0, "context_window": window},
        "session": {"prompt": prompt_tokens, "completion": 0, "cache_hit": 0, "cache_miss": 0, "turns": 1},
    }
    await services.store.state_set(chat_key, "usage_stats", json.dumps(payload))


async def _seed_entries(services, chat_key: str, turns: list[int], *, tokens: int = 100) -> None:
    for turn in turns:
        await services.documents.put(
            chat_key,
            CHRONICLE_DOC_TYPE,
            f"c{turn:05d}",
            {
                "text": f"turn{turn} " + FILLER * 3,
                "keeper": "",
                "turn": turn,
                "pcs": [],
                "scene": "",
                "folded": False,
                "tokens": tokens,
            },
        )


async def _seed_history(services, chat_key: str, turns: list[int], *, tokens_per_message: int = 20) -> None:
    """The replayed transcript a fold would trim — what its saving is measured in.

    `estimate_tokens` is `(chars + 3) // 4` for pure ASCII, so a 4N-char message is
    exactly N tokens and one turn (two messages) costs `2 * tokens_per_message`.
    """
    text = "x" * (4 * tokens_per_message)
    for turn in turns:
        await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message=text, reply=text, turn=turn)


def _fold_counter():
    counts = {"folds": 0}

    def responder(messages, tools):
        assert tools is None and FOLD_MARK in str(messages[0].get("content", "")), "only the fold may call here"
        counts["folds"] += 1
        return assistant_text(f"Previously, in batch {counts['folds']}: the party pressed on.")

    return responder, counts


def _chronicle_services(responder):
    services = build_services(Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8), store=Store(":memory:"))
    # conftest disables the chronicle for the rest of the suite; these tests are ABOUT it.
    services.settings.chronicle.enabled = True
    return services


async def test_a_fold_that_did_not_move_the_meter_does_not_re_arm_next_turn():
    """The F13 churn: the meter measures the WHOLE prompt, the fold frees only
    chronicle records. A room over the trigger for any other reason (a big module)
    used to buy one fold generation call EVERY turn, forever, freeing nothing."""
    responder, counts = _fold_counter()
    services = _chronicle_services(responder)
    chat_key = "fold-churn-room"
    await services.store.state_set(chat_key, "chronicle_turn", "40")
    await _seed_entries(services, chat_key, list(range(1, 31)), tokens=50)
    await _seed_history(services, chat_key, list(range(1, 31)))
    await _set_meter(services, chat_key, WINDOW)  # pinned full by the module, not the chronicle

    first = await maybe_fold_chronicle(_ctx(chat_key), services)
    # POSITIVE CONTROL: the first fold really ran and really folded records.
    assert first.ran and first.entries_folded > 0 and counts["folds"] > 0
    after_first = counts["folds"]

    # Next turn: the assembled prompt did NOT shrink (the meter is unchanged), which
    # is the observed proof that the previous fold freed nothing.
    second = await maybe_fold_chronicle(_ctx(chat_key), services)

    assert counts["folds"] == after_first, "a fold that demonstrably freed nothing must not re-arm"
    assert second.entries_folded == 0


async def test_a_meter_that_really_grows_re_arms_the_fold():
    """The control for the hysteresis above: real growth is still folded."""
    responder, counts = _fold_counter()
    services = _chronicle_services(responder)
    chat_key = "fold-rearm-room"
    await services.store.state_set(chat_key, "chronicle_turn", "40")
    await _seed_entries(services, chat_key, list(range(1, 31)), tokens=50)
    await _seed_history(services, chat_key, list(range(1, 31)))
    await _set_meter(services, chat_key, int(0.62 * WINDOW))

    await maybe_fold_chronicle(_ctx(chat_key), services)
    after_first = counts["folds"]
    assert after_first > 0

    # The room genuinely grew past the re-arm margin: fold again.
    await _set_meter(services, chat_key, int(0.95 * WINDOW))
    again = await maybe_fold_chronicle(_ctx(chat_key), services)

    assert counts["folds"] > after_first, "real growth must still re-arm the fold"
    assert again.entries_folded > 0


async def test_a_fold_that_would_free_no_replayed_history_makes_no_call():
    """"Nothing left to trim" resolves to "no fold", not "fold again": the records are
    foldable, the meter is pinned full, and folding them would still take nothing out
    of the assembled prompt — so no generation call is spent."""

    def _explode(messages, tools):
        raise AssertionError("a fold that can free no replayed history must spend no call")

    services = _chronicle_services(_explode)
    chat_key = "fold-floor-room"
    await services.store.state_set(chat_key, "chronicle_turn", "40")
    # Records the watermark would happily fold — but this room replays no transcript
    # for their turns (an imported campaign log, a rewound room), so folding them frees
    # nothing and the pressure is demonstrably somewhere else.
    await _seed_entries(services, chat_key, list(range(1, 11)))
    await _set_meter(services, chat_key, WINDOW)

    outcome = await maybe_fold_chronicle(_ctx(chat_key), services)

    assert outcome.entries_folded == 0 and outcome.batches == 0
    assert await services.documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID) is None

    # POSITIVE CONTROL: the same room, once those turns are actually being replayed,
    # folds — so the assertion above is about the measurement, not about a room that
    # could never fold for some other reason.
    folds = {"n": 0}

    def _fold(messages, tools):
        folds["n"] += 1
        return assistant_text("Previously: the party pressed on.")

    services.llm = FakeLLM(responder=_fold)
    await _seed_history(services, chat_key, list(range(1, 11)))

    assert (await maybe_fold_chronicle(_ctx(chat_key), services)).entries_folded > 0
    assert folds["n"] > 0


async def test_one_turn_never_spends_more_than_the_per_turn_fold_batch_budget():
    """A huge backlog is drained in bounded batches, not in one unbounded burst —
    the per-turn fold budget AGENTS.md documents."""
    responder, counts = _fold_counter()
    services = _chronicle_services(responder)
    chat_key = "fold-backlog-room"
    await services.store.state_set(chat_key, "chronicle_turn", "400")
    # Terse turns: the floor stays out of reach even after folding every last record,
    # which is exactly the case that used to drain all 300 in one turn (25 sequential
    # calls). 300 turns at 2 replayed tokens each is 600 against a 1200 deficit.
    await _seed_entries(services, chat_key, list(range(1, 301)), tokens=1)
    await _seed_history(services, chat_key, list(range(1, 301)), tokens_per_message=1)
    await _set_meter(services, chat_key, WINDOW)

    outcome = await maybe_fold_chronicle(_ctx(chat_key), services)

    assert counts["folds"] > 0, "positive control: a real backlog does fold"
    assert counts["folds"] <= 3, "a single turn's fold budget is bounded"
    assert outcome.batches == counts["folds"]


def test_the_documented_ceiling_matches_the_number_AGENTS_md_publishes():
    """The budget paragraph and this file are one number, or the budget means nothing.

    AGENTS.md is where a contributor reads the bound before adding a model-driven lane;
    this constant is what CI enforces. They drift the moment nobody checks.
    """
    assert DOCUMENTED_CEILING == 155
    assert KP_TURN_WORST_CASE == 21
    agents_md = (Path(__file__).resolve().parents[2] / "AGENTS.md").read_text(encoding="utf-8")
    budget_paragraph = agents_md.split("## Per-turn model-call budget", 1)[1].split("\n## ", 1)[0]
    assert "~155 model calls" in budget_paragraph
    assert f"= **{KP_TURN_WORST_CASE}**" in budget_paragraph
