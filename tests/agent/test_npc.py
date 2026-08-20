"""Tests for `agent.npc` (`NpcRecord`/`NpcManager`), `agent.npc_actor.voice_npc`, and
`agent.kp_tools_npc.NpcTools` -- the M5 AI-played, knowledge-scoped NPC sub-actor feature
(`docs/specs/M5-npc.md`).

The signature test in this file (`test_voice_npc_never_leaks_keeper_secrets_or_other_npcs_knowledge`)
is the red line the whole feature exists to prove: it mirrors the same sentinel-never-leaks pattern
`tests/agent/test_kp_tools_knowledge.py` and `tests/core/test_module.py` use for the keeper/player
pool split, one level down -- an NPC sub-actor must not see anything beyond its OWN `NpcRecord`, not
even other NPCs' secrets or the module keeper pool.
"""

from __future__ import annotations

import json

import pytest

from agent import npc as npc_records
from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_npc import NpcTools
from agent.npc import NpcRecord
from agent.npc_actor import voice_npc
from agent.services import build_services
from core.documents import DocumentStore
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

    async def chat(self, messages, *, tools=None, tool_choice=None, temperature=None, model=None, reasoning_effort=None, on_text_delta=None):
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
    manager = DocumentStore(Store(":memory:"))

    created = await npc_records.create_npc(manager,
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

    by_id = await npc_records.get_npc(manager, CHAT_KEY, "martha-higgins")
    by_exact_name = await npc_records.get_npc(manager, CHAT_KEY, "Martha Higgins")
    by_fuzzy_name = await npc_records.get_npc(manager, CHAT_KEY, "martha")

    for fetched in (by_id, by_exact_name, by_fuzzy_name):
        assert fetched is not None
        assert fetched.name == "Martha Higgins"
        assert fetched.secret_agenda == "She suspects the keeper but is too afraid to say so."
        assert fetched.knowledge == ["Sailors have been vanishing.", "The lighthouse light changed color."]
        assert fetched.major is True

    assert await npc_records.get_npc(manager, CHAT_KEY, "nobody-here") is None


async def test_create_npc_id_collision_is_suffixed():
    # DIFFERENT names whose slugs collide get suffixed ids; the SAME name never
    # duplicates (it returns the existing record — see the re-create test below).
    manager = DocumentStore(Store(":memory:"))

    first = await npc_records.create_npc(manager, CHAT_KEY, "Bob!")
    second = await npc_records.create_npc(manager, CHAT_KEY, "Bob?")

    assert first.id == "bob"
    assert second.id == "bob-2"
    assert {npc.id for npc in await npc_records.list_npcs(manager, CHAT_KEY)} == {"bob", "bob-2"}


async def test_create_npc_with_no_alnum_name_falls_back_to_npc_slug():
    manager = DocumentStore(Store(":memory:"))

    record = await npc_records.create_npc(manager, CHAT_KEY, "!!!")

    assert record.id == "npc"


async def test_create_npc_role_becomes_persona_hint_only_when_persona_unset():
    manager = DocumentStore(Store(":memory:"))

    with_role_only = await npc_records.create_npc(manager, CHAT_KEY, "Elias Crane", role="antagonist")
    with_persona = await npc_records.create_npc(manager, CHAT_KEY, "Martha", persona="The innkeeper.", role="innkeeper")

    assert with_role_only.persona == "antagonist"
    assert with_persona.persona == "The innkeeper."  # explicit persona wins over the role hint


async def test_list_update_move_disposition_learns_persist_across_manager_instances():
    """The M5 spec's persistence self-test: writes via one `NpcManager` must be visible to a
    freshly-constructed `NpcManager` bound to the SAME `Store`, proving they round-tripped through
    the store rather than only mutating an in-memory dataclass instance."""
    store = Store(":memory:")
    writer = DocumentStore(store)

    await npc_records.create_npc(writer, CHAT_KEY, "Martha", location="Inn", disposition="wary", knowledge=["Sailors vanish."])
    await npc_records.create_npc(writer, CHAT_KEY, "Elias Crane", major=True)

    reader = DocumentStore(store)
    listed = await npc_records.list_npcs(reader, CHAT_KEY)
    assert {npc.name for npc in listed} == {"Martha", "Elias Crane"}

    updated = await npc_records.update_npc(reader, CHAT_KEY, "Martha", style="clipped, suspicious")
    assert updated is not None
    assert updated.style == "clipped, suspicious"

    moved = await npc_records.move_npc(reader, CHAT_KEY, "Martha", "The docks")
    assert moved.location == "The docks"

    disposed = await npc_records.set_disposition(reader, CHAT_KEY, "Martha", "hostile")
    assert disposed.disposition == "hostile"

    learned = await npc_records.npc_learns(reader, CHAT_KEY, "Martha", "A stranger asked about the keeper.")
    assert learned.knowledge == ["Sailors vanish.", "A stranger asked about the keeper."]

    # a THIRD manager instance, to make sure every mutation above genuinely round-tripped
    verifier = DocumentStore(store)
    final = await npc_records.get_npc(verifier, CHAT_KEY, "Martha")
    assert final is not None
    assert final.style == "clipped, suspicious"
    assert final.location == "The docks"
    assert final.disposition == "hostile"
    assert final.knowledge == ["Sailors vanish.", "A stranger asked about the keeper."]

    assert await npc_records.delete_npc(verifier, CHAT_KEY, "Elias Crane") is True
    assert await npc_records.get_npc(verifier, CHAT_KEY, "Elias Crane") is None
    assert [npc.name for npc in await npc_records.list_npcs(verifier, CHAT_KEY)] == ["Martha"]
    assert await npc_records.delete_npc(verifier, CHAT_KEY, "Elias Crane") is False  # already gone


async def test_add_knowledge_replace_mode_overwrites_add_mode_appends():
    manager = DocumentStore(Store(":memory:"))
    await npc_records.create_npc(manager, CHAT_KEY, "Martha", knowledge=["fact one"])

    appended = await npc_records.add_knowledge(manager, CHAT_KEY, "Martha", ["fact two"], mode="add")
    assert appended.knowledge == ["fact one", "fact two"]

    replaced = await npc_records.add_knowledge(manager, CHAT_KEY, "Martha", ["only this now"], mode="replace")
    assert replaced.knowledge == ["only this now"]


async def test_cjk_names_resolve_to_their_own_npc_not_the_fallback_slug_holder():
    """2026-08-06 live playtest bug: every CJK-only name slugifies to the bare "npc"
    fallback, and slug-before-name resolution sent updates for 老周 to 沈茉 (the NPC
    that happened to hold the fallback id), silently cross-contaminating knowledge."""
    manager = DocumentStore(Store(":memory:"))
    first = await npc_records.create_npc(manager, CHAT_KEY, "沈茉", knowledge=["妹妹的事实"])
    second = await npc_records.create_npc(manager, CHAT_KEY, "老周", knowledge=["门房的事实"])
    assert first.id != second.id  # CJK names both fall back to "npc"-family ids

    updated = await npc_records.add_knowledge(manager, CHAT_KEY, "老周", ["它在数上楼的人"], mode="replace")
    assert updated is not None and updated.name == "老周"
    assert (await npc_records.get_npc(manager, CHAT_KEY, "沈茉")).knowledge == ["妹妹的事实"]  # untouched
    assert (await npc_records.get_npc(manager, CHAT_KEY, "老周")).knowledge == ["它在数上楼的人"]


async def test_recreating_an_existing_name_returns_the_seeded_record_not_a_duplicate():
    """History drops tool chatter, so a later turn legitimately re-'creates' an NPC it
    already seeded — the fresh surface persona must never shadow the seeded record."""
    manager = DocumentStore(Store(":memory:"))
    seeded = await npc_records.create_npc(manager, CHAT_KEY, "老周", secret_agenda="看门物", knowledge=["数上楼的人"])

    again = await npc_records.create_npc(manager, CHAT_KEY, "老周", persona="表面上的管理员")

    assert again.id == seeded.id
    assert again.secret_agenda == "看门物"  # untouched — surface re-create never clobbers
    assert [npc.id for npc in await npc_records.list_npcs(manager, CHAT_KEY)] == [seeded.id]


async def test_unknown_npc_mutations_return_none_or_false_not_raise():
    manager = DocumentStore(Store(":memory:"))

    assert await npc_records.update_npc(manager, CHAT_KEY, "nobody", location="x") is None
    assert await npc_records.move_npc(manager, CHAT_KEY, "nobody", "x") is None
    assert await npc_records.set_disposition(manager, CHAT_KEY, "nobody", "x") is None
    assert await npc_records.npc_learns(manager, CHAT_KEY, "nobody", "x") is None
    assert await npc_records.add_knowledge(manager, CHAT_KEY, "nobody", ["x"]) is None
    assert await npc_records.delete_npc(manager, CHAT_KEY, "nobody") is False


# ---------------------------------------------------------------------------
# agent.npc_actor.voice_npc -- the information-isolation signature test (the red line)
# ---------------------------------------------------------------------------


async def test_voice_npc_passes_the_lines_dramatic_weight_as_reasoning_effort():
    """The KP picks each NPC line's thinking depth (speak_as_npc `effort`); voice_npc
    forwards it per call, defaulting to medium and clamping junk — a sub-actor line must
    never silently inherit the session's full (possibly max) thinking budget."""
    fake = FakeLLM(script=[assistant_text("{}")] * 3)
    services = build_services(Settings(), llm=fake, embeddings=FakeEmbeddings(8))
    npc = NpcRecord(id="martha", name="Martha")

    await voice_npc(services, npc, "a quiet nod")
    await voice_npc(services, npc, "the confession", effort="high")
    await voice_npc(services, npc, "junk tier", effort="dramatic!!")

    assert fake.reasoning_efforts == ["medium", "high", "medium"]


async def test_voice_npc_never_leaks_keeper_secrets_or_other_npcs_knowledge():
    chat_key = "lighthouse-room"
    store = Store(":memory:")
    npcs = DocumentStore(store)

    # The module keeper pool holds the sentinel world-truth.
    await DocumentStore(store).put_singleton(
        chat_key,
        "module_pool",
        {"keeper": {"npcs": [{"name": "Elias Crane", "description": "The keeper.", "secret": SENTINEL, "role": "antagonist"}]}, "player": {}},
    )
    # A DIFFERENT NPC's own knowledge also holds the sentinel.
    await npc_records.create_npc(npcs,
        chat_key,
        "Elias Crane",
        secret_agenda=SENTINEL,
        knowledge=[SENTINEL, "The light still burns every night."],
    )
    # The NPC under test knows nothing of any of that.
    martha = await npc_records.create_npc(npcs,
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


async def test_voice_npc_renders_its_prompt_in_the_ROOM_locale_not_the_process_default():
    """A zh room must not hand its NPCs an English system prompt.

    `services.i18n` is built once from the PROCESS locale (`infra.config.Settings.locale`,
    default "en"), while a room's language is per-room state set by `.language`. The sub-actor
    used to render from the former, so `.language zh` restyled the main Keeper prompt but left
    every NPC actor being instructed in English -- and a model instructed in English writes
    calqued, translated-sounding Chinese.
    """
    recorded: list[list[dict]] = []

    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps({"dialogue": "别站这么亮。", "action_intent": "退半步", "mood": "害怕"}))

    # Process locale stays "en" (the default) -- only the ROOM is Chinese.
    services = build_services(Settings(), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8))
    assert services.i18n.locale == "en"

    await voice_npc(services, NpcRecord(id="clam", name="老克拉姆"), "有人递上一枚银币。", locale="zh")

    system_prompt = recorded[0][0]["content"]
    assert "你是老克拉姆" in system_prompt
    assert "You are" not in system_prompt


async def test_voice_npc_still_uses_the_process_locale_when_no_room_locale_is_given():
    """Back-compat: a caller with no room context keeps the previous behaviour."""
    recorded: list[list[dict]] = []

    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps({"dialogue": "Hello.", "action_intent": "", "mood": "calm"}))

    services = build_services(Settings(), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8))
    await voice_npc(services, NpcRecord(id="npc-1", name="Guard"), "Someone greets them.")

    assert "You are Guard" in recorded[0][0]["content"]


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


async def test_speak_as_npc_weaves_dialogue_and_excludes_keeper_secret():
    chat_key = "speak-room"
    keeper_secret = "The mayor is secretly funding the cult."
    llm = FakeLLM(
        script=[assistant_text(json.dumps({"dialogue": "I've heard nothing of the sort.", "action_intent": "shrug and turn away", "mood": "evasive"}))]
    )
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(8))
    await services.documents.put_singleton(
        chat_key,
        "module_pool",
        {"keeper": {"npcs": [{"name": "The Mayor", "description": "...", "secret": keeper_secret, "role": "antagonist"}]}, "player": {}},
    )
    await services.battles.start_session(chat_key)

    tools = NpcTools(services)
    ctx = _ctx(chat_key)
    await tools.create_npc(ctx, name="Old Tomas", persona="A gossiping dockhand.", knowledge="Ships come in on Tuesdays.")

    line = await tools.speak_as_npc(ctx, npc="Old Tomas", situation="A stranger asks Tomas if he knows anything odd about the mayor.")

    assert "I've heard nothing of the sort." in line
    assert "evasive" in line
    # The NPC's private action_intent is keeper-side staging, not part of the line the
    # Keeper relays to the table — it goes to the keeper-only note surface instead (see
    # tests/agent/test_npc_intent_channel.py).
    assert "shrug and turn away" not in line
    assert keeper_secret not in line


async def test_speak_as_npc_threads_the_rooms_locale_into_the_sub_actor():
    """End-to-end for the call site: the tool must pass `ctx.locale` down to `voice_npc`."""
    recorded: list[list[dict]] = []

    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps({"dialogue": "别站这么亮。", "action_intent": "退半步", "mood": "害怕"}))

    services = build_services(Settings(), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8))
    await services.battles.start_session("zh-room")
    tools = NpcTools(services)
    ctx = _ctx("zh-room", locale="zh")
    await tools.create_npc(ctx, name="老克拉姆", persona="码头上的鱼贩。", knowledge="船周二进港。")

    await tools.speak_as_npc(ctx, npc="老克拉姆", situation="有人递上一枚银币。")

    assert "你是老克拉姆" in recorded[-1][0]["content"]


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

    await services.documents.put_singleton(
        chat_key,
        "module_pool",
        {
            "keeper": {
                "npcs": [
                    {"name": "Martha", "description": "innkeeper", "secret": "she knows more than she lets on", "role": "innkeeper"},
                    {"name": "Elias Crane", "description": "the keeper", "secret": SENTINEL, "role": "antagonist"},
                ]
            },
            "player": {},
        },
    )

    result = await tools.import_module_npcs(ctx)
    assert "Elias Crane" in result

    npcs = services.documents
    elias = await npc_records.get_npc(npcs, chat_key, "Elias Crane")
    assert elias is not None
    assert elias.secret_agenda == SENTINEL
    assert elias.public_description == "the keeper"
    assert elias.persona == "antagonist"  # role -> persona hint, since no persona was given

    martha = await npc_records.get_npc(npcs, chat_key, "Martha")
    assert martha is not None
    assert martha.secret_agenda == ""  # untouched: the pre-existing NPC was skipped, not overwritten

    listed_names = sorted(npc.name for npc in await npc_records.list_npcs(npcs, chat_key))
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

    # locked decision (docs/specs/M5-npc.md): no separate options tool
    assert "npc_action_options" not in toolset.names()


async def test_a_player_character_can_never_be_created_as_an_npc_or_companion():
    """2026-08-18 《安土》 run 1: the Keeper — unable to see a non-acting player's sheet —
    registered a real player as an AI companion `npc-4` (`add_companion`) and drove them
    with `companion_act`: a scene narrated twice, the clock overwritten. The refusal lives
    in the cast WRITER (`agent.npc.create_npc`, which `create_companion` wraps), so every
    entry point is covered — the NPC tools, `add_companion`, `.party add`, a card imported
    as companion, a module's NPC seed — not two of them. A player = a character sheet not
    owned by a companion, or a claimable pregen; casefolded; AI companions' own NPC-backed
    sheets are not players and stay creatable."""
    from agent.kp_tools_companion import CompanionTools
    from core.character_manager import CharacterSheet
    from core.pregen_roster import pregen_add
    from infra.config import ImageGenSettings

    services = build_services(Settings(imagegen=ImageGenSettings()), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    chat_key = "antu-guard"
    tools = NpcTools(services)
    companions = CompanionTools(services)
    ctx = _ctx(chat_key)

    # A real player's characters: the active one and an inactive alt (both are the player's).
    await services.characters.save_character("player-2", chat_key, CharacterSheet("Alt Ego", "coc7"))
    await services.characters.save_character("player-2", chat_key, CharacterSheet("平知章", "coc7"))
    # An unclaimed pregen from the module's cast.
    await pregen_add(services.documents, chat_key, CharacterSheet("秦苁蓉", "coc7"))

    refused = await tools.create_npc(ctx, name="平知章", persona="a surveyor")
    assert refused.startswith("❌") and "平知章" in refused
    assert (await tools.sketch_npc(ctx, name="秦苁蓉", one_line="the physician")).startswith("❌")
    # THE incident path: the companion tool, the inactive alt, and a case variant.
    assert (await companions.add_companion(ctx, name="平知章", persona="the surveyor")).startswith("❌")
    assert (await companions.add_companion(ctx, name="Alt Ego", persona="…")).startswith("❌")
    assert (await companions.add_companion(ctx, name="alt ego", persona="…")).startswith("❌")
    # The writer itself refuses, whoever calls it.
    with pytest.raises(npc_records.PlayerNameReservedError):
        await npc_records.create_companion(services.documents, chat_key, "秦苁蓉")
    assert {record.name for record in await npc_records.list_npcs(services.documents, chat_key)} == set()

    # An ordinary NPC and an ordinary companion still create; the companion's own
    # NPC-backed sheet does not turn its name into a player's (re-adding is idempotent).
    assert (await tools.sketch_npc(ctx, name="老蒯", one_line="the ring-forest warden")).startswith("✅")
    assert (await companions.add_companion(ctx, name="Silas", persona="a quiet archer")).startswith("✅")
    assert (await companions.add_companion(ctx, name="Silas", persona="a quiet archer")).startswith("✅")
    assert {record.name for record in await npc_records.list_companions(services.documents, chat_key)} == {"Silas"}


async def test_a_keeper_npc_is_never_converted_into_a_companion_in_place():
    """`create_npc` deliberately hands back an EXISTING record on an exact name match (so a
    fresh surface persona cannot shadow seeded secrets), and `create_companion` then stamped
    `role="player_companion"` / `is_pc=True` onto whatever came back — so `add_companion` on
    a module NPC's name converted the villain, secret agenda and seeded knowledge included,
    into a party-side actor. The writer refuses instead, so every door refuses; creating a
    fresh companion and re-adding an existing one both still work."""
    from agent.kp_tools_companion import CompanionTools
    from infra.config import ImageGenSettings

    services = build_services(
        Settings(imagegen=ImageGenSettings()), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8)
    )
    chat_key = "conversion-guard"
    documents = services.documents
    ctx = _ctx(chat_key)
    companions = CompanionTools(services)

    villain = await npc_records.create_npc(
        documents, chat_key, "Villain", secret_agenda="kill everyone", knowledge=[SENTINEL]
    )

    refused = await companions.add_companion(ctx, name="Villain", persona="a loyal friend")
    assert refused.startswith("❌") and "Villain" in refused

    kept = await npc_records.get_npc(documents, chat_key, "Villain")
    assert (kept.role, kept.is_pc) == ("keeper_npc", False)
    assert kept.secret_agenda == "kill everyone"
    assert kept.knowledge == [SENTINEL]
    assert kept.persona == villain.persona
    assert await npc_records.list_companions(documents, chat_key) == []
    # Nothing landed on the sheet side either — the record was never minted, so there is
    # no half-created companion for the rollback path to strand.
    assert await services.characters.list_characters(npc_records.companion_uid(kept.id), chat_key) == []

    # The writer refuses whoever calls it, not just the tool.
    with pytest.raises(npc_records.KeeperNpcNameTakenError):
        await npc_records.create_companion(documents, chat_key, "Villain")

    # An unused name still creates, and re-adding a name that IS already a companion stays
    # idempotent (a re-create, not a conversion).
    assert (await companions.add_companion(ctx, name="Silas", persona="a quiet archer")).startswith("✅")
    assert (await companions.add_companion(ctx, name="Silas", persona="a quiet archer")).startswith("✅")
    assert {item.name for item in await npc_records.list_companions(documents, chat_key)} == {"Silas"}


async def test_a_companion_whose_sheet_cannot_be_written_leaves_no_record_behind(monkeypatch):
    """`add_companion` is record + sheet or nothing (2026-08-18 《安土》 npc-4 was a record
    whose sheet never landed): the sheet is built BEFORE the record exists, a failed sheet
    write undoes a record this call minted — and never one that already existed, since
    re-adding a companion is idempotent and its seeded knowledge is not this call's to lose."""
    from agent.kp_tools_companion import CompanionTools
    from infra.config import ImageGenSettings

    services = build_services(Settings(imagegen=ImageGenSettings()), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    chat_key = "antu-orphan"
    ctx = _ctx(chat_key)
    tools = CompanionTools(services)

    def _no_sheet(*_args, **_kwargs):
        raise RuntimeError("bad roll expression")

    async def _no_write(*_args, **_kwargs):
        raise RuntimeError("disk full")

    # Generation fails: nothing was written, not even the record.
    monkeypatch.setattr(services.characters, "generate_character", _no_sheet)
    reply = await tools.add_companion(ctx, name="Silas", persona="an archer")
    assert reply.startswith("❌") and "bad roll expression" in reply
    assert await npc_records.list_companions(services.documents, chat_key) == []
    monkeypatch.undo()

    # The write fails on a fresh name: the record this call minted is undone.
    monkeypatch.setattr(services.characters, "save_character", _no_write)
    reply = await tools.add_companion(ctx, name="Silas", persona="an archer")
    assert reply.startswith("❌") and "disk full" in reply
    assert await npc_records.list_companions(services.documents, chat_key) == []
    monkeypatch.undo()

    # A real companion with seeded knowledge, then a re-add whose write fails: the
    # existing record survives untouched.
    assert (await tools.add_companion(ctx, name="Silas", persona="an archer")).startswith("✅")
    await npc_records.npc_learns(services.documents, chat_key, "Silas", "the well is poisoned")
    monkeypatch.setattr(services.characters, "save_character", _no_write)
    assert (await tools.add_companion(ctx, name="Silas", persona="an archer")).startswith("❌")
    (silas,) = await npc_records.list_companions(services.documents, chat_key)
    assert silas.knowledge == ["the well is poisoned"]
