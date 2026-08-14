"""M23 WS2: a provider that refuses the prompt as too long no longer kills the turn.

The usage meter has lied three times, and each time a long campaign hit a wall the
meter could not see: the turn was discarded, usage recorded zero, so the meter did not
move and the next turn hit the same wall. The provider's own refusal is the one reading
that cannot be stale — so it becomes the fold's second trigger.

Everything here is offline. The overflow is injected by a `FakeLLM` responder raising
an error built from the body OpenAI's own documentation prints (see
`tests/infra/test_llm_errors.py` for the per-vendor shapes).
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, append_turn, load_chain
from agent.kp_tools import build_kp_toolset
from agent.loop import run_kp_turn
from agent.services import build_services
from core.chronicle import CHRONICLE_DOC_TYPE
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from infra.store import Store

WINDOW = 2000
FILLER = "the party pressed deeper into the drowned archive and mapped another flooded gallery "
FOLD_MARK = "campaign summary"

# Copied from the OpenAI Cookbook's printed error (read 2026-08-14) — the same body
# `tests/infra/test_llm_errors.py` pins the classifier against.
OVERFLOW_BODY = (
    "Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 "
    "tokens, however you requested 10001 tokens (10001 in your prompt; 0 for the completion). "
    "Please reduce your prompt; or completion length.\", 'type': 'invalid_request_error', "
    "'param': None, 'code': None}}"
)


class _Overflow(Exception):
    def __init__(self) -> None:
        super().__init__(OVERFLOW_BODY)
        self.status_code = 400


def _ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="nora", platform="tui", locale="en")


def _services(responder):
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(responder=responder),
        embeddings=FakeEmbeddings(8),
        store=Store(":memory:"),
    )
    # conftest disables the chronicle for the rest of the suite; these tests are ABOUT it.
    services.settings.chronicle.enabled = True
    return services


def _is_fold(messages) -> bool:
    return FOLD_MARK in str(messages[0].get("content", ""))


def _overflow_once_responder(log: list[str]):
    """The keeper's first call overflows; a later one succeeds. Folds always succeed.

    This is the shape of the real failure: the assembled prompt is too big, the fold
    generation itself is small enough to go through, and the retry then fits.
    """
    state = {"keeper_calls": 0}

    def responder(messages, tools):
        if _is_fold(messages):
            log.append("fold")
            return assistant_text("Previously: the party pressed on through the flooded galleries.")
        state["keeper_calls"] += 1
        if state["keeper_calls"] == 1:
            log.append("keeper:overflow")
            raise _Overflow()
        log.append("keeper:ok")
        return assistant_text("The water recedes, and the archive exhales its dust.")

    return responder


def _always_overflow_responder(log: list[str]):
    def responder(messages, tools):
        if _is_fold(messages):
            log.append("fold")
            return assistant_text("Previously: the party pressed on.")
        log.append("keeper:overflow")
        raise _Overflow()

    return responder


async def _set_meter(services, chat_key: str, prompt_tokens: int, window: int = WINDOW) -> None:
    payload = {
        "last": {
            "prompt": prompt_tokens,
            "completion": 0,
            "cache_hit": 0,
            "cache_miss": 0,
            "context_window": window,
        },
        "session": {"prompt": prompt_tokens, "completion": 0, "cache_hit": 0, "cache_miss": 0, "turns": 1},
    }
    await services.store.state_set(chat_key, "usage_stats", json.dumps(payload))


async def _seed_backlog(services, chat_key: str, turns: list[int]) -> None:
    """A foldable chronicle backlog and the replayed history a fold would trim."""
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
                "tokens": 50,
            },
        )
    text = "x" * 80  # 20 tokens per message under `estimate_tokens`
    for turn in turns:
        await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message=text, reply=text, turn=turn)


async def _room(services, chat_key: str, *, backlog: bool):
    await services.store.state_set(chat_key, "chronicle_turn", "40")
    if backlog:
        await _seed_backlog(services, chat_key, list(range(1, 31)))
    # Under the fold trigger, so the ROUTINE fold at the top of the turn stays out of
    # this: what is being tested is recovery from the provider's error, not the meter.
    await _set_meter(services, chat_key, int(0.10 * WINDOW))
    return build_kp_toolset(services)


async def test_an_overflow_folds_and_retries_and_the_player_gets_a_normal_turn():
    log: list[str] = []
    services = _services(_overflow_once_responder(log))
    chat_key = "overflow-recovers"
    toolset = await _room(services, chat_key, backlog=True)

    result = await run_kp_turn(_ctx(chat_key), services, toolset, "I open the sealed door.")

    assert "archive exhales" in result.reply, "the player must receive a narrated turn, not an error"
    # One fold batch and exactly one retry, in that order, after the refusal.
    assert log[0] == "keeper:overflow"
    assert "fold" in log
    assert log[-1] == "keeper:ok"
    assert log.count("keeper:overflow") == 1, "the retry is once per turn"
    # The turn persisted: a recovered turn is a real turn.
    chain = await load_chain(services, chat_key, DEFAULT_HISTORY_KEY)
    assert chain[-1]["content"].startswith("The water recedes")


async def test_an_overflow_with_nothing_left_to_fold_reports_the_error_and_never_retries():
    """The dsh loop guard: no progress, no retry. A room at the floor gets today's
    behaviour — one call, one localized error — instead of a fold/retry ping-pong."""
    log: list[str] = []
    services = _services(_always_overflow_responder(log))
    chat_key = "overflow-at-the-floor"
    toolset = await _room(services, chat_key, backlog=False)  # no chronicle records at all

    result = await run_kp_turn(_ctx(chat_key), services, toolset, "I open the sealed door.")

    assert log == ["keeper:overflow"], "no fold to make progress with means no retry"
    assert result.reply, "the turn still degrades to a localized message"
    assert "archive" not in result.reply


async def test_a_second_overflow_after_a_successful_fold_is_not_folded_again():
    """The retry is once per KP turn, full stop — a second refusal after a fold that
    DID fold records is not a fold problem."""
    log: list[str] = []
    services = _services(_always_overflow_responder(log))
    chat_key = "overflow-twice"
    toolset = await _room(services, chat_key, backlog=True)

    await run_kp_turn(_ctx(chat_key), services, toolset, "I open the sealed door.")

    assert log.count("keeper:overflow") == 2, "the first call and its one retry, and no more"
    assert log.count("fold") >= 1


async def test_an_overflow_moves_the_meter_even_though_the_call_reported_no_usage():
    """The stuck-room mechanism: a refused call reports nothing, so without this the
    meter keeps showing the last SUCCESSFUL turn and the next turn walks into the same
    wall. The overflow itself is the evidence."""
    log: list[str] = []
    services = _services(_always_overflow_responder(log))
    chat_key = "overflow-meter"
    toolset = await _room(services, chat_key, backlog=False)
    before = json.loads(await services.store.state_get(chat_key, "usage_stats"))
    assert before["last"]["prompt"] == int(0.10 * WINDOW)  # POSITIVE CONTROL

    await run_kp_turn(_ctx(chat_key), services, toolset, "I open the sealed door.")

    after = json.loads(await services.store.state_get(chat_key, "usage_stats"))
    assert after["last"]["overflow"] is True
    assert after["last"]["prompt"] == after["last"]["context_window"] > 0, "a refusal is 100% full"
    assert after["last"]["estimated"] is True, "nothing measured this; it must not read as measured"
    # The cumulative totals stay measured-only — they are what an operator checks
    # against a vendor's bill.
    assert after["session"] == before["session"]


async def test_a_non_overflow_provider_error_never_folds():
    """Strictness at the loop level, not just in the classifier: a content refusal
    must not spend a fold generation."""
    log: list[str] = []

    class _Refusal(Exception):
        def __init__(self) -> None:
            super().__init__(
                "Error code: 400 - {'error': {'message': 'Invalid prompt: flagged by our "
                "usage policy.', 'type': 'invalid_request_error', 'code': 'invalid_prompt'}}"
            )
            self.status_code = 400

    def responder(messages, tools):
        if _is_fold(messages):
            log.append("fold")
            return assistant_text("Previously: nothing.")
        log.append("keeper:refused")
        raise _Refusal()

    services = _services(responder)
    chat_key = "refusal-room"
    toolset = await _room(services, chat_key, backlog=True)

    await run_kp_turn(_ctx(chat_key), services, toolset, "I open the sealed door.")

    assert log == ["keeper:refused"], "a content refusal is not a size problem"


async def test_the_recovery_fold_spends_what_is_left_of_the_turns_fold_budget():
    """One budget, not one each — this is what keeps the per-KP-turn ceiling at 21.

    A room deep enough over the trigger to spend all three of its fold batches on the
    ROUTINE fold has nothing left when the provider then refuses the prompt: the recovery
    fold makes no call, which means no progress, which means no retry.
    """
    log: list[str] = []
    services = _services(_always_overflow_responder(log))
    chat_key = "overflow-budget-spent"
    await services.store.state_set(chat_key, "chronicle_turn", "400")
    # Terse turns and a huge backlog: the floor stays out of reach after folding
    # everything, so the routine fold runs its full budget (same shape as
    # `tests/agent/test_turn_call_budget.py`'s backlog case).
    for turn in range(1, 301):
        await services.documents.put(
            chat_key,
            CHRONICLE_DOC_TYPE,
            f"c{turn:05d}",
            {"text": f"turn{turn}", "keeper": "", "turn": turn, "pcs": [], "scene": "",
             "folded": False, "tokens": 1},
        )
    for turn in range(1, 301):
        await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message="xxxx", reply="xxxx", turn=turn)
    await _set_meter(services, chat_key, WINDOW)
    toolset = build_kp_toolset(services)

    await run_kp_turn(_ctx(chat_key), services, toolset, "I open the sealed door.")

    assert log.count("fold") == 3, "the routine fold spends the budget; the recovery fold finds none left"
    assert log.count("keeper:overflow") == 1, "no fold progress means no retry"


# ---------------------------------------------------------------------------
# The quiet half: a reply truncated at the window, on a call that "succeeded"
# ---------------------------------------------------------------------------


class _TruncatedMessage:
    """The raw response shape Claude 4.5+ returns when generation runs into the window."""

    stop_reason = "model_context_window_exceeded"


def _truncated_once_responder(log: list[str]):
    """The keeper's first reply stops mid-sentence; the one after the fold is whole."""
    state = {"keeper_calls": 0}

    def responder(messages, tools):
        if _is_fold(messages):
            log.append("fold")
            return assistant_text("Previously: the party pressed on.")
        state["keeper_calls"] += 1
        if state["keeper_calls"] == 1:
            log.append("keeper:truncated")
            result = assistant_text("The archivist turns, and behind her the water")
            result.raw = _TruncatedMessage()
            return result
        log.append("keeper:ok")
        return assistant_text("The archivist turns, and behind her the water is already rising.")

    return responder


async def test_a_reply_truncated_at_the_window_folds_and_regenerates():
    """This one is quieter than an error: HTTP 200, a narration that stops mid-sentence,
    and a turn that would otherwise be persisted and narrated onward from as if whole."""
    log: list[str] = []
    services = _services(_truncated_once_responder(log))
    chat_key = "truncated-recovers"
    toolset = await _room(services, chat_key, backlog=True)

    result = await run_kp_turn(_ctx(chat_key), services, toolset, "I follow her gaze.")

    assert result.reply.endswith("already rising."), "the player must not receive the severed line"
    assert log[0] == "keeper:truncated"
    assert "fold" in log
    assert log[-1] == "keeper:ok"
    # The severed draft is not what gets persisted.
    chain = await load_chain(services, chat_key, DEFAULT_HISTORY_KEY)
    assert chain[-1]["content"].endswith("already rising.")


async def test_a_truncated_reply_with_nothing_left_to_fold_is_kept_as_is():
    """No progress, no retry — the same guard as the error path. The turn still ships:
    a severed narration beats no narration, and the meter now records the wall."""
    log: list[str] = []

    def responder(messages, tools):
        if _is_fold(messages):
            log.append("fold")
            return assistant_text("Previously: nothing.")
        log.append("keeper:truncated")
        result = assistant_text("The archivist turns, and behind her the water")
        result.raw = _TruncatedMessage()
        return result

    services = _services(responder)
    chat_key = "truncated-at-the-floor"
    toolset = await _room(services, chat_key, backlog=False)

    result = await run_kp_turn(_ctx(chat_key), services, toolset, "I follow her gaze.")

    assert log == ["keeper:truncated"], "nothing to fold means no retry"
    assert "behind her the water" in result.reply
    meter = json.loads(await services.store.state_get(chat_key, "usage_stats"))
    assert meter["last"]["overflow"] is True, "the next turn must know this room hit the wall"


async def test_an_ordinary_reply_never_folds():
    """The success path's strictness control: a normal stop reason is left alone."""
    log: list[str] = []

    def responder(messages, tools):
        if _is_fold(messages):
            log.append("fold")
            return assistant_text("Previously: nothing.")
        log.append("keeper:ok")
        return assistant_text("The archivist says nothing at all.")

    services = _services(responder)
    chat_key = "ordinary-room"
    toolset = await _room(services, chat_key, backlog=True)

    await run_kp_turn(_ctx(chat_key), services, toolset, "I follow her gaze.")

    assert log == ["keeper:ok"]
