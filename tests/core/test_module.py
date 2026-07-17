"""Tests for core.module_initializer: LLM-driven full-text module analysis,
split into a keeper-only knowledge pool (full secrets) and a player-safe
knowledge pool (spoiler-free subset).

Ported behavior under test, per `docs/specs/M1.md` §5:
- `initialize(chat_key)` reads `module_fulltext.{chat_key}` (or falls back to
  `vector_db.list_all_chunks`), analyzes it via `infra.llm.LLMClient`, and
  persists `module_keeper_pool.{chat_key}` / `module_player_pool.{chat_key}` /
  `module_init_status.{chat_key}`.
- The primary scenario (§7 step 2 of the M1 e2e spec): a scripted `FakeLLM`
  returns a JSON analysis whose keeper-only truth contains the sentinel
  secret from `tests/fixtures/module_en.txt` ("THE LIGHTHOUSE KEEPER IS THE
  MURDERER") -> the keeper pool contains it, the player pool never does.
- A non-JSON ("junk") LLM response falls back to `_fallback_full_analysis`
  (no LLM, regex/heuristic) and still completes with `status == "ready"`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from core.battle_report import BattleReportManager
from core.module_initializer import ModuleInitializer
from infra.config import LLMSettings, Settings
from infra.i18n import I18n
from infra.llm import ChatResult, FakeLLM, Usage, assistant_text, context_window_for
from infra.store import Store

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
MODULE_EN_TEXT = (FIXTURES_DIR / "module_en.txt").read_text(encoding="utf-8")

SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"


def _scripted_analysis_json() -> str:
    """A well-formed analysis JSON (as an LLM would emit it) whose only
    sentinel-bearing fields are keeper-only (`npcs[].secret`, `truths[]`)."""
    return json.dumps(
        {
            "scenes": [
                {
                    "name": "The Salt & Anchor Inn",
                    "focus": "explore",
                    "description": "A low-beamed, smoke-stained tavern. The innkeeper eyes strangers warily.",
                    "keeper_notes": "Martha will mention the light 'changed color' if pressed gently.",
                    "npcs_present": ["Martha"],
                    "clues": [
                        {
                            "name": "Tide table",
                            "description": "A scratched tide table with three circled dates.",
                            "discovery_method": "Spot Hidden",
                        }
                    ],
                }
            ],
            "npcs": [
                {
                    "name": "Martha",
                    "description": "The wary innkeeper of the Salt & Anchor Inn.",
                    "secret": "She suspects the keeper but is too afraid to say so.",
                    "role": "innkeeper",
                },
                {
                    "name": "Elias Crane",
                    "description": "The rarely-seen lighthouse keeper.",
                    "secret": f"{SENTINEL}. Elias Crane drowned two years ago; a Deep One thrall now wears his face.",
                    "role": "antagonist",
                },
            ],
            "clues": [
                {
                    "name": "Human teeth in the lens",
                    "description": "The lighthouse lamp's lens is packed with human teeth.",
                    "location": "Lighthouse lamp room",
                    "leads_to": "the truth about the keeper",
                }
            ],
            "timeline": [
                {"time": "Night 1", "event": "The lighthouse light shifts to a sickly green.", "involved": ["Elias Crane"]}
            ],
            "background": "Blackmoor village has lost three sailors this month under mysterious circumstances.",
            "threats": [
                {
                    "name": "Deep One thrall \"Elias\"",
                    "type": "monster",
                    "description": "A dripping, misshapen figure in a keeper's coat.",
                    "stats": {"HP": "13", "STR": "80", "CON": "70", "DEX": "55", "SIZ": "65"},
                    "attacks": ["claw 1d6+db"],
                    "san_loss": "1/1D8",
                    "special_abilities": "drag underwater",
                    "location": "Lighthouse",
                }
            ],
            "truths": [
                {
                    "name": "The keeper's fate",
                    "description": f"{SENTINEL}: Elias Crane is dead and a Deep One thrall wears his face.",
                    "revealed_by": "searching the lamp room and confronting the thrall",
                }
            ],
            "opening_facts": ["Three sailors have vanished this month.", "The lighthouse still burns every night."],
            "summary": "Investigators must uncover why sailors are vanishing near the Blackmoor lighthouse.",
        }
    )


class _RecordingLLM:
    """Minimal `LLMClient` double that records every `chat()` kwarg (unlike
    `infra.llm.FakeLLM`, which only records `messages`/`tools`) — used to
    assert on `temperature`/`model` selection and on the rendered prompt."""

    def __init__(self, result: ChatResult) -> None:
        self._result = result
        self.kwargs: dict[str, Any] | None = None

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        self.kwargs = {"messages": messages, "tools": tools, "tool_choice": tool_choice, "temperature": temperature, "model": model}
        return self._result


class _FakeVectorDb:
    """Minimal `list_all_chunks` double (duck-typed like
    `core.document_manager.VectorDatabaseManager`) for the chunk-reassembly
    fallback read path."""

    def __init__(self, chunks: list[dict]) -> None:
        self._chunks = chunks

    async def list_all_chunks(self, chat_key: str, limit: int = 1000) -> list[dict]:
        return [c for c in self._chunks if c.get("chat_key") == chat_key][:limit]


def _make_initializer(
    *, llm=None, vector_db=None, store=None, settings=None, locale="en", battles=None
) -> ModuleInitializer:
    return ModuleInitializer(
        store=store,
        vector_db=vector_db,
        llm=llm,
        settings=settings or Settings(),
        i18n=I18n(locale=locale),
        battles=battles,
    )


# ---------------------------------------------------------------------------
# initialize() — the two scenarios required by the M1 spec
# ---------------------------------------------------------------------------


async def test_initialize_llm_analysis_keeper_pool_has_secret_player_pool_does_not():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat1", value=MODULE_EN_TEXT)
    llm = FakeLLM(script=[assistant_text(_scripted_analysis_json())])
    mi = _make_initializer(llm=llm, store=store)

    await mi.initialize("chat1")

    assert await store.get(user_key="", store_key="module_init_status.chat1") == "ready"

    keeper_raw = await store.get(user_key="", store_key="module_keeper_pool.chat1")
    player_raw = await store.get(user_key="", store_key="module_player_pool.chat1")

    # Red-line leak assertion on the raw persisted JSON text, not just the
    # parsed structure — the sentinel must appear nowhere in what a player
    # pool consumer could ever read.
    assert SENTINEL in keeper_raw
    assert SENTINEL not in player_raw

    keeper = json.loads(keeper_raw)
    player = json.loads(player_raw)

    assert keeper["npcs"][1]["secret"].startswith(SENTINEL)
    assert keeper["truths"][0]["description"].startswith(SENTINEL)

    # player pool is structurally redacted, not just string-clean.
    assert all("secret" not in npc for npc in player["npcs"])
    assert all("keeper_notes" not in scene for scene in player["scenes"])
    assert "truths" not in player
    assert "threats" not in player
    assert "timeline" not in player
    assert player["clues"] == []  # unlocked incrementally elsewhere, not seeded


async def test_initialize_falls_back_to_offline_heuristic_on_unparsable_llm_response():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat2", value=MODULE_EN_TEXT)
    llm = FakeLLM(
        script=[
            assistant_text("Sorry, I can't help with that today!"),
            assistant_text("Still no structured analysis."),
        ]
    )
    mi = _make_initializer(llm=llm, store=store)

    await mi.initialize("chat2")

    assert len(llm.calls) == 2
    assert await store.get(user_key="", store_key="module_init_status.chat2") == "ready_fallback"
    assert await store.get(user_key="", store_key="module_init_error.chat2")

    keeper = json.loads(await store.get(user_key="", store_key="module_keeper_pool.chat2"))
    player = json.loads(await store.get(user_key="", store_key="module_player_pool.chat2"))

    assert len(keeper["scenes"]) > 0
    assert keeper["scenes"][0]["name"] == "场景1"  # source's literal fallback default, ported verbatim
    assert keeper["scenes"][0]["focus"] == "探索"
    assert len(player["scenes"]) == len(keeper["scenes"])
    assert player["background"] == keeper["background"]


async def test_initialize_retries_analysis_once_and_marks_retry_success_ready():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat-retry", value=MODULE_EN_TEXT)
    await store.set(user_key="", store_key="module_init_error.chat-retry", value="stale failure")
    llm = FakeLLM(script=[assistant_text("not json"), assistant_text(_scripted_analysis_json())])
    mi = _make_initializer(llm=llm, store=store)

    await mi.initialize("chat-retry")

    assert len(llm.calls) == 2
    assert await store.get(user_key="", store_key="module_init_status.chat-retry") == "ready"
    assert await store.get(user_key="", store_key="module_init_error.chat-retry") is None


async def test_initialize_records_analysis_usage_for_room():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat-usage", value=MODULE_EN_TEXT)
    settings = Settings(llm=LLMSettings(chat_model="deepseek-chat", analysis_model="gemini-2.5-pro"))
    llm = FakeLLM(
        script=[
            ChatResult(
                content=_scripted_analysis_json(),
                tool_calls=[],
                usage=Usage(
                    prompt_tokens=120,
                    completion_tokens=30,
                    total_tokens=150,
                    cache_hit_tokens=20,
                    cache_miss_tokens=100,
                ),
            )
        ]
    )
    mi = _make_initializer(llm=llm, store=store, settings=settings)

    await mi.initialize("chat-usage")

    stats = json.loads(await store.get(user_key="", store_key="usage_stats.chat-usage"))
    assert stats["last"] == {
        "prompt": 120,
        "completion": 30,
        "cache_hit": 20,
        "cache_miss": 100,
        "context_window": context_window_for("gemini-2.5-pro"),
    }
    assert stats["session"] == {
        "prompt": 120,
        "completion": 30,
        "cache_hit": 20,
        "cache_miss": 100,
        "turns": 1,
    }


async def test_initialize_replaces_stale_catalog_and_resets_game_clock():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat-state", value=MODULE_EN_TEXT)
    await store.set(user_key="", store_key="module_catalog.chat-state", value=json.dumps({"summary": "OLD MODULE"}))
    await store.set(user_key="", store_key="game_clock.chat-state", value=json.dumps({"current_time": "1926-03-15"}))
    llm = FakeLLM(script=[assistant_text(_scripted_analysis_json())])
    mi = _make_initializer(llm=llm, store=store)

    await mi.initialize("chat-state")

    keeper_raw = await store.get(user_key="", store_key="module_keeper_pool.chat-state")
    assert await store.get(user_key="", store_key="module_catalog.chat-state") == keeper_raw
    assert "OLD MODULE" not in keeper_raw
    assert await store.get(user_key="", store_key="game_clock.chat-state") is None


async def test_initialize_archives_the_running_session_before_switching_module():
    store = Store()
    battles = BattleReportManager(store)
    chat_key = "chat-module-switch"
    session_id = await battles.start_session(chat_key, "Old Module")
    await battles.add_key_event(chat_key, "Event from the old module")
    await store.set(user_key="", store_key=f"module_fulltext.{chat_key}", value=MODULE_EN_TEXT)
    initializer = _make_initializer(
        llm=FakeLLM(script=[assistant_text(_scripted_analysis_json())]),
        store=store,
        battles=battles,
    )

    await initializer.initialize(chat_key)

    assert await battles.generator.get_current_session(chat_key) is None
    archived_raw = await store.get(store_key=f"session_history.{chat_key}.{session_id}")
    assert archived_raw is not None
    assert json.loads(archived_raw)["key_events"][0]["description"] == "Event from the old module"


# ---------------------------------------------------------------------------
# initialize() — orchestration edge cases
# ---------------------------------------------------------------------------


async def test_initialize_is_a_noop_while_already_processing():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat3", value=MODULE_EN_TEXT)
    await store.set(user_key="", store_key="module_init_status.chat3", value="processing")
    llm = FakeLLM()  # unconfigured: chat() would raise if it were ever called
    mi = _make_initializer(llm=llm, store=store)

    await mi.initialize("chat3")

    assert await store.get(user_key="", store_key="module_init_status.chat3") == "processing"
    assert llm.calls == []


async def test_initialize_marks_failed_when_no_module_text_is_available():
    store = Store()
    llm = FakeLLM()  # unconfigured: proves the LLM is never reached
    mi = _make_initializer(llm=llm, store=store, vector_db=None)

    await mi.initialize("chat-empty")

    assert await store.get(user_key="", store_key="module_init_status.chat-empty") == "failed"
    assert await store.get(user_key="", store_key="module_keeper_pool.chat-empty") is None
    assert await store.get(user_key="", store_key="module_player_pool.chat-empty") is None
    assert llm.calls == []


async def test_initialize_falls_back_to_vector_db_chunks_when_no_fulltext_stored():
    store = Store()
    chunks = [
        {"chat_key": "chat4", "filename": "module.txt", "chunk_index": 1, "text": "second half"},
        {"chat_key": "chat4", "filename": "module.txt", "chunk_index": 0, "text": "first half"},
        {"chat_key": "other-chat", "filename": "module.txt", "chunk_index": 0, "text": "unrelated"},
    ]
    llm = FakeLLM(script=[assistant_text("{}")])
    mi = _make_initializer(llm=llm, store=store, vector_db=_FakeVectorDb(chunks))

    await mi.initialize("chat4")

    assert await store.get(user_key="", store_key="module_init_status.chat4") == "ready"
    sent_prompt = llm.calls[0][0][0]["content"]
    assert "first half" in sent_prompt
    assert "second half" in sent_prompt
    assert sent_prompt.index("first half") < sent_prompt.index("second half")  # chunk_index order
    assert "unrelated" not in sent_prompt  # scoped to chat4 only


# ---------------------------------------------------------------------------
# _analyze_full_text — temperature/model selection, prompt localization
# ---------------------------------------------------------------------------


async def test_analyze_full_text_uses_temperature_0_3_and_prefers_analysis_model():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat5", value=MODULE_EN_TEXT)
    settings = Settings(llm=LLMSettings(chat_model="gpt-4o-mini", analysis_model="big-context-model"))
    llm = _RecordingLLM(assistant_text("{}"))
    mi = _make_initializer(llm=llm, store=store, settings=settings)

    await mi.initialize("chat5")

    assert llm.kwargs["temperature"] == 0.3
    assert llm.kwargs["model"] == "big-context-model"


async def test_analyze_full_text_falls_back_to_chat_model_when_analysis_model_unset():
    store = Store()
    await store.set(user_key="", store_key="module_fulltext.chat6", value=MODULE_EN_TEXT)
    settings = Settings(llm=LLMSettings(chat_model="gpt-4o-mini"))  # analysis_model defaults to ""
    llm = _RecordingLLM(assistant_text("{}"))
    mi = _make_initializer(llm=llm, store=store, settings=settings)

    await mi.initialize("chat6")

    assert llm.kwargs["model"] == "gpt-4o-mini"


async def test_analysis_prompt_is_localized_and_always_embeds_the_fixed_schema():
    store_en = Store()
    await store_en.set(user_key="", store_key="module_fulltext.chat7", value=MODULE_EN_TEXT)
    llm_en = _RecordingLLM(assistant_text("{}"))
    await _make_initializer(llm=llm_en, store=store_en, locale="en").initialize("chat7")

    store_zh = Store()
    await store_zh.set(user_key="", store_key="module_fulltext.chat8", value=MODULE_EN_TEXT)
    llm_zh = _RecordingLLM(assistant_text("{}"))
    await _make_initializer(llm=llm_zh, store=store_zh, locale="zh").initialize("chat8")

    prompt_en = llm_en.kwargs["messages"][0]["content"]
    prompt_zh = llm_zh.kwargs["messages"][0]["content"]

    assert prompt_en != prompt_zh  # framing text differs per locale
    assert "professional TRPG module analysis expert" in prompt_en
    assert "TRPG 模组解析专家" in prompt_zh

    # the module's full text is embedded verbatim in both...
    assert MODULE_EN_TEXT in prompt_en
    assert MODULE_EN_TEXT in prompt_zh
    # ...and the JSON schema contract is fixed regardless of locale.
    assert '"scenes"' in prompt_en and '"scenes"' in prompt_zh
    assert '"opening_facts"' in prompt_en and '"opening_facts"' in prompt_zh


# ---------------------------------------------------------------------------
# _build_knowledge_pools — direct unit coverage of the keeper/player split
# ---------------------------------------------------------------------------


def test_build_knowledge_pools_keeps_full_secrets_in_keeper_and_redacts_player():
    mi = _make_initializer()
    analysis = {
        "scenes": [
            {
                "name": "Inn",
                "focus": "explore",
                "description": "A tavern.",
                "keeper_notes": "trap door under the bar",
                "npcs_present": ["Martha"],
                "clues": [{"name": "map", "description": "old map", "discovery_method": "search", "extra": "kept off player copy"}],
            }
        ],
        "npcs": [{"name": "Elias", "description": "keeper", "secret": SENTINEL, "role": "antagonist"}],
        "clues": [{"name": "global clue", "description": "module-wide catalog entry"}],
        "timeline": [{"time": "night 1", "event": "e", "involved": []}],
        "background": "bg",
        "threats": [{"name": "thrall", "type": "monster"}],
        "truths": [{"name": "truth", "description": SENTINEL, "revealed_by": "r"}],
        "summary": "sum",
    }

    keeper, player = mi._build_knowledge_pools(analysis)

    assert keeper["npcs"][0]["secret"] == SENTINEL
    assert "secret" not in player["npcs"][0]
    assert keeper["scenes"][0]["keeper_notes"] == "trap door under the bar"
    assert "keeper_notes" not in player["scenes"][0]
    assert "truths" not in player
    assert "threats" not in player
    assert "timeline" not in player
    assert player["clues"] == []  # top-level player clues stay empty; unlocked incrementally elsewhere
    assert keeper["clues"] == analysis["clues"]
    assert keeper["threats"] == analysis["threats"]
    assert player["scenes"][0]["clues"] == [{"name": "map", "description": "old map", "discovery_method": "search"}]
    assert player["background"] == "bg"
    assert player["summary"] == "sum"


def test_build_knowledge_pools_handles_missing_optional_fields_with_defaults():
    mi = _make_initializer()
    keeper, player = mi._build_knowledge_pools({"scenes": [{}], "npcs": [{}]})

    assert player["scenes"][0] == {"name": "", "focus": "探索", "description": "", "npcs_present": [], "clues": []}
    assert player["npcs"][0] == {"name": "", "description": "", "role": ""}
    assert keeper["background"] == ""
    assert keeper["summary"] == ""


# ---------------------------------------------------------------------------
# _fallback_full_analysis — direct unit coverage of the offline heuristic
# ---------------------------------------------------------------------------


def test_fallback_full_analysis_chunks_paragraphs_with_source_default_literals():
    mi = _make_initializer()
    text = ("A" * 60) + "\n\n" + ("B" * 60) + "\n\n" + "short"

    analysis = mi._fallback_full_analysis(text)

    assert [s["name"] for s in analysis["scenes"]] == ["场景1", "场景2"]  # short paragraph (<=50 chars) excluded
    assert all(s["focus"] == "探索" for s in analysis["scenes"])
    assert analysis["scenes"][0]["description"] == "A" * 60
    assert analysis["scenes"][0]["keeper_notes"] == ""
    assert analysis["npcs"] == []
    assert analysis["clues"] == []
    assert analysis["threats"] == []
    assert analysis["truths"] == []
    assert analysis["background"] == text  # under 500 chars: kept whole
    assert analysis["summary"] == text[:100]


def test_fallback_full_analysis_truncates_long_background_and_summary():
    mi = _make_initializer()
    text = "X" * 1000

    analysis = mi._fallback_full_analysis(text)

    assert analysis["background"] == "X" * 500
    assert analysis["summary"] == "X" * 100
    # no "\n\n" paragraph breaks at all: the whole text is one paragraph/scene.
    assert len(analysis["scenes"]) == 1
    assert analysis["scenes"][0]["description"] == "X" * 200


def test_fallback_full_analysis_caps_at_twenty_scenes():
    mi = _make_initializer()
    text = "\n\n".join(f"paragraph number {i} padded to be long enough to count".ljust(60, ".") for i in range(30))

    analysis = mi._fallback_full_analysis(text)

    assert len(analysis["scenes"]) == 20
