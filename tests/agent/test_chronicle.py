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
    build_chronicle_section,
    maybe_fold_chronicle,
    recall_folded_entries,
    render_recap,
)
from agent.context import AgentCtx
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
    await _set_turn(services, CHAT, 20)
    # 12 entries x 100 tokens; meter exactly at the 0.60 trigger of a 2000-token window.
    await _seed_entries(services, CHAT, list(range(1, 13)), tokens=100)
    await _set_meter(services, CHAT, 1200, window=2000)

    outcome = await maybe_fold_chronicle(_ctx(), services)

    assert outcome.ran and outcome.level == "fold"
    # Floor projection: needed = 1200 - 0.40*2000 = 400 tokens -> exactly 4 entries.
    assert outcome.entries_folded == 4 and outcome.batches == 1 and folds["n"] == 1
    assert outcome.after <= 0.40 + 1e-9, "folding stops at the floor, not below it"

    summary = await services.documents.get(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None
    assert summary.data["through_turn"] == 4, "the summary watermark covers the folded batch"
    assert summary.data["fold_count"] == 1
    entries = await services.documents.list(CHAT, CHRONICLE_DOC_TYPE)
    assert sum(1 for entry in entries if entry.data["folded"]) == 4
    assert [entry.id for entry in entries if entry.data["folded"]] == ["c00001", "c00002", "c00003", "c00004"]


async def test_batch_folding_iterates_until_the_floor_is_reached():
    folds = {"n": 0}

    def responder(messages, tools):
        folds["n"] += 1
        return assistant_text(f"summary after batch {folds['n']}")

    services = _services(FakeLLM(responder=responder))
    await _set_turn(services, CHAT, 40)
    # 30 small entries x 50 tokens; a full meter (2000/2000) needs 1200 freed to
    # reach the 0.40 floor, and a batch caps at 12 entries (600 tokens) -> 2 batches.
    await _seed_entries(services, CHAT, list(range(1, 31)), tokens=50)
    await _set_meter(services, CHAT, 2000, window=2000)

    outcome = await maybe_fold_chronicle(_ctx(), services)

    assert outcome.batches == 2 and folds["n"] == 2, "batch folding: iterate, never one-entry-per-turn churn"
    assert outcome.entries_folded == 24
    assert outcome.after <= 0.40 + 1e-9


async def test_emergency_level_folds_before_the_model_call():
    captured: dict[str, str] = {}

    def responder(messages, tools):
        if _is_fold_call(messages, tools):
            return assistant_text("folded summary: the bell tolls no more")
        if tools is not None:
            captured["system"] = str(messages[0].get("content", ""))
        return assistant_text("The road winds on.")

    services = _services(FakeLLM(responder=responder))
    ctx = _ctx("chrono-emergency")
    await _set_turn(services, ctx.chat_key, 20)
    await _seed_entries(services, ctx.chat_key, list(range(1, 11)), tokens=100)
    await _set_meter(services, ctx.chat_key, int(0.90 * 2000), window=2000)  # >= 0.85 emergency

    result = await run_kp_turn(ctx, services, _toolset(), "turn 1")

    assert result.reply == "The road winds on."
    summary = await services.documents.get(ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None, "an over-ceiling meter folds before the next model call"
    assert "the bell tolls no more" in captured["system"], "the KP call of THIS turn already sees the new summary"


# ---------------------------------------------------------------------------
# Oracle 2: the no-future guard
# ---------------------------------------------------------------------------


async def test_the_lag_window_is_never_folded_even_under_emergency_pressure():
    def _explode(messages, tools):
        raise AssertionError("only lag-window entries exist — no fold may be attempted")

    services = _services(FakeLLM(responder=_explode))
    await _set_turn(services, CHAT, 10)
    await _seed_entries(services, CHAT, [7, 8, 9, 10])  # all inside the last-4-turns window
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


async def test_chronicle_section_carries_summary_threads_and_tail_to_the_kp():
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

    section = await build_chronicle_section(ctx, services, i18n)

    assert i18n.t("prompt.chronicle.header") in section
    assert "freed the bell ringer" in section, "the rolling summary rides the section"
    assert SENTINEL in section, "KP-grade: the keeper margin is for the KP's eyes"
    assert "The armed bell" in section and "A closed lead" not in section, "only OPEN threads nag"
    assert "turn41" in section, "the raw tail rides along"

    prompt = await build_system_prompt(ctx, services)
    assert i18n.t("prompt.chronicle.header") in prompt, "the section joins the single system prompt"


async def test_chronicle_section_is_absent_for_a_fresh_room():
    services = _services(FakeLLM())
    ctx = _ctx("chrono-empty")
    i18n = services.i18n.with_locale("en")

    assert await build_chronicle_section(ctx, services, i18n) == ""
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

    def responder(messages, tools):
        if tools is None:
            if _is_fold_call(messages, tools):
                user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
                return assistant_text(_accumulating_summary(user))
            return assistant_text("recap notes")  # the session-recap refresh
        if state["records"] >= 108:
            return assistant_text("The road winds on.")  # the settling turn records nothing
        if messages and messages[-1].get("role") == "tool":
            return assistant_text("The road winds on.")
        state["records"] += 1
        turn = state["records"]
        text = PROBE if turn == 22 else f"turn{turn} " + FILLER * 3
        return assistant_tools(tool_call("record_chronicle", text=text))

    services = _services(FakeLLM(responder=responder))
    services.settings.chronicle.summary_max_chars = 600
    ctx = _ctx("chrono-campaign")
    toolset = Toolset(ChronicleTools(services))

    async def honest_meter() -> None:
        """The meter a real provider would report: fixed sections + summary + raw tail."""
        summary = await services.documents.get(ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        summary_tokens = estimate_tokens(str(summary.data.get("text", ""))) if summary else 0
        entries = await services.documents.list(ctx.chat_key, CHRONICLE_DOC_TYPE)
        raw_tokens = sum(int(entry.data.get("tokens", 0)) for entry in entries if not entry.data.get("folded"))
        await _set_meter(services, ctx.chat_key, 400 + summary_tokens + raw_tokens)

    # 108 recorded turns (12 sessions x 9), then one settling turn so a fold
    # whose trigger was crossed by turn 108's meter still fires before we assert.
    for _ in range(109):
        await run_kp_turn(ctx, services, toolset, "turn 1")
        await honest_meter()

    assert state["records"] == 108
    summary = await services.documents.get(ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
    assert summary is not None and summary.data["fold_count"] >= 3, "a long campaign folds in batches, repeatedly"

    entries = await services.documents.list(ctx.chat_key, CHRONICLE_DOC_TYPE)
    assert len(entries) == 108
    lag = [entry for entry in entries if entry.data["turn"] > 109 - 4]
    assert lag and all(not entry.data["folded"] for entry in lag), "the trailing lag window stays raw"
    old = [entry for entry in entries if entry.data["turn"] <= 109 - 4]
    assert any(entry.data["folded"] for entry in old), "old history folded into the summary"

    # Steady state: with every due fold settled, the honest meter sits under the
    # 0.60 trigger — the hysteresis band keeps a long campaign from re-topping.
    summary_tokens = estimate_tokens(str(summary.data.get("text", "")))
    raw_tokens = sum(int(entry.data.get("tokens", 0)) for entry in entries if not entry.data.get("folded"))
    assert (400 + summary_tokens + raw_tokens) / WINDOW < 0.60

    # The regression that motivated M18: the session-3 pivotal choice is still
    # answerable at session 12 — via topical retrieval or via the summary.
    recalled = await recall_folded_entries(services, ctx.chat_key, "血契 仪式 顾晚棠")
    probe_via_retrieval = any("血契" in str(doc.data.get("text", "")) for doc in recalled)
    probe_via_summary = "血契" in str(summary.data.get("text", ""))
    assert probe_via_retrieval or probe_via_summary
