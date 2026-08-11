"""M18 oracle: the chronicle fold flow (`agent.chronicle`) — hysteresis, no-future, retention.

Written FIRST (red), offline and deterministic (FakeLLM/FakeEmbeddings). The
suite-wide conftest disables the chronicle fold (its LLM call would make every
other FakeLLM call-count assertion nondeterministic); these tests opt back in
on their own services, mirroring `tests/agent/test_scribe.py`.

The four oracles from the M18 brief:
1. spoiler projections      — tests/documents/test_chronicle_projections.py
2. no-future guard          — the lag window is never folded; forged fold input
                              referencing turns beyond the watermark is rejected
3. fold hysteresis          — 0.60 triggers, batches fold to the 0.40 floor,
                              0.85 is the emergency level (before the model call)
4. motivation regression    — after a 108-turn synthetic campaign under token
                              pressure, the session-3 pivotal choice is still
                              answerable at session 12 via retrieval or summary
"""

from __future__ import annotations

import json

from agent.chronicle import (
    CAMPAIGN_SUMMARY_DOC_TYPE,
    CAMPAIGN_SUMMARY_ID,
    CHRONICLE_DOC_TYPE,
    THREAD_DOC_TYPE,
    build_chronicle_sections,
    maybe_fold_chronicle,
    recall_folded_entries,
    render_recap,
    summary_through_turn,
)
from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, append_turn, load_chain, trim_folded
from agent.kp_tools_chronicle import ChronicleTools
from agent.loop import run_kp_turn
from agent.prompt_builder import build_system_prompt
from agent.services import build_services
from agent.tools import Toolset, tool
from core.chronicle import estimate_tokens
from core.documents import KEEPER_VIEWER, PLAYER_VIEWER, project
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call

CHAT = "chronicle-test"
SENTINEL = "THE SUNKEN BELL MUST NEVER RING"
WINDOW = 4000

# The session-3 pivotal choice (oracle 4). Tokens are whitespace-separated so
# FakeEmbeddings (a bag-of-tokens hash) can retrieve the record by content.
PROBE = "turn22 关键抉择 顾晚棠 拒绝 血契 仪式 救下 钟楼 守夜人"
FILLER = "the party searched the drowned stacks of the archive district and mapped another flooded gallery without incident "


class _NoopProvider:
    @tool
    async def noop(self, ctx: AgentCtx) -> str:
        """Do nothing of note."""
        return "ok"


def _toolset() -> Toolset:
    return Toolset(_NoopProvider())


def _services(llm: FakeLLM, *, enabled: bool = True):
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))
    # The suite-wide conftest turns the chronicle fold OFF for every other test;
    # these tests are ABOUT it (the scribe-test posture).
    services.settings.chronicle.enabled = enabled
    return services


def _ctx(chat_key: str = CHAT, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="kp", locale=locale)


async def _set_meter(services, chat_key: str, prompt_tokens: int, window: int = WINDOW) -> None:
    """Write the per-turn usage meter exactly as `infra.usage_stats` persists it."""
    payload = {
        "last": {"prompt": prompt_tokens, "completion": 0, "cache_hit": 0, "cache_miss": 0, "context_window": window},
        "session": {"prompt": prompt_tokens, "completion": 0, "cache_hit": 0, "cache_miss": 0, "turns": 1},
    }
    await services.store.state_set(chat_key, "usage_stats", json.dumps(payload))


async def _set_turn(services, chat_key: str, turn: int) -> None:
    await services.store.state_set(chat_key, "chronicle_turn", str(turn))


async def _seed_entries(services, chat_key: str, turns: list[int], *, tokens: int = 100, folded: bool = False) -> None:
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
                "folded": folded,
                "tokens": tokens,
            },
        )


# --- replayed-history fixtures for the fold-SIZING oracles ---------------------
# What a fold FREES is the replayed history its new watermark lets `trim_folded`
# drop, so the fixtures that make the sizing hand-checkable are transcript-sized,
# not record-sized:
#
#   estimate_tokens(pure ASCII) = (chars + 3) // 4
#   a 4N-char message           = EXACTLY N tokens
#   one turn = 2 messages       = 2N replayed tokens
#
# So folding through turn T frees `2N` tokens for every seeded turn at or below T,
# and nothing at all for a turn whose messages are not on the replayed path. The
# records' own `tokens` stamps are left deliberately meaningless: nothing sizes a
# fold by them.


async def _seed_history(services, chat_key: str, turns: list[int], *, tokens_per_message: int = 20) -> None:
    """Two replayed messages per turn, each of an EXACT token size (see above)."""
    text = "x" * (4 * tokens_per_message)
    for turn in turns:
        await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message=text, reply=text, turn=turn)


async def _replayed_turns(services, chat_key: str) -> list[int]:
    """The turn indices still replayed on the current path, after the fold watermark."""
    chain = await load_chain(services, chat_key, DEFAULT_HISTORY_KEY)
    kept = await trim_folded(
        services, chat_key, DEFAULT_HISTORY_KEY, chain, await summary_through_turn(services, chat_key)
    )
    return sorted({int(message["_lw_turn"]) for message in kept})


# --- binding-budget fixtures for the recall-render oracle ----------------------
# Direction is only observable when the character budget actually binds, so these
# records are deliberately fat: one rendered line is 12 + 1400 = 1412 chars, so a
# single line fits the 6000-char budget but ten lines (14120) cannot. Which ones
# survive is then a statement about which END the renderer spends from.
_FAT_TEXT_CHARS = 1400


def _fat_text(marker: str) -> str:
    """Record text carrying `marker` at the front, padded to a known fat length."""
    text = (marker + " " + FILLER * 20)[:_FAT_TEXT_CHARS].ljust(_FAT_TEXT_CHARS, ".")
    assert marker in text and len(text) == _FAT_TEXT_CHARS
    return text


async def _seed_marked_entries(
    services, chat_key: str, turns: list[int], *, marker: str, folded: bool = False, fat: bool = True
) -> None:
    """Records whose text is findable by marker — fat enough to bind the render
    budget (`fat=True`) or short enough that it cannot (the positive control)."""
    for turn in turns:
        tag = f"{marker}{turn}"
        await services.documents.put(
            chat_key,
            CHRONICLE_DOC_TYPE,
            f"c{turn:05d}",
            {
                "text": _fat_text(tag) if fat else tag,
                "keeper": "",
                "turn": turn,
                "pcs": [],
                "scene": "",
                "folded": folded,
                "tokens": 0,
            },
        )


def _is_fold_call(messages: list[dict], tools) -> bool:
    """The fold-generation call: no tools attached, and the localized fold instruction."""
    return tools is None and "campaign summary" in str(messages[0].get("content", ""))


# ---------------------------------------------------------------------------
# Gate: disabled chronicle never touches the LLM
# ---------------------------------------------------------------------------


async def test_disabled_chronicle_never_calls_the_llm():
    def _explode(messages, tools):
        raise AssertionError("chronicle disabled — the fold LLM must not be called")

    services = _services(FakeLLM(responder=_explode), enabled=False)
    await _set_turn(services, CHAT, 20)
    await _seed_entries(services, CHAT, list(range(1, 11)))
    await _set_meter(services, CHAT, int(0.95 * WINDOW))

    outcome = await maybe_fold_chronicle(_ctx(), services)
    assert outcome.ran is False


# ---------------------------------------------------------------------------
# Oracle 3: hysteresis — trigger / floor / emergency
# ---------------------------------------------------------------------------


async def test_below_the_trigger_nothing_folds():
    def _explode(messages, tools):
        raise AssertionError("below the 0.60 trigger the fold must not run")

    services = _services(FakeLLM(responder=_explode))
    await _set_turn(services, CHAT, 20)
    await _seed_entries(services, CHAT, list(range(1, 11)))
    await _set_meter(services, CHAT, int(0.59 * WINDOW))

    outcome = await maybe_fold_chronicle(_ctx(), services)
    assert outcome.ran is False and outcome.level == "none"
    assert await services.documents.get(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID) is None


async def test_trigger_at_060_folds_one_batch_down_to_the_040_floor():
    folds = {"n": 0}

    def responder(messages, tools):
        assert _is_fold_call(messages, tools), "the only LLM call here is the fold"
        folds["n"] += 1
        return assistant_text("Previously: the party entered the drowned archive.")

    services = _services(FakeLLM(responder=responder))
    await _set_turn(services, CHAT, 40)
    # 14 records, turns 10..23; counter 40 - lag 4 = watermark 36, so all 14 foldable.
    await _seed_entries(services, CHAT, list(range(10, 24)))
    await _seed_history(services, CHAT, list(range(10, 24)))  # 40 replayed tokens per turn
    await _set_meter(services, CHAT, 600, window=1000)

    outcome = await maybe_fold_chronicle(_ctx(), services)

    assert outcome.ran and outcome.level == "fold", "600/1000 is exactly the 0.60 trigger"
    # HAND-DERIVED. deficit = 600 - 0.40*1000 = 200 prompt tokens. Folding through
    # turn t stops turns 10..t being replayed, i.e. frees 40*(t-9):
    #   t=10 ->  40      t=12 -> 120      t=14 -> 200  >= 200  <- the answer
    #   t=11 ->  80      t=13 -> 160
    # so the answer is the smallest oldest-first prefix reaching it: 5 records
    # (turns 10..14), one batch (cap 12) and therefore one fold call.
    assert outcome.entries_folded == 5 and outcome.batches == 1 and folds["n"] == 1
    # after = (600 - 200) / 1000 — the floor, reached in replayed-history tokens.
    assert outcome.after == 0.40

    summary = await services.documents.get(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None
    assert summary.data["through_turn"] == 14, "turns 10..14 folded, oldest first"
    assert summary.data["fold_count"] == 1
    entries = await services.documents.list(CHAT, CHRONICLE_DOC_TYPE)
    assert [entry.id for entry in entries if entry.data["folded"]] == [f"c{turn:05d}" for turn in range(10, 15)]
    assert await _replayed_turns(services, CHAT) == list(range(15, 24)), "and the freed turns really stop replaying"


async def test_batch_folding_iterates_until_the_floor_is_reached():
    folds = {"n": 0}

    def responder(messages, tools):
        folds["n"] += 1
        return assistant_text(f"summary after batch {folds['n']}")

    services = _services(FakeLLM(responder=responder))
    await _set_turn(services, CHAT, 60)
    # 30 records, turns 10..39; counter 60 - lag 4 = watermark 56, so all 30 foldable.
    await _seed_entries(services, CHAT, list(range(10, 40)))
    # ...but terse turns: 10 replayed tokens each, so the whole transcript is 300.
    await _seed_history(services, CHAT, list(range(10, 40)), tokens_per_message=5)
    await _set_meter(services, CHAT, 2000, window=2000)

    outcome = await maybe_fold_chronicle(_ctx(), services)

    # HAND-DERIVED. deficit = 2000 - 0.40*2000 = 1200 prompt tokens, but the whole
    # replayed transcript is 30*10 = 300 tokens, so a COMPLETE fold frees 300 < 1200:
    # the chronicle cannot cover the deficit at any size. That is the spec's
    # small-window edge — the answer is every foldable record, not a number derived
    # from a deficit the chronicle was never going to close. 30 records at 12 per
    # batch = 12 + 12 + 6 = 3 batches, exactly the per-turn budget, so the whole
    # backlog drains this turn.
    assert outcome.batches == 3 and folds["n"] == 3, "batch folding: iterate, never one-entry-per-turn churn"
    assert outcome.entries_folded == 30
    # after = (2000 - 300) / 2000. NOT at the floor, and honestly so: the fold gave
    # everything it had. The old ledger reported reaching 0.40 on savings that only
    # existed in its own arithmetic.
    assert outcome.after == 0.85
    assert await _replayed_turns(services, CHAT) == [], "everything it folded really stopped replaying"


async def test_pressure_elsewhere_drains_the_backlog_once_and_then_stops():
    """F13 regression: sizing in the renderer's unit, and the guards that outlive it.

    The room is over the ceiling for a reason the chronicle cannot touch (a big
    module), while its tail is full. The old arithmetic credited each folded record's
    own token stamp against the WHOLE-prompt meter, so it declared the floor reached
    after a handful of records — savings that existed only in its ledger — and then,
    because the real prompt had not moved, folded again the next turn, and the next.
    """
    folds = {"n": 0}

    def responder(messages, tools):
        assert _is_fold_call(messages, tools), "the only LLM call here is the fold"
        folds["n"] += 1
        return assistant_text("Previously: the archive district drowned by degrees.")

    services = _services(FakeLLM(responder=responder))
    await _set_turn(services, CHAT, 60)
    # 24 records, turns 10..33; counter 60 - lag 4 = watermark 56, so all 24 foldable.
    await _seed_entries(services, CHAT, list(range(10, 34)))
    await _seed_history(services, CHAT, list(range(10, 34)), tokens_per_message=5)
    await _set_meter(services, CHAT, 1900, window=2000)

    outcome = await maybe_fold_chronicle(_ctx(), services)

    # HAND-DERIVED. deficit = 1900 - 0.40*2000 = 1100; the replayed transcript is
    # 24*10 = 240 tokens, so a complete fold frees 240 < 1100 -> fold does its best:
    # all 24 records, at 12 per batch = 2 batches.
    assert outcome.entries_folded == 24, "the whole backlog drains, not a fictional floor's worth"
    assert outcome.batches == 2 and folds["n"] == 2
    # after = (1900 - 240) / 2000: what the prompt actually gave up, not what the
    # records weighed.
    assert outcome.after == 0.83

    # Turn 2. New records AND new turns arrive (so there IS something foldable and
    # the replay-floor gate would pass), but the meter has not moved: the fold
    # demonstrably freed nothing the prompt noticed, so it must not buy another call.
    # This is the re-arm guard, still load-bearing now that the arithmetic is honest —
    # the remaining approximation is the tokenizer gap and recall reflow, and only the
    # meter can see those.
    await _seed_entries(services, CHAT, list(range(34, 44)))
    await _seed_history(services, CHAT, list(range(34, 44)), tokens_per_message=5)
    await _set_meter(services, CHAT, 1900, window=2000)

    again = await maybe_fold_chronicle(_ctx(), services)

    assert folds["n"] == 2, "an unmoved meter buys no further folds"
    assert again.entries_folded == 0 and not again.ran


async def test_emergency_level_folds_before_the_model_call():
    captured: dict[str, str] = {}

    def responder(messages, tools):
        if _is_fold_call(messages, tools):
            return assistant_text("folded summary: the bell tolls no more")
        if tools is not None:
            # The chronicle section rides the volatile tail, which M20 A1 moved out of the
            # system message into the state message just before the player's.
            captured["prompt"] = "\n\n".join(str(m.get("content") or "") for m in messages[:-1])
        return assistant_text("The road winds on.")

    services = _services(FakeLLM(responder=responder))
    ctx = _ctx("chrono-emergency")
    await _set_turn(services, ctx.chat_key, 20)
    await _seed_entries(services, ctx.chat_key, list(range(1, 11)), tokens=100)
    await _seed_history(services, ctx.chat_key, list(range(1, 11)))
    await _set_meter(services, ctx.chat_key, int(0.90 * 2000), window=2000)  # >= 0.85 emergency

    result = await run_kp_turn(ctx, services, _toolset(), "turn 1")

    assert result.reply == "The road winds on."
    summary = await services.documents.get(ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None, "an over-ceiling meter folds before the next model call"
    assert "the bell tolls no more" in captured["prompt"], "the KP call of THIS turn already sees the new summary"


# ---------------------------------------------------------------------------
# The cost model: a fold is priced in the REPLAYED HISTORY it lets go
# ---------------------------------------------------------------------------


async def test_an_emergency_fold_still_runs_with_no_raw_records_in_the_prompt():
    """The regression the two halves of this change exist to prevent, in one room.

    Dropping the raw-record block from the prompt (it duplicated history the room was
    replaying anyway) removes the quantity the old fold measured. Had the cost model
    stayed "how much smaller does the chronicle SECTION render", it would now read 0
    on every room forever — and since the 0.85 emergency level is NOT an override
    (only the manual `.chronicle fold` bypasses the guards), a campaign at the ceiling
    could never trim itself again. It must still fold, and for the right reason.
    """
    folds = {"n": 0}

    def responder(messages, tools):
        assert _is_fold_call(messages, tools), "the only LLM call here is the fold"
        folds["n"] += 1
        return assistant_text("Previously: the drowned archive gave up its dead.")

    services = _services(FakeLLM(responder=responder))
    ctx = _ctx("chrono-emergency-floor")
    i18n = services.i18n.with_locale("en")
    await _set_turn(services, ctx.chat_key, 40)
    await _seed_entries(services, ctx.chat_key, list(range(10, 30)))
    await _seed_history(services, ctx.chat_key, list(range(10, 30)))
    await _set_meter(services, ctx.chat_key, 1800, window=2000)  # 0.90 — over the emergency level

    # The prompt really does carry no raw record (the premise of the regression).
    before = await build_chronicle_sections(ctx, services, i18n)
    assert "turn29" not in before.stable + before.volatile

    outcome = await maybe_fold_chronicle(_ctx(ctx.chat_key), services)

    assert outcome.ran and outcome.level == "emergency"
    assert outcome.entries_folded > 0 and folds["n"] > 0, "the emergency valve is not welded shut"
    assert outcome.after < outcome.before, "and it freed something the meter will see"


async def test_fold_sizing_tracks_replayed_history_not_record_count():
    """Two rooms, identical records and identical meters — only the transcript weight
    differs. A talkative table frees its deficit in fewer records than a terse one, and
    nothing about a chronicle record can express that."""
    def _fold(messages, tools):
        return assistant_text("Previously: the party pressed on.")

    async def _folded_count(chat_key: str, *, tokens_per_message: int) -> int:
        services = _services(FakeLLM(responder=_fold))
        await _set_turn(services, chat_key, 60)
        await _seed_entries(services, chat_key, list(range(10, 30)))
        await _seed_history(services, chat_key, list(range(10, 30)), tokens_per_message=tokens_per_message)
        await _set_meter(services, chat_key, 600, window=1000)  # deficit = 600 - 400 = 200
        return (await maybe_fold_chronicle(_ctx(chat_key), services)).entries_folded

    # 40 replayed tokens per turn: folding through turn t frees 40*(t-9) >= 200 at t=14.
    assert await _folded_count("chrono-cost-talkative", tokens_per_message=20) == 5
    # 20 per turn: the same 200 tokens now take twice as many turns — t=19, 10 records.
    assert await _folded_count("chrono-cost-terse", tokens_per_message=10) == 10


async def test_folding_through_a_turn_frees_exactly_the_turns_trim_folded_drops():
    """The identity the whole cost model rests on: what the fold CLAIMS it freed is
    what `trim_folded` then really stops replaying, message for message."""
    def _fold(messages, tools):
        return assistant_text("Previously: the bell was silenced.")

    services = _services(FakeLLM(responder=_fold))
    chat_key = "chrono-trim-identity"
    await _set_turn(services, chat_key, 60)
    await _seed_entries(services, chat_key, list(range(10, 30)))
    await _seed_history(services, chat_key, list(range(10, 30)))
    await _set_meter(services, chat_key, 600, window=1000)
    before_chain = await load_chain(services, chat_key, DEFAULT_HISTORY_KEY)

    outcome = await maybe_fold_chronicle(_ctx(chat_key), services)

    through = await summary_through_turn(services, chat_key)
    assert outcome.through_turn == through > 0, "the fold's watermark is what the summary now carries"
    dropped = [m for m in before_chain if int(m["_lw_turn"]) <= through]
    kept = await trim_folded(services, chat_key, DEFAULT_HISTORY_KEY, before_chain, through)

    assert [int(m["_lw_turn"]) for m in kept] == sorted(turn for turn in range(10, 30) for _ in (0, 1) if turn > through)
    assert dropped, "positive control: something was actually dropped"
    # ...and the fold's own ledger is that same quantity, in the same unit.
    freed = sum(estimate_tokens(str(message["content"])) for message in dropped)
    assert outcome.after == (600 - freed) / 1000


# ---------------------------------------------------------------------------
# Oracle 2: the no-future guard
# ---------------------------------------------------------------------------


async def test_the_lag_window_is_never_folded_even_under_emergency_pressure():
    def _explode(messages, tools):
        raise AssertionError("only lag-window entries exist — no fold may be attempted")

    services = _services(FakeLLM(responder=_explode))
    await _set_turn(services, CHAT, 10)
    await _seed_entries(services, CHAT, [7, 8, 9, 10])  # all inside the last-4-turns window
    # Their turns ARE on the replayed path, so the fold has something to free and the
    # watermark is the only thing standing between this room and a fold call.
    await _seed_history(services, CHAT, [7, 8, 9, 10])
    await _set_meter(services, CHAT, 2000, window=2000)

    outcome = await maybe_fold_chronicle(_ctx(), services)
    assert outcome.entries_folded == 0
    entries = await services.documents.list(CHAT, CHRONICLE_DOC_TYPE)
    assert all(not entry.data["folded"] for entry in entries), "the in-flight scene stays raw"


async def test_a_fold_input_referencing_the_future_is_rejected_engine_side():
    """Defense in depth: even if batch selection were fooled, the fold refuses any
    input whose turn indices pass the watermark (the deterministic half of 不许写未来)."""
    import agent.chronicle as chronicle_flow
    from core.chronicle import FoldCandidate

    def _explode(messages, tools):
        raise AssertionError("a no-future violation must abort the fold before the LLM call")

    services = _services(FakeLLM(responder=_explode))
    await _set_turn(services, CHAT, 10)  # watermark = 6
    await _seed_entries(services, CHAT, [1, 2, 8])
    await _seed_history(services, CHAT, [1, 2, 8])
    await _set_meter(services, CHAT, 2000, window=2000)

    forged = [FoldCandidate(id="c00008", turn=8, tokens=100)]  # beyond the watermark
    original = chronicle_flow.select_fold_batch
    chronicle_flow.select_fold_batch = lambda *a, **k: forged
    try:
        outcome = await maybe_fold_chronicle(_ctx(), services)
    finally:
        chronicle_flow.select_fold_batch = original

    assert outcome.rejected >= 1 and outcome.entries_folded == 0
    assert await services.documents.get(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID) is None
    entry = await services.documents.get(CHAT, CHRONICLE_DOC_TYPE, "c00008")
    assert entry is not None and entry.data["folded"] is False


# ---------------------------------------------------------------------------
# Fold mechanics: summary lifecycle + keeper margin + retrieval index
# ---------------------------------------------------------------------------


async def test_fold_preserves_the_keeper_margin_and_marks_entries_folded():
    def responder(messages, tools):
        return assistant_text("Previously: the party reached the chapel.")

    services = _services(FakeLLM(responder=responder))
    await _set_turn(services, CHAT, 20)
    await _seed_entries(services, CHAT, [1, 2, 3], tokens=100)
    await _seed_history(services, CHAT, [1, 2, 3])
    await services.documents.put(
        CHAT,
        CAMPAIGN_SUMMARY_DOC_TYPE,
        CAMPAIGN_SUMMARY_ID,
        {"text": "old summary", "keeper": SENTINEL, "through_turn": 0, "fold_count": 2},
    )
    await _set_meter(services, CHAT, 1200, window=2000)

    await maybe_fold_chronicle(_ctx(), services)

    summary = await services.documents.get(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None
    assert summary.data["text"] == "Previously: the party reached the chapel."
    assert summary.data["keeper"] == SENTINEL, "the keeper margin survives regeneration (keeper-editable)"
    assert summary.data["fold_count"] == 3


async def test_folded_entries_join_the_embedding_index_for_topical_recall():
    def responder(messages, tools):
        return assistant_text("Previously: things happened.")

    services = _services(FakeLLM(responder=responder))
    await _set_turn(services, CHAT, 20)
    await services.documents.put(
        CHAT,
        CHRONICLE_DOC_TYPE,
        "c00001",
        {"text": PROBE, "keeper": SENTINEL, "turn": 1, "pcs": ["顾晚棠"], "scene": "", "folded": False, "tokens": 100},
    )
    await _seed_entries(services, CHAT, [2, 3], tokens=100)
    await _seed_history(services, CHAT, [1, 2, 3])
    await _set_meter(services, CHAT, 1200, window=2000)

    await maybe_fold_chronicle(_ctx(), services)

    recalled = await recall_folded_entries(services, CHAT, "血契 仪式 顾晚棠")
    assert any(doc.id == "c00001" for doc in recalled), "the folded session-3 record stays topically retrievable"


async def test_a_failed_fold_llm_call_never_raises_or_clobbers_the_summary():
    def boom(messages, tools):
        raise RuntimeError("summarizer offline")

    services = _services(FakeLLM(responder=boom))
    await _set_turn(services, CHAT, 20)
    await _seed_entries(services, CHAT, [1, 2, 3], tokens=100)
    await _seed_history(services, CHAT, [1, 2, 3])
    await services.documents.put(
        CHAT,
        CAMPAIGN_SUMMARY_DOC_TYPE,
        CAMPAIGN_SUMMARY_ID,
        {"text": "prior summary", "keeper": "", "through_turn": 0, "fold_count": 1},
    )
    await _set_meter(services, CHAT, 1200, window=2000)

    outcome = await maybe_fold_chronicle(_ctx(), services)  # must NOT raise

    assert outcome.entries_folded == 0
    summary = await services.documents.get(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None and summary.data["text"] == "prior summary"
    entries = await services.documents.list(CHAT, CHRONICLE_DOC_TYPE)
    assert all(not entry.data["folded"] for entry in entries), "a failed fold marks nothing"


# ---------------------------------------------------------------------------
# The record_chronicle / update_thread tools
# ---------------------------------------------------------------------------


async def test_record_chronicle_tool_writes_a_past_only_entry():
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call(
                    "record_chronicle",
                    text="The party rang the chapel bell.",
                    keeper_notes=SENTINEL,
                    pcs="Martha, Elias",
                    scene="chapel",
                )
            ),
            assistant_text("The bell falls silent."),
        ]
    )
    services = _services(llm)
    ctx = _ctx("chrono-tool")

    result = await run_kp_turn(ctx, services, Toolset(ChronicleTools(services)), "turn 1")

    assert result.reply == "The bell falls silent."
    docs = await services.documents.list(ctx.chat_key, CHRONICLE_DOC_TYPE)
    assert len(docs) == 1
    data = docs[0].data
    assert data["turn"] == 1, "an entry records the turn it was written after — never the future"
    assert data["pcs"] == ["Martha", "Elias"]
    keeper_view = json.dumps(project(docs[0], KEEPER_VIEWER), ensure_ascii=False)
    player_view = json.dumps(project(docs[0], PLAYER_VIEWER), ensure_ascii=False)
    assert SENTINEL in keeper_view and SENTINEL not in player_view


async def test_update_thread_tool_lifecycle_and_validation():
    services = _services(FakeLLM())
    ctx = _ctx("chrono-thread")
    tools = ChronicleTools(services)

    opened = await tools.update_thread(ctx, label="The armed bell", status="open", notes="players missed the second pull")
    assert "The armed bell" in opened

    bad = await tools.update_thread(ctx, label="The armed bell", status="bogus")
    assert "open" in bad or "resolved" in bad, "an invalid status is rejected with the allowed vocabulary"
    threads = await services.documents.list(ctx.chat_key, THREAD_DOC_TYPE)
    assert len(threads) == 1 and threads[0].data["status"] == "open", "a rejected write changes nothing"

    resolved = await tools.update_thread(ctx, label="The armed bell", status="resolved")
    assert "resolved" in resolved
    threads = await services.documents.list(ctx.chat_key, THREAD_DOC_TYPE)
    assert len(threads) == 1, "same label upserts the same thread"
    assert threads[0].data["status"] == "resolved"


# ---------------------------------------------------------------------------
# The prompt section (single injection point) + the spoiler-free recap
# ---------------------------------------------------------------------------


async def test_chronicle_sections_split_the_summary_from_the_threads():
    """The summary is FOLD-synchronous, so it rides the cacheable head; threads move on
    their own schedule, so they ride the tail. And no raw record rides either half: an
    unfolded record's own turn is still replayed verbatim a few messages later."""
    services = _services(FakeLLM())
    ctx = _ctx("chrono-section")
    i18n = services.i18n.with_locale("en")
    await services.documents.put(
        ctx.chat_key,
        CAMPAIGN_SUMMARY_DOC_TYPE,
        CAMPAIGN_SUMMARY_ID,
        {"text": "Previously: the party freed the bell ringer.", "keeper": SENTINEL, "through_turn": 40, "fold_count": 3},
    )
    await services.documents.put(
        ctx.chat_key, THREAD_DOC_TYPE, "t-1", {"label": "The armed bell", "status": "open", "notes": ""}
    )
    await services.documents.put(
        ctx.chat_key,
        THREAD_DOC_TYPE,
        "t-2",
        {"label": "A closed lead", "status": "resolved", "notes": ""},
    )
    await _seed_entries(services, ctx.chat_key, [41], tokens=100)

    sections = await build_chronicle_sections(ctx, services, i18n)

    assert i18n.t("prompt.chronicle.header") in sections.stable, "the header leads the half that opens"
    assert "freed the bell ringer" in sections.stable, "the rolling summary rides the STABLE head"
    assert SENTINEL in sections.stable, "KP-grade: the keeper margin is for the KP's eyes"
    assert "The armed bell" in sections.volatile, "open threads ride the volatile tail"
    assert "A closed lead" not in sections.volatile, "only OPEN threads nag"
    assert "turn41" not in sections.stable + sections.volatile, (
        "the unfolded record's own turn is still being replayed verbatim — rendering it "
        "here would carry the same events twice"
    )

    prompt = await build_system_prompt(ctx, services)
    assert i18n.t("prompt.chronicle.header") in prompt, "and both halves join the single system prompt"
    assert "freed the bell ringer" in prompt and "The armed bell" in prompt


async def test_the_threads_carry_the_header_when_nothing_has_folded_yet():
    """The header frames the whole chronicle, so it leads whichever half opens it —
    a room with threads but no summary still gets the framing."""
    services = _services(FakeLLM())
    ctx = _ctx("chrono-section-threads-only")
    i18n = services.i18n.with_locale("en")
    await services.documents.put(
        ctx.chat_key, THREAD_DOC_TYPE, "t-1", {"label": "The armed bell", "status": "open", "notes": ""}
    )

    sections = await build_chronicle_sections(ctx, services, i18n)

    assert sections.stable == "", "nothing has folded yet"
    assert sections.volatile.startswith(i18n.t("prompt.chronicle.header"))
    assert "The armed bell" in sections.volatile


async def test_a_binding_budget_keeps_the_most_relevant_recall():
    """Recall arrives most-relevant-first, so the FRONT is what a binding character
    budget must keep. Pinned so nobody "generalizes" this renderer into one that
    spends its budget from the other end (which a chronological block would want)."""
    import agent.chronicle as chronicle_flow

    services = _services(FakeLLM())
    i18n = services.i18n.with_locale("en")

    async def _seed(chat_key: str, *, fat: bool) -> list:
        # Ten folded records -> the recall pool, handed back in relevance order.
        await _seed_marked_entries(
            services, chat_key, list(range(30, 40)), marker="RECALL", folded=True, fat=fat
        )
        return [
            await services.documents.get(chat_key, CHRONICLE_DOC_TYPE, f"c{turn:05d}") for turn in range(30, 40)
        ]

    async def _section(chat_key: str, *, fat: bool) -> str:
        by_relevance = await _seed(chat_key, fat=fat)

        async def _fake_recall(_services, _chat_key, _query, *, limit=4):
            return by_relevance  # most relevant FIRST — the contract of this list

        original = chronicle_flow.recall_folded_entries
        chronicle_flow.recall_folded_entries = _fake_recall
        try:
            sections = await build_chronicle_sections(
                _ctx(chat_key), services, i18n, recent_context="the drowned archive"
            )
        finally:
            chronicle_flow.recall_folded_entries = original
        return sections.volatile

    # POSITIVE CONTROL: same wiring, short records — nothing binds, so every marker
    # renders. A later absence assertion therefore means "the budget bound", not
    # "the section, the recall hook or the markers were broken all along".
    slack = await _section("chrono-render-slack", fat=False)
    for marker in ("RECALL30", "RECALL39"):
        assert marker in slack, f"{marker} must render when the budget has slack"

    bound = await _section("chrono-render-bound", fat=True)

    assert "RECALL30" in bound, "recall is ordered by relevance: the front is what fits"
    assert "RECALL39" not in bound, "the LEAST relevant recall is what a binding budget drops"


async def test_chronicle_sections_are_absent_for_a_fresh_room():
    services = _services(FakeLLM())
    ctx = _ctx("chrono-empty")
    i18n = services.i18n.with_locale("en")

    sections = await build_chronicle_sections(ctx, services, i18n)
    assert (sections.stable, sections.volatile) == ("", "")
    prompt = await build_system_prompt(ctx, services)
    assert i18n.t("prompt.chronicle.header") not in prompt


async def test_render_recap_is_the_player_projection_spoiler_free():
    services = _services(FakeLLM())
    i18n = services.i18n.with_locale("zh")
    await services.documents.put(
        CHAT,
        CAMPAIGN_SUMMARY_DOC_TYPE,
        CAMPAIGN_SUMMARY_ID,
        {"text": "前情提要：众人救下了敲钟人。", "keeper": SENTINEL, "through_turn": 40, "fold_count": 1},
    )
    await services.documents.put(
        CHAT,
        CHRONICLE_DOC_TYPE,
        "c00041",
        {"text": "众人在码头扎营。", "keeper": SENTINEL, "turn": 41, "pcs": [], "scene": "", "folded": False, "tokens": 50},
    )

    recap = await render_recap(services, CHAT, i18n)

    assert recap is not None
    assert "前情提要：众人救下了敲钟人。" in recap and "众人在码头扎营。" in recap
    assert SENTINEL not in recap and "keeper" not in recap, "the recap is structurally spoiler-free"


async def test_render_recap_returns_none_when_nothing_is_recorded():
    services = _services(FakeLLM())
    i18n = services.i18n.with_locale("en")
    assert await render_recap(services, "empty-room", i18n) is None


# ---------------------------------------------------------------------------
# Oracle 4: the motivation regression — a 108-turn synthetic campaign
# ---------------------------------------------------------------------------


def _accumulating_summary(user: str) -> str:
    """A FakeLLM fold summarizer: carry the previous summary forward and append
    each folded record's text (bounded, like the real instruction demands)."""
    previous = ""
    if "Previous summary" in user and "Chronicle records" in user:
        previous = user.split("Previous summary", 1)[1].split("Chronicle records", 1)[0].strip(":\n ")
        if "(none yet)" in previous:
            previous = ""
    records = [line for line in user.splitlines() if line.startswith("- [turn ")]
    folded = "\n".join(line[len("- ") :] for line in records)
    return (previous + "\n" + folded).strip()[:600]


async def test_session_3_pivotal_choice_answerable_at_session_12():
    """108 turns (12 sessions x 9) under synthetic token pressure. The fold must
    keep the room under the trigger band, never touch the trailing lag window,
    and the session-3 pivotal choice must survive to session 12 — via retrieval
    of the folded record or via the rolling summary (the M18 motivation)."""
    state = {"records": 0}
    # The turns themselves are what fills the window — a played turn is a paragraph of
    # player intent and a paragraph of narration, and both are replayed verbatim until
    # a fold's watermark retires them. ~110 tokens per exchange against a 4000-token
    # window puts this campaign over the trigger every seven turns or so.
    player_line = "I press deeper into the flooded gallery, checking every alcove. " + FILLER * 2
    narration = "The road winds on. " + FILLER * 2

    def responder(messages, tools):
        if tools is None:
            assert _is_fold_call(messages, tools), "the fold is the only tool-less lane in a KP turn"
            user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
            return assistant_text(_accumulating_summary(user))
        if state["records"] >= 108:
            return assistant_text(narration)  # the settling turns record nothing
        if messages and messages[-1].get("role") == "tool":
            return assistant_text(narration)
        state["records"] += 1
        turn = state["records"]
        text = PROBE if turn == 22 else f"turn{turn} " + FILLER * 3
        return assistant_tools(tool_call("record_chronicle", text=text))

    services = _services(FakeLLM(responder=responder))
    services.settings.chronicle.summary_max_chars = 600
    ctx = _ctx("chrono-campaign")
    toolset = Toolset(ChronicleTools(services))

    async def _honest_prompt_tokens() -> int:
        """What a real provider would report: fixed sections + summary + replayed turns."""
        summary = await services.documents.get(ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        summary_tokens = estimate_tokens(str(summary.data.get("text", ""))) if summary else 0
        chain = await load_chain(services, ctx.chat_key, DEFAULT_HISTORY_KEY)
        kept = await trim_folded(
            services,
            ctx.chat_key,
            DEFAULT_HISTORY_KEY,
            chain,
            await summary_through_turn(services, ctx.chat_key),
        )
        replayed = sum(estimate_tokens(str(message.get("content") or "")) for message in kept)
        return 400 + summary_tokens + replayed

    async def honest_meter() -> None:
        await _set_meter(services, ctx.chat_key, await _honest_prompt_tokens())

    # 108 recorded turns (12 sessions x 9), then TWO settling turns: a fold acts on the
    # PREVIOUS turn's meter, so one settling turn only guarantees a fold when turn 108
    # already crossed the trigger. Two guarantee it either way.
    turns = 110
    for _ in range(turns):
        await run_kp_turn(ctx, services, toolset, player_line)
        await honest_meter()

    assert state["records"] == 108
    summary = await services.documents.get(ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None and summary.data["fold_count"] >= 3, "a long campaign folds in batches, repeatedly"

    entries = await services.documents.list(ctx.chat_key, CHRONICLE_DOC_TYPE)
    assert len(entries) == 108
    lag = [entry for entry in entries if entry.data["turn"] > turns - 4]
    assert lag and all(not entry.data["folded"] for entry in lag), "the trailing lag window stays raw"
    old = [entry for entry in entries if entry.data["turn"] <= turns - 4]
    assert any(entry.data["folded"] for entry in old), "old history folded into the summary"

    # Steady state: with every due fold settled, the honest meter sits under the
    # 0.60 trigger — the hysteresis band keeps a long campaign from re-topping.
    assert await _honest_prompt_tokens() / WINDOW < 0.60

    # The regression that motivated M18: the session-3 pivotal choice is still
    # answerable at session 12 — via topical retrieval or via the summary.
    recalled = await recall_folded_entries(services, ctx.chat_key, "血契 仪式 顾晚棠")
    probe_via_retrieval = any("血契" in str(doc.data.get("text", "")) for doc in recalled)
    probe_via_summary = "血契" in str(summary.data.get("text", ""))
    assert probe_via_retrieval or probe_via_summary
