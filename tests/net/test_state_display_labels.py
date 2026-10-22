"""Protocol 2.5 display labels on the `state` frame.

Three additions, each a name BESIDE an id that does not change:

- `variables[].value_label` — an enum's current option, named by the pack;
- `character.attribute_labels` — each wire attribute key's display name, from the
  rulepack's own data (storage key → canonical name → `display`);
- `pregens[].blurb` / `claimed_by_name` — the card's one-line concept and the claimer's
  display name, persisted at claim time.

The pregen entry is built from an explicit field whitelist: the sentinel test below puts
keeper-facing notes and a sheet ON the document and checks neither reaches the frame.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.modvars import build_spec, define_modvar, set_modvar
from core.pregen_roster import (
    PREGEN_DOC_TYPE,
    pregen_add,
    pregen_claim,
    pregen_release,
    pregen_release_deleted,
)
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.state import build_room_state


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _ctx(room: str, *, user_id: str = "seed", locale: str = "en") -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform="tui", locale=locale)


# --- variables[].value_label ---------------------------------------------------------


async def test_enum_variable_carries_value_label_in_the_callers_locale():
    services = _services()
    ctx = _ctx("value-label-room", locale="zh")
    await define_modvar(
        services.documents,
        ctx.chat_key,
        build_spec(
            "column_state",
            "enum",
            labels={"en": "Column", "zh": "纵队"},
            options=["waiting", "marching"],
            option_labels={"zh": {"marching": "在道上"}, "en": {"marching": "On the road"}},
        ),
    )
    await set_modvar(services.documents, ctx.chat_key, "column_state", "marching")

    zh = (await build_room_state(services, ctx))["variables"][0]
    en = (await build_room_state(services, _ctx("value-label-room", locale="en")))["variables"][0]

    assert zh == {"id": "column_state", "label": "纵队", "kind": "enum", "value": "marching", "value_label": "在道上"}
    assert en["value"] == "marching" and en["value_label"] == "On the road"

    # An option nobody named: the entry is exactly the pre-2.5 shape.
    await set_modvar(services.documents, ctx.chat_key, "column_state", "waiting")
    entry = (await build_room_state(services, ctx))["variables"][0]
    assert entry == {"id": "column_state", "label": "纵队", "kind": "enum", "value": "waiting"}


async def test_keeper_only_enum_labels_never_reach_the_state_frame():
    services = _services()
    ctx = _ctx("value-label-secret")
    await define_modvar(
        services.documents,
        ctx.chat_key,
        build_spec(
            "truth_staging",
            "enum",
            visibility="keeper",
            options=["hidden", "revealed"],
            option_labels={"en": {"hidden": "SENTINEL-staging-label"}},
        ),
    )

    wire = json.dumps(await build_room_state(services, ctx), ensure_ascii=False)
    assert "SENTINEL-staging-label" not in wire
    assert "truth_staging" not in wire


# --- character.attribute_labels -----------------------------------------------------


async def _state_for(system: str, *, locale: str, room: str) -> dict:
    services = _services()
    ctx = _ctx(room, user_id="p1", locale=locale)
    sheet = services.characters.generate_character(system, "Nora")
    await services.characters.save_character(ctx.user_id, ctx.chat_key, sheet)
    return (await build_room_state(services, ctx))["character"]


async def test_coc7_attribute_labels_name_every_key_in_chinese():
    character = await _state_for("coc7", locale="zh", room="attr-zh")
    assert character["attribute_labels"]["APP"] == "外貌"
    assert character["attribute_labels"]["STR"] == "力量"
    # One label per wire key, and the keys themselves are untouched.
    assert set(character["attribute_labels"]) == set(character["attributes"])
    assert "APP" in character["attributes"]


async def test_coc7_attribute_labels_in_english_follow_the_display_table():
    character = await _state_for("coc7", locale="en", room="attr-en")
    assert character["attribute_labels"]["APP"] == "APP"
    assert character["attribute_labels"]["LUC"] == "Luck"


async def test_a_system_without_a_sheet_spec_sends_no_attribute_labels():
    character = await _state_for("wod", locale="zh", room="attr-wod")
    assert "attribute_labels" not in character


# --- pregens[].blurb / claimed_by_name ------------------------------------------------


async def test_pregen_entries_carry_blurb_and_the_claimers_name_through_the_claim_lifecycle():
    services = _services()
    ctx = _ctx("pregen-names")
    docs, chat, characters = services.documents, ctx.chat_key, services.characters
    await pregen_add(docs, chat, CharacterSheet(name="沈拾遗", system="coc7"), blurb="档案馆的抄写员")
    await pregen_add(docs, chat, CharacterSheet(name="关五", system="coc7"))

    state = await build_room_state(services, ctx)
    assert state["pregens"] == [
        {"name": "沈拾遗", "claimed_by": "", "blurb": "档案馆的抄写员"},
        {"name": "关五", "claimed_by": ""},
    ]

    # Claim: the display name rides the claim.
    assert (await pregen_claim(docs, chat, "沈拾遗", "tui:aaaa", characters, player_name="Ada"))[0] == "ok"
    entry = (await build_room_state(services, ctx))["pregens"][0]
    assert entry == {"name": "沈拾遗", "claimed_by": "tui:aaaa", "blurb": "档案馆的抄写员", "claimed_by_name": "Ada"}

    # Re-claim by the same member under a new display name refreshes it.
    assert (await pregen_claim(docs, chat, "沈拾遗", "tui:aaaa", characters, player_name="Ada L."))[0] == "yours"
    assert (await build_room_state(services, ctx))["pregens"][0]["claimed_by_name"] == "Ada L."

    # A claim attempt by someone else changes nothing.
    assert (await pregen_claim(docs, chat, "沈拾遗", "tui:bbbb", characters, player_name="Bo"))[0] == "taken"
    assert (await build_room_state(services, ctx))["pregens"][0]["claimed_by_name"] == "Ada L."

    # Release clears the name with the claim.
    assert await pregen_release(docs, chat, "沈拾遗", "tui:aaaa", characters) == "ok"
    entry = (await build_room_state(services, ctx))["pregens"][0]
    assert entry == {"name": "沈拾遗", "claimed_by": "", "blurb": "档案馆的抄写员"}
    doc = await docs.get(chat, PREGEN_DOC_TYPE, "沈拾遗")
    assert doc is not None and doc.data["claimed_by_name"] == ""


async def test_deleting_the_claimed_sheet_clears_the_claimers_name():
    services = _services()
    ctx = _ctx("pregen-delete")
    docs, chat, characters = services.documents, ctx.chat_key, services.characters
    await pregen_add(docs, chat, CharacterSheet(name="关五", system="coc7"))
    await pregen_claim(docs, chat, "关五", "tui:cccc", characters, player_name="Cy")
    assert (await build_room_state(services, ctx))["pregens"][0]["claimed_by_name"] == "Cy"

    assert await characters.delete_character("tui:cccc", chat, "关五")
    assert await pregen_release_deleted(docs, chat, "关五", "tui:cccc")

    assert (await build_room_state(services, ctx))["pregens"] == [{"name": "关五", "claimed_by": ""}]


async def test_reimporting_the_cast_keeps_the_claimers_name():
    services = _services()
    ctx = _ctx("pregen-reimport")
    docs, chat, characters = services.documents, ctx.chat_key, services.characters
    await pregen_add(docs, chat, CharacterSheet(name="文小书", system="coc7"), blurb="old")
    await pregen_claim(docs, chat, "文小书", "tui:dddd", characters, player_name="Di")
    await pregen_add(docs, chat, CharacterSheet(name="文小书", system="coc7"), blurb="new")

    entry = (await build_room_state(services, ctx))["pregens"][0]
    assert entry == {"name": "文小书", "claimed_by": "tui:dddd", "blurb": "new", "claimed_by_name": "Di"}


async def test_sentinel_state_pregens_never_carry_notes_or_sheet_data():
    """The entry is a WHITELIST: a pregen document that (now or later) also holds an
    author's keeper-facing notes, or any other field, cannot leak it through the frame —
    and the pristine sheet stays behind the projection."""
    services = _services()
    ctx = _ctx("pregen-sentinel")
    docs, chat = services.documents, ctx.chat_key
    sheet = CharacterSheet(name="秦苁蓉", system="coc7")
    sheet.attributes = {"STR": 77, "SENTINEL_ATTR": 1}
    sheet.notes = "SENTINEL-sheet-notes"
    await pregen_add(docs, chat, sheet, blurb="药铺的学徒")
    doc = await docs.get(chat, PREGEN_DOC_TYPE, "秦苁蓉")
    assert doc is not None
    data = dict(doc.data)
    data["notes"] = "SENTINEL-keeper-notes: 断根汤与药理线的钥匙"
    data["secret_extra"] = "SENTINEL-extra"
    await docs.put(chat, PREGEN_DOC_TYPE, "秦苁蓉", data)

    state = await build_room_state(services, ctx)

    assert state["pregens"] == [{"name": "秦苁蓉", "claimed_by": "", "blurb": "药铺的学徒"}]
    wire = json.dumps(state["pregens"], ensure_ascii=False)
    for leaked in ("SENTINEL", "断根汤", "sheet", "notes", "STR", "77"):
        assert leaked not in wire


async def test_pc_claim_command_stores_the_member_name_and_rename_clears_it():
    """End to end through the command lane: the name `.pc claim` stores is the same one
    its broadcast "X now plays Y" reply uses (`ctx.extra["member_name"]`), and a rename
    of the claimed copy — which returns the cast member to the pool — clears it."""
    from core.pregen_roster import pregen_entries
    from gateway.commands import CommandRouter

    services = _services()
    router = CommandRouter(services)
    ctx = _ctx("pregen-command", user_id="tui:eeee")
    ctx.extra["member_name"] = "Eve"
    await pregen_add(services.documents, ctx.chat_key, CharacterSheet(name="Carol", system="CoC"))

    reply = await router.dispatch(ctx, ".pc claim Carol")
    assert "Eve" in reply
    assert (await build_room_state(services, ctx))["pregens"][0]["claimed_by_name"] == "Eve"

    await router.dispatch(ctx, ".nn Caroline")
    entries = await pregen_entries(services.documents, ctx.chat_key)
    assert [(entry["claimed_by"], entry["claimed_by_name"]) for entry in entries] == [("", "")]
