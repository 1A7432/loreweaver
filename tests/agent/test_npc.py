"""Tests for `agent.npc` (`NpcRecord`/`NpcManager`), `agent.npc_actor.voice_npc`, and
`agent.kp_tools_npc.NpcTools` -- the M5 AI-played, knowledge-scoped NPC sub-actor feature
(`docs/specs/M5.md`).

The signature test in this file (`test_voice_npc_never_leaks_keeper_secrets_or_other_npcs_knowledge`)
is the red line the whole feature exists to prove: it mirrors the same sentinel-never-leaks pattern
`tests/agent/test_kp_tools_knowledge.py` and `tests/core/test_module.py` use for the keeper/player
pool split, one level down -- an NPC sub-actor must not see anything beyond its OWN `NpcRecord`, not
even other NPCs' secrets or the module keeper pool.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_npc import NpcTools
from agent.npc import NpcManager, NpcRecord
from agent.npc_actor import voice_npc
from agent.services import build_services
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text
from infra.store import Store

CHAT_KEY = "lighthouse-chat"
SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"


def _ctx(chat_key: str = CHAT_KEY, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale=locale)


class _ModelRecordingLLM:
    """Minimal `LLMClient`-protocol stand-in (structural typing -- see `infra.llm`'s module
    docstring: "anything exposing a matching async chat() satisfies it structurally"). Records the
    `model` each `chat()` call receives. `infra.llm.FakeLLM.calls` deliberately only tracks
    `(messages, tools)`, not `model`/`temperature`, so this repo-local stand-in exists purely to make
    the model-selection assertion below possible without modifying `infra.llm` itself (out of scope
    for this spec's additive edits).
    """

    def __init__(self, content: str) -> None:
        self._content = content
        self.models: list[str | None] = []

    async def chat(self, messages, *, tools=None, tool_choice=None, temperature=None, model=None):
        self.models.append(model)
        return ChatResult(content=self._content, tool_calls=[])


# ---------------------------------------------------------------------------
# agent.npc: NpcRecord (de)serialization
# ---------------------------------------------------------------------------


def test_npc_record_to_dict_from_dict_round_trip():
    original = NpcRecord(
        id="martha-higgins",
        name="Martha Higgins",
        persona="The wary innkeeper.",
        style="clipped, suspicious",
        public_description="A weathered woman who watches the door.",
        secret_agenda="She suspects the keeper but is too afraid to say so.",
        knowledge=["Sailors have been vanishing.", "The light changed color."],
        disposition="wary",
        relationships={"Elias Crane": "distrusts"},
        location="The Salt & Anchor Inn",
        status="on edge",
        stat_char="Martha Higgins (NPC)",
        major=False,
    )

    restored = NpcRecord.from_dict(original.to_dict())

    assert restored == original


# ---------------------------------------------------------------------------
# agent.npc: NpcManager CRUD, round-trip, and persistence via Store(":memory:")
# ---------------------------------------------------------------------------


async def test_create_npc_then_get_npc_round_trip():
    manager = NpcManager(Store(":memory:"))

    created = await manager.create_npc(
        CHAT_KEY,
        "Martha Higgins",
        persona="The wary innkeeper of the Salt & Anchor Inn.",
        public_description="A weathered woman who watches the door.",
        secret_agenda="She suspects the keeper but is too afraid to say so.",
        knowledge=["Sailors have been vanishing.", "The lighthouse light changed color."],
        disposition="wary",
        location="The Salt & Anchor Inn",
        major=True,
    )

    assert created.id == "martha-higgins"

    by_id = await manager.get_npc(CHAT_KEY, "martha-higgins")
    by_exact_name = await manager.get_npc(CHAT_KEY, "Martha Higgins")
    by_fuzzy_name = await manager.get_npc(CHAT_KEY, "martha")

    for fetched in (by_id, by_exact_name, by_fuzzy_name):
        assert fetched is not None
        assert fetched.name == "Martha Higgins"
        assert fetched.secret_agenda == "She suspects the keeper but is too afraid to say so."
        assert fetched.knowledge == ["Sailors have been vanishing.", "The lighthouse light changed color."]
        assert fetched.major is True

    assert await manager.get_npc(CHAT_KEY, "nobody-here") is None


async def test_create_npc_id_collision_is_suffixed():
    manager = NpcManager(Store(":memory:"))

    first = await manager.create_npc(CHAT_KEY, "Bob")
    second = await manager.create_npc(CHAT_KEY, "Bob")

    assert first.id == "bob"
    assert second.id == "bob-2"
    assert {npc.id for npc in await manager.list_npcs(CHAT_KEY)} == {"bob", "bob-2"}


async def test_create_npc_with_no_alnum_name_falls_back_to_npc_slug():
    manager = NpcManager(Store(":memory:"))

    record = await manager.create_npc(CHAT_KEY, "!!!")

    assert record.id == "npc"


async def test_create_npc_role_becomes_persona_hint_only_when_persona_unset():
    manager = NpcManager(Store(":memory:"))

    with_role_only = await manager.create_npc(CHAT_KEY, "Elias Crane", role="antagonist")
    with_persona = await manager.create_npc(CHAT_KEY, "Martha", persona="The innkeeper.", role="innkeeper")

    assert with_role_only.persona == "antagonist"
    assert with_persona.persona == "The innkeeper."  # explicit persona wins over the role hint


async def test_list_update_move_disposition_learns_persist_across_manager_instances():
    """The M5 spec's persistence self-test: writes via one `NpcManager` must be visible to a
    freshly-constructed `NpcManager` bound to the SAME `Store`, proving they round-tripped through
    the store rather than only mutating an in-memory dataclass instance."""
    store = Store(":memory:")
    writer = NpcManager(store)

    await writer.create_npc(CHAT_KEY, "Martha", location="Inn", disposition="wary", knowledge=["Sailors vanish."])
    await writer.create_npc(CHAT_KEY, "Elias Crane", major=True)

    reader = NpcManager(store)
    listed = await reader.list_npcs(CHAT_KEY)
    assert {npc.name for npc in listed} == {"Martha", "Elias Crane"}

    updated = await reader.update_npc(CHAT_KEY, "Martha", style="clipped, suspicious")
    assert updated is not None
    assert updated.style == "clipped, suspicious"

    moved = await reader.move_npc(CHAT_KEY, "Martha", "The docks")
    assert moved.location == "The docks"

    disposed = await reader.set_disposition(CHAT_KEY, "Martha", "hostile")
    assert disposed.disposition == "hostile"

    learned = await reader.npc_learns(CHAT_KEY, "Martha", "A stranger asked about the keeper.")
    assert learned.knowledge == ["Sailors vanish.", "A stranger asked about the keeper."]

    # a THIRD manager instance, to make sure every mutation above genuinely round-tripped
    verifier = NpcManager(store)
    final = await verifier.get_npc(CHAT_KEY, "Martha")
    assert final is not None
    assert final.style == "clipped, suspicious"
    assert final.location == "The docks"
    assert final.disposition == "hostile"
    assert final.knowledge == ["Sailors vanish.", "A stranger asked about the keeper."]

    assert await verifier.delete_npc(CHAT_KEY, "Elias Crane") is True
    assert await verifier.get_npc(CHAT_KEY, "Elias Crane") is None
    assert [npc.name for npc in await verifier.list_npcs(CHAT_KEY)] == ["Martha"]
    assert await verifier.delete_npc(CHAT_KEY, "Elias Crane") is False  # already gone


async def test_add_knowledge_replace_mode_overwrites_add_mode_appends():
    manager = NpcManager(Store(":memory:"))
    await manager.create_npc(CHAT_KEY, "Martha", knowledge=["fact one"])

    appended = await manager.add_knowledge(CHAT_KEY, "Martha", ["fact two"], mode="add")
    assert appended.knowledge == ["fact one", "fact two"]

    replaced = await manager.add_knowledge(CHAT_KEY, "Martha", ["only this now"], mode="replace")
    assert replaced.knowledge == ["only this now"]


async def test_unknown_npc_mutations_return_none_or_false_not_raise():
    manager = NpcManager(Store(":memory:"))

    assert await manager.update_npc(CHAT_KEY, "nobody", location="x") is None
    assert await manager.move_npc(CHAT_KEY, "nobody", "x") is None
    assert await manager.set_disposition(CHAT_KEY, "nobody", "x") is None
    assert await manager.npc_learns(CHAT_KEY, "nobody", "x") is None
    assert await manager.add_knowledge(CHAT_KEY, "nobody", ["x"]) is None
    assert await manager.delete_npc(CHAT_KEY, "nobody") is False


# ---------------------------------------------------------------------------
# agent.npc_actor.voice_npc -- the information-isolation signature test (the red line)
# ---------------------------------------------------------------------------


async def test_voice_npc_never_leaks_keeper_secrets_or_other_npcs_knowledge():
    chat_key = "lighthouse-room"
    store = Store(":memory:")
    npcs = NpcManager(store)

    # The module keeper pool holds the sentinel world-truth.
    await store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps(
            {"npcs": [{"name": "Elias Crane", "description": "The keeper.", "secret": SENTINEL, "role": "antagonist"}]}
        ),
    )
    # A DIFFERENT NPC's own knowledge also holds the sentinel.
    await npcs.create_npc(
        chat_key,
        "Elias Crane",
        secret_agenda=SENTINEL,
        knowledge=[SENTINEL, "The light still burns every night."],
    )
    # The NPC under test knows nothing of any of that.
    martha = await npcs.create_npc(
        chat_key,
        "Martha",
        persona="The wary innkeeper of the Salt & Anchor Inn.",
        secret_agenda="She is afraid of the keeper but does not know why.",
        knowledge=["Three sailors have vanished this month.", "The lighthouse light changed color recently."],
        disposition="wary",
    )

    recorded_messages: list[list[dict]] = []

    def responder(messages, tools):
        recorded_messages.append(messages)
        return assistant_text(json.dumps({"dialogue": "Please, just leave.", "action_intent": "back away", "mood": "afraid"}))

    services = build_services(Settings(), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8))

    result = await voice_npc(
        services,
        martha,
        "A stranger walks in asking pointed questions about the lighthouse.",
        recent=["The stranger ordered a drink and studied the room."],
    )

    assert result == {"dialogue": "Please, just leave.", "action_intent": "back away", "mood": "afraid"}

    assert len(recorded_messages) == 1
    messages = recorded_messages[0]
    assert messages[0]["role"] == "system"
    assert messages[1]["role"] == "user"
    system_content = messages[0]["content"]
    user_content = messages[1]["content"]

    # the red line: the sentinel appears NOWHERE in what the actor was given
    assert SENTINEL not in system_content
    assert SENTINEL not in user_content
    # nor does the other NPC's identity -- Martha's prompt is built from ONLY her own record
    assert "Elias Crane" not in system_content
    assert "Elias Crane" not in user_content

    # positive control: Martha's OWN persona/knowledge, and the situation/recent hints, DID make it in
    assert "wary innkeeper" in system_content
    assert "Three sailors have vanished this month." in system_content
    assert "The lighthouse light changed color recently." in system_content
    assert "A stranger walks in asking pointed questions about the lighthouse." in user_content
    assert "The stranger ordered a drink and studied the room." in user_content


async def test_voice_npc_parses_fenced_json_and_falls_back_to_raw_content_on_unparsable_reply():
    fenced = "```json\n" + json.dumps({"dialogue": "Get out.", "action_intent": "point at the door", "mood": "furious"}) + "\n```"
    llm = FakeLLM(script=[assistant_text(fenced), assistant_text("just talking, no json here")])
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(8))
    npc = NpcRecord(id="guard", name="Guard")

    fenced_result = await voice_npc(services, npc, "A stranger tries to push past.")
    assert fenced_result == {"dialogue": "Get out.", "action_intent": "point at the door", "mood": "furious"}

    fallback_result = await voice_npc(services, npc, "A stranger tries to push past again.")
    assert fallback_result == {"dialogue": "just talking, no json here", "action_intent": "", "mood": ""}


async def test_voice_npc_uses_configured_npc_model_over_chat_model():
    settings = Settings(llm=LLMSettings(chat_model="chat-default", npc_model="npc-special"))
    recording_llm = _ModelRecordingLLM(json.dumps({"dialogue": "Hello.", "action_intent": "", "mood": "calm"}))
    services = build_services(settings, llm=recording_llm, embeddings=FakeEmbeddings(8))

    await voice_npc(services, NpcRecord(id="npc-1", name="Test NPC"), "Someone greets them.")

    assert recording_llm.models == ["npc-special"]


async def test_voice_npc_falls_back_to_chat_model_when_npc_model_unset():
    settings = Settings(llm=LLMSettings(chat_model="chat-default", npc_model=""))
    recording_llm = _ModelRecordingLLM(json.dumps({"dialogue": "Hello.", "action_intent": "", "mood": "calm"}))
    services = build_services(settings, llm=recording_llm, embeddings=FakeEmbeddings(8))

    await voice_npc(services, NpcRecord(id="npc-1", name="Test NPC"), "Someone greets them.")

    assert recording_llm.models == ["chat-default"]


# ---------------------------------------------------------------------------
# agent.kp_tools_npc.NpcTools -- speak_as_npc, import_module_npcs, CRUD tools, keeper-only views
# ---------------------------------------------------------------------------


async def test_speak_as_npc_weaves_dialogue_logs_event_and_excludes_keeper_secret():
    chat_key = "speak-room"
    keeper_secret = "The mayor is secretly funding the cult."
    llm = FakeLLM(
        script=[assistant_text(json.dumps({"dialogue": "I've heard nothing of the sort.", "action_intent": "shrug and turn away", "mood": "evasive"}))]
    )
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(8))
    await services.store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps({"npcs": [{"name": "The Mayor", "description": "...", "secret": keeper_secret, "role": "antagonist"}]}),
    )
    await services.battles.start_session(chat_key)

    tools = NpcTools(services)
    ctx = _ctx(chat_key)
    await tools.create_npc(ctx, name="Old Tomas", persona="A gossiping dockhand.", knowledge="Ships come in on Tuesdays.")

    line = await tools.speak_as_npc(ctx, npc="Old Tomas", situation="A stranger asks Tomas if he knows anything odd about the mayor.")

    assert "I've heard nothing of the sort." in line
    assert "evasive" in line
    assert "shrug and turn away" in line
    assert keeper_secret not in line

    current = await services.battles.generator.get_current_session(chat_key)
    assert current is not None
    assert any("Old Tomas" in event["description"] for event in current.key_events)
    assert all(keeper_secret not in event["description"] for event in current.key_events)


async def test_speak_as_npc_reports_not_found_for_unknown_npc():
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    tools = NpcTools(services)
    ctx = _ctx("empty-room")

    result = await tools.speak_as_npc(ctx, npc="Ghost", situation="...")

    assert result == services.i18n.with_locale("en").t("npc.tools.not_found", npc="Ghost")


async def test_import_module_npcs_seeds_from_module_keeper_pool_and_skips_existing():
    chat_key = "import-room"
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    tools = NpcTools(services)
    ctx = _ctx(chat_key)

    await tools.create_npc(ctx, name="Martha")  # pre-existing -- import must not duplicate this one

    await services.store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps(
            {
                "npcs": [
                    {"name": "Martha", "description": "innkeeper", "secret": "she knows more than she lets on", "role": "innkeeper"},
                    {"name": "Elias Crane", "description": "the keeper", "secret": SENTINEL, "role": "antagonist"},
                ]
            }
        ),
    )

    result = await tools.import_module_npcs(ctx)
    assert "Elias Crane" in result

    npcs = NpcManager(services.store)
    elias = await npcs.get_npc(chat_key, "Elias Crane")
    assert elias is not None
    assert elias.secret_agenda == SENTINEL
    assert elias.public_description == "the keeper"
    assert elias.persona == "antagonist"  # role -> persona hint, since no persona was given

    martha = await npcs.get_npc(chat_key, "Martha")
    assert martha is not None
    assert martha.secret_agenda == ""  # untouched: the pre-existing NPC was skipped, not overwritten

    listed_names = sorted(npc.name for npc in await npcs.list_npcs(chat_key))
    assert listed_names == ["Elias Crane", "Martha"]  # no duplicate "martha-2" from a failed skip


async def test_import_module_npcs_without_a_pool_reports_missing_pool():
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    tools = NpcTools(services)
    ctx = _ctx("no-pool-room")

    result = await tools.import_module_npcs(ctx)

    assert result == services.i18n.with_locale("en").t("npc.tools.import.no_pool")


async def test_npc_tools_end_to_end_crud_and_keeper_only_views():
    chat_key = "crud-room"
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    tools = NpcTools(services)
    ctx = _ctx(chat_key)

    create_result = await tools.create_npc(
        ctx,
        name="Old Tomas",
        persona="A gossiping dockhand.",
        description="A weathered old sailor.",
        secret_agenda="He owes money to the wrong people.",
        knowledge="Ships come in on Tuesdays.\nThe harbor master is corrupt.",
        disposition="friendly",
        location="The docks",
        major=True,
    )
    assert "Old Tomas" in create_result

    knowledge_result = await tools.set_npc_knowledge(ctx, npc="Old Tomas", facts="A new fact, another new fact", mode="add")
    assert "Old Tomas" in knowledge_result

    learn_result = await tools.npc_learns(ctx, npc="Old Tomas", fact="Someone was asking about the mayor.")
    assert "Someone was asking about the mayor." in learn_result

    disposition_result = await tools.set_npc_disposition(ctx, npc="Old Tomas", disposition="suspicious")
    assert "suspicious" in disposition_result

    move_result = await tools.move_npc(ctx, npc="Old Tomas", location="The tavern")
    assert "The tavern" in move_result

    update_result = await tools.update_npc(ctx, npc="Old Tomas", field="status", value="drunk")
    assert "drunk" in update_result

    bad_field_result = await tools.update_npc(ctx, npc="Old Tomas", field="knowledge", value="nope")
    assert "knowledge" in bad_field_result

    i18n_en = services.i18n.with_locale("en")

    detail = await tools.get_npc(ctx, npc="Old Tomas")
    assert i18n_en.t("npc.tools.keeper_banner") in detail
    assert "He owes money to the wrong people." in detail
    assert "Someone was asking about the mayor." in detail
    assert "The tavern" in detail
    assert "suspicious" in detail
    assert "drunk" in detail

    roster = await tools.list_npcs(ctx)
    assert i18n_en.t("npc.tools.keeper_banner") in roster
    assert "Old Tomas" in roster

    not_found = await tools.get_npc(ctx, npc="Nobody")
    assert not_found == i18n_en.t("npc.tools.not_found", npc="Nobody")


def test_get_npc_and_list_npcs_are_keeper_only_in_build_kp_toolset():
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    toolset = build_kp_toolset(services)

    assert toolset.is_keeper_only("get_npc") is True
    assert toolset.is_keeper_only("list_npcs") is True

    non_keeper_tools = (
        "create_npc",
        "import_module_npcs",
        "set_npc_knowledge",
        "npc_learns",
        "set_npc_disposition",
        "move_npc",
        "update_npc",
        "speak_as_npc",
    )
    for name in non_keeper_tools:
        assert name in toolset.names()
        assert toolset.is_keeper_only(name) is False, name

    # locked decision (docs/specs/M5.md): no separate options tool
    assert "npc_action_options" not in toolset.names()
