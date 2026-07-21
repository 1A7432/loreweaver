"""Tests for agent.kp_tools_knowledge: the knowledge-domain AI-KP tools --
module knowledge pools (`ModuleTools`), document ingestion (`DocumentTools`),
KP notes/game clock (`NoteTools`), and session/battle-report recording
(`SessionTools`).

Exercises the M1 spec's (docs/specs/M1.md §6.3) self-test list end-to-end,
reusing the same red-line "sentinel never leaks to the player pool" pattern
as tests/core/test_module.py and the §7 e2e self-play spec: a scripted
`FakeLLM` returns a module analysis whose keeper-only truth contains
"THE LIGHTHOUSE KEEPER IS THE MURDERER" (`tests/fixtures/module_en.txt`'s
sentinel), and every assertion about the player-visible side confirms the
sentinel is absent from it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from agent.context import AgentCtx, LocalFs
from agent.kp_tools_knowledge import DocumentTools, ModuleTools, NoteTools, SessionTools
from agent.services import Services, build_services
from agent.tools import Toolset
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
CHAT_KEY = "lighthouse-chat"
SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"


def _scripted_analysis_json() -> str:
    """A well-formed module-analysis JSON (the shape `module.analysis_prompt` asks the LLM to emit),
    whose keeper-only truth about the lighthouse keeper carries the fixture's sentinel secret -- mirrors
    `tests/core/test_module.py`'s `_scripted_analysis_json` (kept local/self-contained per this repo's
    per-test-file convention).
    """
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
                    "name": 'Deep One thrall "Elias"',
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


def _build_services() -> Services:
    """`build_services` wired fully offline: FakeLLM scripted with one module-analysis response,
    FakeEmbeddings(64) per the M1 spec's self-test instructions."""
    llm = FakeLLM(script=[assistant_text(_scripted_analysis_json())])
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(fs=None, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=CHAT_KEY, user_id="u1", locale=locale, fs=fs)


# ---------------------------------------------------------------------------
# keeper_only flagging -- fast, no LLM/embeddings call ever happens
# ---------------------------------------------------------------------------

_KEEPER_ONLY_MODULE_TOOLS = {
    "get_module_catalog",
    "query_knowledge_pool",
    "inspect_knowledge_pool",
    "list_module_elements",
    "get_module_element_detail",
    "get_module_summary",
    "search_documents",
}
_NON_KEEPER_MODULE_TOOLS = {
    "update_knowledge_pool",
    "unlock_for_player",
    "start_module_initialization",
    "get_module_init_status",
}


def test_module_tools_seven_are_keeper_only_in_a_toolset():
    services = build_services(Settings(), llm=FakeLLM(), embeddings=FakeEmbeddings(8))
    toolset = Toolset(ModuleTools(services))

    assert _KEEPER_ONLY_MODULE_TOOLS | _NON_KEEPER_MODULE_TOOLS <= set(toolset.names())
    assert len(_KEEPER_ONLY_MODULE_TOOLS) == 7

    for name in _KEEPER_ONLY_MODULE_TOOLS:
        assert toolset.is_keeper_only(name) is True, name
    for name in _NON_KEEPER_MODULE_TOOLS:
        assert toolset.is_keeper_only(name) is False, name


async def test_get_supported_file_types_differs_by_locale_and_mentions_txt():
    services = build_services(Settings(), llm=FakeLLM(), embeddings=FakeEmbeddings(8))
    doc_tools = DocumentTools(services)

    en_text = await doc_tools.get_supported_file_types(_ctx(locale="en"))
    zh_text = await doc_tools.get_supported_file_types(_ctx(locale="zh"))

    assert "TXT" in en_text
    assert "TXT" in zh_text
    assert en_text != zh_text


async def test_get_module_init_status_surfaces_degraded_fallback_and_retry_hint():
    services = build_services(Settings(), llm=FakeLLM(), embeddings=FakeEmbeddings(8))
    tools = ModuleTools(services)
    await services.store.set(user_key="", store_key=f"module_init_status.{CHAT_KEY}", value="ready_fallback")
    await services.store.set(user_key="", store_key=f"module_init_error.{CHAT_KEY}", value="provider unavailable")
    await services.store.set(
        user_key="",
        store_key=f"module_keeper_pool.{CHAT_KEY}",
        value=json.dumps({"scenes": [{"name": "Fallback scene"}]}),
    )

    result = await tools.get_module_init_status(_ctx(locale="en"))

    assert "degraded" in result.lower()
    assert "retry" in result.lower()
    assert "provider unavailable" in result


async def test_export_report_tool_saves_player_report_without_ending_session(tmp_path):
    services = build_services(Settings(), llm=FakeLLM(), embeddings=FakeEmbeddings(8))
    session_tools = SessionTools(services)
    ctx = _ctx(fs=LocalFs(base_dir=tmp_path), locale="en")

    await services.battles.start_session(CHAT_KEY, "Export Tool Report")
    await services.battles.add_player_action(CHAT_KEY, "u1", "Nora", "studies the mural")
    await services.battles.add_skill_check(CHAT_KEY, "u1", "Nora", "Occult", 60, 18, "success")

    result = await session_tools.export_report(ctx, detailed=True)

    assert "Session report exported" in result
    assert "detailed log" in result
    assert "Saved to:" in result
    assert "Full Session Log" in result
    assert "studies the mural" in result
    assert await services.battles.generator.get_current_session(CHAT_KEY) is not None
    written = list((tmp_path / "shared").glob("session_report_*.md"))
    assert len(written) == 1
    assert "studies the mural" in written[0].read_text(encoding="utf-8")


async def test_start_session_recording_is_idempotent_and_force_new_archives(tmp_path):
    services = build_services(Settings(), llm=FakeLLM(), embeddings=FakeEmbeddings(8))
    session_tools = SessionTools(services)
    ctx = _ctx(fs=LocalFs(base_dir=tmp_path), locale="en")

    await session_tools.start_session_recording(ctx, session_name="First")
    first = await services.battles.generator.get_current_session(CHAT_KEY)
    assert first is not None
    await services.battles.add_key_event(CHAT_KEY, "kept")
    second_result = await session_tools.start_session_recording(ctx, session_name="Ignored")
    second = await services.battles.generator.get_current_session(CHAT_KEY)

    assert second is not None
    assert second.session_id == first.session_id
    assert second.key_events[0]["description"] == "kept"
    assert "already active" in second_result

    await session_tools.start_session_recording(ctx, session_name="Fresh", force_new=True)
    fresh = await services.battles.generator.get_current_session(CHAT_KEY)
    assert fresh is not None
    assert fresh.session_id != first.session_id
    assert await services.store.get(store_key=f"session_history.{CHAT_KEY}.{first.session_id}") is not None


async def test_add_session_event_reports_when_a_duplicate_is_suppressed(tmp_path):
    services = build_services(Settings(), llm=FakeLLM(), embeddings=FakeEmbeddings(8))
    session_tools = SessionTools(services)
    ctx = _ctx(fs=LocalFs(base_dir=tmp_path), locale="en")
    await session_tools.start_session_recording(ctx, session_name="Dedupe")

    first = await session_tools.add_session_event(ctx, description="The seal breaks.")
    duplicate = await session_tools.add_session_event(ctx, description="The seal breaks.")

    assert first == services.i18n.t(
        "kp_tools.know.session.event_logged",
        description="The seal breaks.",
    )
    assert duplicate == services.i18n.t("kp_tools.know.session.event_duplicate")
    record = await services.battles.generator.get_current_session(CHAT_KEY)
    assert record is not None
    assert [event["description"] for event in record.key_events] == ["The seal breaks."]


# ---------------------------------------------------------------------------
# end-to-end: upload -> summary -> unlock -> notes -> clock -> session report -> delete
# ---------------------------------------------------------------------------


async def test_knowledge_tools_end_to_end(tmp_path):
    services = _build_services()
    module_tools = ModuleTools(services)
    doc_tools = DocumentTools(services)
    note_tools = NoteTools(services)
    session_tools = SessionTools(services)

    ctx = _ctx(fs=LocalFs(base_dir=tmp_path))

    # -- 1. upload_document stores fulltext + triggers init -----------------------------------------
    fixture_path = FIXTURES_DIR / "module_en.txt"
    # get_file confines uploads to the sandbox base_dir, so stage the fixture inside it (a real
    # client uploads a file already in its sandbox, never an arbitrary absolute host path).
    staged = tmp_path / "module_en.txt"
    staged.write_bytes(fixture_path.read_bytes())
    upload_result = await doc_tools.upload_document(ctx, file_path="module_en.txt", doc_type="module")
    assert "❌" not in upload_result

    fulltext = await services.store.get(user_key="", store_key=f"module_fulltext.{CHAT_KEY}")
    assert fulltext == fixture_path.read_text(encoding="utf-8")

    status = await services.store.get(user_key="", store_key=f"module_init_status.{CHAT_KEY}")
    assert status == "ready"

    keeper_raw = await services.store.get(user_key="", store_key=f"module_keeper_pool.{CHAT_KEY}")
    player_raw = await services.store.get(user_key="", store_key=f"module_player_pool.{CHAT_KEY}")
    assert SENTINEL in keeper_raw
    assert SENTINEL not in player_raw  # red line: the sentinel must never reach the player-visible pool

    # -- 2. get_module_summary: keeper banner + sentinel + flagged keeper_only in a Toolset -----------
    toolset = Toolset(module_tools)
    assert toolset.is_keeper_only("get_module_summary") is True

    summary = await module_tools.get_module_summary(ctx)
    assert services.i18n.with_locale("en").t("kp_tools.know.keeper_banner") in summary
    assert SENTINEL in summary

    # dispatching through the Toolset (as the function-calling loop would) must behave identically
    dispatched_summary = await toolset.dispatch("get_module_summary", ctx, {})
    assert dispatched_summary == summary

    # -- 3. unlock_for_player moves an element keeper -> player pool ----------------------------------
    # `module_player_pool` is pre-seeded with a spoiler-free copy of every scene/npc by
    # `ModuleInitializer._build_knowledge_pools` (see core/module_initializer.py); only the
    # module-wide `clues` catalog starts empty, so unlocking a clue is what actually demonstrates a
    # keeper -> player move here.
    player_before = json.loads(await services.store.get(user_key="", store_key=f"module_player_pool.{CHAT_KEY}"))
    assert player_before["clues"] == []

    unlock_result = await module_tools.unlock_for_player(ctx, element_type="clues", name="Human teeth in the lens")
    assert "✅" in unlock_result

    player_after = json.loads(await services.store.get(user_key="", store_key=f"module_player_pool.{CHAT_KEY}"))
    assert any(clue["name"] == "Human teeth in the lens" for clue in player_after["clues"])
    assert SENTINEL not in json.dumps(player_after, ensure_ascii=False)  # still holds for this unlocked clue

    # -- 4. kp_note set/add/list round-trips -----------------------------------------------------------
    set_result = await note_tools.kp_note(ctx, action="set", category="current_scene", content="The Salt & Anchor Inn")
    assert "current_scene" in set_result
    notes_raw = json.loads(await services.store.get(user_key="", store_key=f"kp_notes.{CHAT_KEY}"))
    assert notes_raw["current_scene"] == "The Salt & Anchor Inn"

    add_result = await note_tools.kp_note(ctx, action="add", category="player_actions", content="Investigators search the tavern hearth.")
    assert "player_actions" in add_result
    list_result = await note_tools.kp_note(ctx, action="list", category="player_actions")
    assert "Investigators search the tavern hearth." in list_result

    # -- 5. game_clock advance updates time -------------------------------------------------------------
    await note_tools.game_clock(ctx, action="set", value="1926-03-15 09:00")
    advance_result = await note_tools.game_clock(ctx, action="advance", value="+2 hours")
    assert "1926" in advance_result
    clock_raw = json.loads(await services.store.get(user_key="", store_key=f"game_clock.{CHAT_KEY}"))
    # Advancing preserves the input's format family: an ISO clock stays ISO
    # (see core/game_clock.py -- a zh 年月日 clock would stay 年月日 the same way).
    assert clock_raw["current_time"] == "1926-03-15 11:00"

    # An unparseable delta leaves the clock untouched and reports it instead.
    unparsed = await note_tools.game_clock(ctx, action="advance", value="a little while")
    assert "⚠️" in unparsed
    clock_raw = json.loads(await services.store.get(user_key="", store_key=f"game_clock.{CHAT_KEY}"))
    assert clock_raw["current_time"] == "1926-03-15 11:00"

    # -- 6. start_session_recording + add_session_event + generate_session_report produce a report ------
    await session_tools.start_session_recording(ctx, session_name="Blackmoor One-Shot")
    await session_tools.add_session_event(ctx, description="Investigators found the scratched tide table.", event_type="discovery")
    report = await session_tools.generate_session_report(ctx)

    assert "❌" not in report
    assert "Blackmoor One-Shot" in report
    assert "Investigators found the scratched tide table." in report

    latest = await services.battles.generator.get_latest_history(CHAT_KEY)
    assert latest is not None
    assert latest.key_events[0]["description"] == "Investigators found the scratched tide table."

    # the markdown report is written best-effort to ctx.fs.shared_path, and its content is
    # retrievable via get_battle_report_markdown using the timestamp embedded in the reply
    written = list((tmp_path / "shared").glob("battle_report_*.md"))
    assert len(written) == 1

    match = re.search(r"battle_report_(\d{8}_\d{6})\.md", report)
    assert match is not None
    markdown = await session_tools.get_battle_report_markdown(ctx, timestamp=match.group(1))
    assert "Blackmoor One-Shot" in markdown

    # -- 7. delete_document clears the module pools/catalog/status/fulltext together -------------------
    await services.store.set(user_key="", store_key=f"module_init_error.{CHAT_KEY}", value="old fallback")
    delete_result = await doc_tools.delete_document(ctx, filename="module_en")
    assert "✅" in delete_result

    assert await services.store.get(user_key="", store_key=f"module_init_status.{CHAT_KEY}") == ""
    assert await services.store.get(user_key="", store_key=f"module_keeper_pool.{CHAT_KEY}") == ""
    assert await services.store.get(user_key="", store_key=f"module_fulltext.{CHAT_KEY}") == ""
    assert await services.store.get(user_key="", store_key=f"module_init_error.{CHAT_KEY}") == ""

    status_after_delete = await module_tools.get_module_init_status(ctx)
    assert services.i18n.with_locale("en").t("kp_tools.know.init.status_none") == status_after_delete
