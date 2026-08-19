"""AI-KP tools for importing SillyTavern character cards (`docs/specs/M12-charcard.md` §3).

`CharcardTools` bridges a persona-chat character into a real adventure: it parses a SillyTavern
card (`core.charcard`), asks the deterministic core to build a rule-LEGAL sheet biased toward the
persona (`core.char_from_persona`), then drops the character in as EITHER the acting player's PC or
an AI player companion (M10). A card's embedded `character_book` is folded into the world lore
(M11), so the character brings its setting with it.

Every character import runs through `core.card_split` first (拆卡): the module machinery a
"heavy" ST card carries — hook scripts, `[InitVar]` variable declarations, executable EJS —
is STRIPPED from the character half and reported, because those payloads reprogram the whole
room and are the keeper's to bring in. The keeper does so with `.import <file> world`, which
calls `import_world_card` — deliberately a plain method, NOT an `@tool`: the world path exists
only behind the command surface's deterministic keeper gate, so no phrasing aimed at the model
can trigger it on a player's behalf.

Composes the already-built leaf modules with the shared services; every user-visible string is
looked up via `services.i18n` under `charcard.tools.*` (`locales/{en,zh}/charcard.json`). Card
fields (name/description/tags) are game DATA supplied at runtime, not string literals here.
"""

from __future__ import annotations

from pathlib import Path

from agent import npc as npc_records
from agent.context import AgentCtx
from agent.hook_runtime import install_room_hooks
from agent.kp_tools_npc import player_name_refusal
from agent.kp_tools_subsystems import room_rulepack
from agent.services import Services
from agent.tools import tool
from core.card_split import WorldPayloads, card_hook_codes, detect_world_payloads, split_card
from core.char_from_persona import build_sheet_from_persona, infer_pronoun_note
from core.character_manager import CharacterSheet
from core.character_rules import render_validation_notice, validate_sheet
from core.charcard import PNG_SIGNATURE, CharacterCard, parse_card_bytes
from core.documents import MODULE_POOL_ID, PLAYER_VIEWER
from core.lorecard import Lorecard, looks_like_lorecard, parse_lorecard_bytes
from core.module_brief import BRIEF_DOC_TYPE, brief_id, build_brief
from core.modvars import define_modvar
from core.pregen_roster import pregen_add
from core.rulepacks import load_rulepack
from infra.i18n import I18n
from infra.media_store import MediaStore
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet

_PREVIEW_CHARS = 200
_KEY_STAT_COUNT = 6


def _parse_any_card_file(host_path: Path) -> tuple[CharacterCard, Lorecard | None]:
    """`core.charcard.parse_card_bytes`, extended with the native-bundle sniff (M14):
    a `*.lorecard.json` (the studio forge's lossless export) parses through
    `core.lorecard` and hands back its extras — typed variable specs — alongside the
    embedded card; anything else is a stock SillyTavern card with no extras."""
    data = host_path.read_bytes()
    if looks_like_lorecard(data):
        lorecard = parse_lorecard_bytes(data, host_path.name)
        return lorecard.card, lorecard
    return parse_card_bytes(data, host_path.name), None


# The virtual per-player user_key a companion's CharacterSheet is stored under (M10) —
# the one definition lives with the cast writer, `agent.npc`.
_companion_uid = npc_records.companion_uid


def _persona_text(card: CharacterCard) -> str:
    """The roleplay persona carried onto the character, from the card's description + personality."""
    return "\n".join(part for part in (card.description, card.personality) if part).strip()


def _card_pronouns(card: CharacterCard) -> str:
    """Infer the card's gender/pronoun note from all of its prose fields (empty when unclear)."""
    blob = "\n".join(
        part for part in (card.description, card.personality, card.scenario, card.first_mes, card.mes_example) if part
    )
    return infer_pronoun_note(blob)


def _truncate(text: str) -> str:
    text = text.strip()
    return text if len(text) <= _PREVIEW_CHARS else f"{text[:_PREVIEW_CHARS]}…"


def _key_stats(sheet: CharacterSheet) -> str:
    """A short, comma-joined recap of the sheet's headline attributes (data only)."""
    attrs = sheet.attributes or {}
    try:
        spec = load_rulepack(sheet.system).sheet_spec
    except Exception:
        spec = None
    keys = [attr for attr in spec.attributes if attr in attrs] if spec is not None else list(attrs)
    return ", ".join(f"{attr} {attrs[attr]}" for attr in keys[:_KEY_STAT_COUNT])


async def _register_png_avatar(services: Services, ctx: AgentCtx, host_path: Path, sheet: CharacterSheet) -> None:
    try:
        data = host_path.read_bytes()
    except OSError:
        return
    if not data.startswith(PNG_SIGNATURE):
        return
    try:
        store = MediaStore(
            services.store,
            services.settings.data_dir,
            max_file_bytes=services.settings.tui.media_max_file_bytes,
            room_quota_bytes=services.settings.tui.media_room_quota_bytes,
        )
        record = await store.register_blob(
            room=ctx.chat_key,
            data=data,
            mime="image/png",
            name=host_path.name,
            uploader=ctx.uid(),
        )
    except Exception:
        return
    sheet.avatar = record.ref()


def _stripped_notice(i18n: I18n, world: WorldPayloads) -> str:
    """The itemized what-was-stripped line for a character import; "" for a plain card."""
    if not world.any:
        return ""
    return i18n.t(
        "charcard.tools.import.stripped",
        hooks=world.hooks,
        vars=world.initvar_entries,
        ejs=world.ejs_blocks,
        secret=world.secret_entries,
    )


async def _module_summary(services: Services, chat_key: str) -> str:
    """A brief, player-safe module summary (from the analyzed player pool) to fit the character to
    the adventure; best-effort -- returns "" when no module has been initialized."""
    try:
        view = await services.documents.get_view(chat_key, "module_pool", MODULE_POOL_ID, PLAYER_VIEWER)
        summary = view.get("summary") if isinstance(view, dict) else ""
        return str(summary or "")[:400]
    except Exception:
        return ""


class CharcardTools:
    """AI-KP tools for importing SillyTavern cards as a player PC or an AI companion."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(prep_only=True)
    async def import_character(self, ctx: AgentCtx, file_path: str, system: str = "", as_: str = "pc", name: str = "") -> str:
        """Import a SillyTavern character card and drop it into the adventure with an auto-generated,
        rule-legal sheet -- as the acting player's PC, or as an AI player companion. Any lore in the
        card's character_book is imported into the world.

        Args:
            file_path: The sandbox/logical path to the card (PNG or JSON), resolved via ctx.fs.
            system: Target rules system for the generated sheet; when omitted, the character
                system of the installed pack the card ships in (if it has one), else the room's
                active rule system.
            as_: "pc" to make it the acting player's character, or "companion" for an AI party member.
            name: Optional name override (defaults to the card's name).

        Returns:
            A localized summary: name, system, key stats, and how many lore entries were imported.
        """
        i18n = self._i18n(ctx)
        # No system named: a card that lives in an installed pack with a character
        # system of its own is built on THAT (the author shipped the card for it — a
        # module's pregen imported before the keeper's world import must not land as
        # the room's default), else the room's active system.
        pack_system = ""
        if not system.strip():
            try:
                from core.pack import installed_pack_character_system

                pack_system = (
                    installed_pack_character_system(self._services.settings.data_dir, Path(ctx.fs.get_file(file_path)))
                    if ctx.fs is not None
                    else ""
                ) or ""
            except Exception:
                pack_system = ""
            system = pack_system or (await room_rulepack(self._services, ctx)).system
        if ctx.fs is None:
            return i18n.t("charcard.tools.import.no_fs")
        try:
            host_path = Path(ctx.fs.get_file(file_path))
            if not host_path.exists():
                return i18n.t("charcard.tools.import.no_file", path=file_path)

            # 拆卡: a character import takes ONLY the character half. Hook scripts, variable
            # declarations and EJS are module machinery — stripped here (structurally, before
            # anything touches room state) and reported so the keeper knows the card has a
            # world half waiting behind `.import <file> world`.
            full_card, _lorecard = _parse_any_card_file(host_path)
            card, world = split_card(full_card)
            module_context = await _module_summary(self._services, ctx.chat_key)
            sheet = await build_sheet_from_persona(self._services, card, system, module_context=module_context)
            final_name = name.strip() or card.name or sheet.name
            sheet.name = final_name
            sheet, violations = validate_sheet(sheet, system)
            await _register_png_avatar(self._services, ctx, host_path, sheet)
            notices = [render_validation_notice(i18n, violations), _stripped_notice(i18n, world)]

            if as_.strip().lower() == "companion":
                documents = self._services.documents
                minted = await npc_records.find_npc_by_name(documents, ctx.chat_key, final_name) is None
                record = await npc_records.create_companion(documents,
                    ctx.chat_key,
                    final_name,
                    persona=_persona_text(card),
                    playstyle=", ".join(card.tags),
                    stat_char=final_name,
                    pronouns=_card_pronouns(card),
                )
                try:
                    await self._services.characters.save_character(_companion_uid(record.id), ctx.chat_key, sheet)
                except Exception:
                    # Record + sheet or nothing — for a record THIS call minted (see
                    # `CompanionTools.add_companion`); a re-import of an existing companion
                    # must not delete what it did not create.
                    if minted:
                        await npc_records.delete_npc(documents, ctx.chat_key, record.id)
                    raise
                lore = await self._import_card_lore(ctx, card)
                result = i18n.t(
                    "charcard.tools.import.done_companion",
                    name=final_name,
                    id=record.id,
                    system=sheet.system,
                    stats=_key_stats(sheet),
                    lore=lore,
                )
                return "\n".join([result, *[notice for notice in notices if notice]])

            # Default: the acting player plays AS the card -- save + set active under their own uid.
            await self._services.characters.save_character(ctx.uid(), ctx.chat_key, sheet)
            lore = await self._import_card_lore(ctx, card)
            result = i18n.t(
                "charcard.tools.import.done_pc",
                name=final_name,
                system=sheet.system,
                stats=_key_stats(sheet),
                lore=lore,
            )
            return "\n".join([result, *[notice for notice in notices if notice]])
        except npc_records.PlayerNameReservedError as exc:
            # `as companion` with a PLAYER's name: refused by the cast writer, same text as
            # every other entry point (`agent.npc.PlayerNameReservedError`).
            return player_name_refusal(i18n, exc)
        except Exception as exc:
            return i18n.t("charcard.tools.import.failed", error=str(exc))

    @tool(prep_only=True)
    async def preview_card(self, ctx: AgentCtx, file_path: str) -> str:
        """Preview a SillyTavern character card WITHOUT importing it: show its fields and how many
        lore entries it carries, so you can confirm before creating a sheet.

        Args:
            file_path: The sandbox/logical path to the card (PNG or JSON), resolved via ctx.fs.

        Returns:
            The card's name/description/personality/scenario/tags and its lore-entry count.
        """
        i18n = self._i18n(ctx)
        if ctx.fs is None:
            return i18n.t("charcard.tools.preview.no_fs")
        try:
            host_path = Path(ctx.fs.get_file(file_path))
            if not host_path.exists():
                return i18n.t("charcard.tools.preview.no_file", path=file_path)

            card, _lorecard = _parse_any_card_file(host_path)
            lines = [i18n.t("charcard.tools.preview.name_line", name=card.name or i18n.t("common.unknown"))]
            if card.description:
                lines.append(i18n.t("charcard.tools.preview.description_line", description=_truncate(card.description)))
            if card.personality:
                lines.append(i18n.t("charcard.tools.preview.personality_line", personality=_truncate(card.personality)))
            if card.scenario:
                lines.append(i18n.t("charcard.tools.preview.scenario_line", scenario=_truncate(card.scenario)))
            if card.tags:
                lines.append(i18n.t("charcard.tools.preview.tags_line", tags=", ".join(card.tags)))
            lines.append(i18n.t("charcard.tools.preview.lore_line", count=len(card.character_book)))
            world = detect_world_payloads(card)
            if world.any:
                lines.append(
                    i18n.t(
                        "charcard.tools.preview.world_line",
                        hooks=world.hooks,
                        vars=world.initvar_entries,
                        ejs=world.ejs_blocks,
                    )
                )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("charcard.tools.preview.failed", error=str(exc))

    async def _import_card_lore(self, ctx: AgentCtx, card: CharacterCard) -> int:
        """Fold the card's embedded `character_book` into the world lore (M11); 0 when it has none.
        `card` is always the CHARACTER half of a split (`core.card_split`), so no hook scripts or
        variable declarations can reach this path."""
        if not card.character_book:
            return 0
        # A character card is untrusted input: its embedded lore lands in the room-local scope with
        # constant/secret stripped (is_keeper=False) so a crafted card cannot inject always-on or
        # keeper-only text. See core.worldbook.import_entries. `char_name` binds the card's own
        # {{char}} macro statically — that name never changes for imported entries.
        return await self._services.worldbook.import_entries(
            ctx.chat_key, card.character_book, source=card.name, is_keeper=False, char_name=card.name
        )

    async def import_world_card(self, ctx: AgentCtx, file_path: str, system: str = "") -> str:
        """Import a card as a MODULE, both halves at once (拆卡, keeper trust):

        - the WORLD half — full lorebook with secrecy flags honored, `[InitVar]`
          declarations seeded into the room's variable tree, and any
          `extensions.loreweaver_hooks` scripts installed room-wide;
        - the CHARACTER half — a rule-legal sheet built from the persona and placed on the
          room's pre-generated roster (`core.pregen_roster`) as a claimable PC: players
          pick it up with `.pc claim <name>`. (An AI-played version is still a separate
          `.import <file> companion`.)

        `system` targets the rules system for the generated pregen sheet; the room's active
        rule system is used when omitted.

        Deliberately NOT an `@tool`: reprogramming the room is the human keeper's decision,
        so this is reachable only through `.import <file> world`, whose keeper check is
        deterministic (`gateway.commands`).
        """
        i18n = self._i18n(ctx)
        if ctx.fs is None:
            return i18n.t("charcard.tools.import.no_fs")
        try:
            host_path = Path(ctx.fs.get_file(file_path))
            if not host_path.exists():
                return i18n.t("charcard.tools.import.no_file", path=file_path)

            # System pin (owner verdict 2026-08-17, widened 2026-08-18): an explicit
            # `system` argument wins outright. Otherwise, a card imported FROM an
            # installed pack that has a CHARACTER system — its sole rulepack, or among
            # several the one that declares a make-character word of its own
            # (`core.pack.installed_pack_character_system`) — pins that system for the
            # room: the module's cast is built on the system its author shipped, and
            # later `.genchar`/make_char/click-imports follow it via `room_rulepack`.
            # Anything else keeps today's fallback. `pin_system` is only DECIDED here;
            # the room_state write happens at the END of the import, so a corrupt card
            # that fails to parse cannot leave the room retargeted onto a module that
            # never landed.
            pinned_line = ""
            pin_system = ""
            if not system.strip():
                from core.pack import installed_pack_character_system

                pack_system = installed_pack_character_system(self._services.settings.data_dir, host_path)
                if pack_system:
                    system = pack_system
                    pin_system = pack_system
                    pinned_line = i18n.t("charcard.tools.world.system_pinned", system=pack_system)
                else:
                    pack = await room_rulepack(self._services, ctx)
                    system = pack.system

            card, lorecard = _parse_any_card_file(host_path)
            character, world = split_card(card)
            # Keeper trust: secrecy flags are honored and InitVar declarations are consumed
            # into the shared MVU tree (`core.worldbook.import_entries` gates that on
            # `is_keeper=True`). The ORIGINAL entries are imported, not the stripped half —
            # render-time EJS in world lore is exactly what this path exists to carry.
            skipped_titles: list[str] = []
            lore = await self._services.worldbook.import_entries(
                ctx.chat_key,
                card.character_book,
                source=card.name,
                is_keeper=True,
                char_name=card.name,
                skipped_titles=skipped_titles,
            )
            hooks = card_hook_codes(card)
            if hooks:
                await install_room_hooks(self._services, ctx.chat_key, f"card:{card.name}", hooks)
            # Durable "this room runs an imported module" marker: the prompt builder folds the
            # keeper_discipline/module_fidelity blocks into the lore section ONLY for rooms
            # that actually loaded a module this way — a free-sandbox room whose keeper merely
            # `.lore add`ed some setting notes must never receive run-the-module directives.
            await self._services.store.state_set(ctx.chat_key, "world_import", card.name or "card")

            # The card's PROSE gets a home (UPSTREAM item 10): a keeper-only brief
            # document, copied deterministically — before this, description/scenario
            # and the authored opening(s) seeded nothing and the Keeper could not even
            # quote the module's own opening. Same-card re-import replaces it.
            openings: tuple[str, ...] = ()
            if lorecard is not None and lorecard.alternate_greetings:
                openings = tuple(lorecard.alternate_greetings)
            else:
                raw_data = card.raw.get("data") if isinstance(card.raw, dict) else None
                alt = raw_data.get("alternate_greetings") if isinstance(raw_data, dict) else None
                if isinstance(alt, list):
                    openings = tuple(str(entry) for entry in alt if isinstance(entry, str))
            brief = build_brief(card, openings)
            brief_line = ""
            if brief is not None:
                await self._services.documents.put(
                    ctx.chat_key,
                    BRIEF_DOC_TYPE,
                    brief_id(card.name),
                    brief,
                    source=f"card:{card.name}",
                )
                brief_line = i18n.t("charcard.tools.world.brief_line")

            # A native bundle (M14) additionally carries TYPED variable specs — the lossless
            # flavor of what an ST card can only ship as an [InitVar] tree. Keeper trust:
            # they land as real `core.modvars` trackers (validated/clamped from here on).
            specs_line = ""
            if lorecard is not None and lorecard.variable_specs:
                for spec in lorecard.variable_specs:
                    await define_modvar(self._services.documents, ctx.chat_key, dict(spec))
                specs_line = i18n.t("charcard.tools.world.specs_line", count=len(lorecard.variable_specs))

            # Only a card with an actual PERSONA half self-registers as a claimable PC.
            # A pure world/module card (no personality; for native bundles `opening` is
            # module text, not a greeting) is machinery — putting IT on the roster gave
            # players ".pc claim <a bronze dial>". Multi-PC casts ride `pregens:` below.
            has_persona = bool(character.personality.strip()) or (
                lorecard is None and bool(character.first_mes.strip())
            )
            pregen_line = ""
            if character.name.strip() and has_persona:
                sheet = await self._build_pregen_sheet(ctx, character, system, host_path)
                entry = await pregen_add(
                    self._services.documents, ctx.chat_key, sheet, source=f"card:{card.name}"
                )
                if entry is not None:
                    pregen_line = i18n.t("charcard.tools.world.pregen_line", name=sheet.name)

            # Native bundles may ship a claimable CAST (`pregens:`): deterministic sheets
            # from the system's defaults + declared skill overrides — no LLM in the path.
            cast_line = ""
            if lorecard is not None and lorecard.pregens:
                from core.rulepacks import load_rulepack
                from core.sheets import set_sheet_value

                pack = load_rulepack(system)
                cast_names: list[str] = []
                for spec in lorecard.pregens:
                    sheet = self._services.characters.generate_character(system, spec["name"])
                    for skill_name, value in dict(spec.get("skills", {})).items():
                        try:
                            set_sheet_value(sheet, pack, skill_name, int(value))
                        except Exception:
                            sheet.skills[skill_name] = int(value)
                    sheet, _cast_violations = validate_sheet(
                        sheet, system, initialize_vitals=True, creation_method="rolled"
                    )
                    entry = await pregen_add(
                        self._services.documents,
                        ctx.chat_key,
                        sheet,
                        source=f"card:{card.name}",
                        blurb=str(spec.get("blurb", "")),
                    )
                    if entry is not None:
                        cast_names.append(sheet.name)
                if cast_names:
                    cast_line = i18n.t(
                        "charcard.tools.world.cast_line",
                        count=len(cast_names),
                        names=i18n.t("common.list_separator").join(cast_names),
                    )

            # The import made it through every step — only now does the pin land.
            if pin_system:
                await self._services.store.state_set(ctx.chat_key, "room_system", pin_system)

            result = i18n.t(
                "charcard.tools.world.done",
                name=card.name or i18n.t("common.unknown"),
                lore=lore,
                vars=world.initvar_entries,
                hooks=len(hooks),
            )
            skipped_line = ""
            if skipped_titles:
                skipped_line = i18n.t(
                    "charcard.tools.world.skipped_line",
                    count=len(skipped_titles),
                    titles=i18n.t("common.list_separator").join(skipped_titles[:5]),
                )
            extra_lines = [
                line for line in (pinned_line, specs_line, brief_line, pregen_line, cast_line, skipped_line) if line
            ]
            return "\n".join([result, *extra_lines])
        except Exception as exc:
            return i18n.t("charcard.tools.world.failed", error=str(exc))

    @tool(keeper_only=True, read_only=True)
    async def module_brief(self, ctx: AgentCtx, name: str = "") -> str:
        """Read the imported module's brief -- the world card's own prose (pitch, scenario,
        authored opening and its alternates), kept verbatim from `.import ... world`. Open play by
        quoting or adapting the module's own opening; foreshadow from its scenario. Keeper eyes
        only: never paste it to players.

        Args:
            name: Which card's brief when several are imported; omit to get the only one (or a
                list of names when there are more).

        Returns:
            The brief's prose sections, or the list of available briefs.
        """
        i18n = self._i18n(ctx)
        from core.documents import KEEPER_VIEWER

        pairs = await self._services.documents.list_views(ctx.chat_key, BRIEF_DOC_TYPE, KEEPER_VIEWER)
        briefs = [view for _doc, view in pairs if view]
        if not briefs:
            return i18n.t("charcard.tools.brief.none")
        chosen = None
        if name.strip():
            wanted = brief_id(name)
            chosen = next(
                (view for view in briefs if brief_id(str(view.get("name", ""))) == wanted),
                None,
            )
            if chosen is None:
                return i18n.t(
                    "charcard.tools.brief.list",
                    names=i18n.t("common.list_separator").join(str(view.get("name", "")) for view in briefs),
                )
        elif len(briefs) == 1:
            chosen = briefs[0]
        else:
            return i18n.t(
                "charcard.tools.brief.list",
                names=i18n.t("common.list_separator").join(str(view.get("name", "")) for view in briefs),
            )
        lines = [i18n.t("charcard.tools.brief.header", name=str(chosen.get("name", "")))]
        for field in ("description", "personality", "scenario", "examples", "notes"):
            value = str(chosen.get(field, "")).strip()
            if value:
                lines.append(f"{i18n.t('charcard.tools.brief.label.' + field)}:\n{value}")
        opening = str(chosen.get("opening", "")).strip()
        if opening:
            lines.append(f"{i18n.t('charcard.tools.brief.label.opening')}:\n{opening}")
        for index, alt in enumerate(chosen.get("openings", []) or [], start=1):
            text = str(alt).strip()
            if text:
                lines.append(f"{i18n.t('charcard.tools.brief.label.alt_opening', index=index)}:\n{text}")
        return "\n\n".join(lines)

    async def _build_pregen_sheet(
        self, ctx: AgentCtx, character: CharacterCard, system: str, host_path: Path
    ) -> CharacterSheet:
        """A rule-legal, validated sheet from the split CHARACTER half (same pipeline as a
        player import: persona-biased build + rulepack validation + PNG avatar)."""
        module_context = await _module_summary(self._services, ctx.chat_key)
        sheet = await build_sheet_from_persona(self._services, character, system, module_context=module_context)
        sheet.name = character.name or sheet.name
        sheet, _violations = validate_sheet(sheet, system)
        await _register_png_avatar(self._services, ctx, host_path, sheet)
        return sheet


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="world_import",
        owner="agent.kp_tools_charcard",
        reset_scope="all",
        # The marker recording which world card a keeper imported (拆卡): module
        # provenance, kept exactly as long as the module it describes. `room_system`
        # is the world-import system pin — module-derived, so it lives and dies with
        # the same provenance.
        state_keys=frozenset({"world_import", "room_system"}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
