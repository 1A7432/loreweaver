"""AI-KP tools for importing SillyTavern character cards (`docs/specs/M12-charcard.md` §3).

`CharcardTools` bridges a persona-chat character into a real adventure: it parses a SillyTavern
card (`core.charcard`), asks the deterministic core to build a rule-LEGAL sheet biased toward the
persona (`core.char_from_persona`), then drops the character in as EITHER the acting player's PC or
an AI player companion (M10). A card's embedded `character_book` is folded into the world lore
(M11), so the character brings its setting with it.

Composes the already-built leaf modules with the shared services; every user-visible string is
looked up via `services.i18n` under `charcard.tools.*` (`locales/{en,zh}/charcard.json`). Card
fields (name/description/tags) are game DATA supplied at runtime, not string literals here.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.context import AgentCtx
from agent.npc import NpcManager
from agent.services import Services
from agent.tools import tool
from core.char_from_persona import build_sheet_from_persona, infer_pronoun_note
from core.character_manager import CharacterSheet
from core.character_rules import render_validation_notice, validate_sheet
from core.charcard import PNG_SIGNATURE, CharacterCard, parse_card_file
from infra.i18n import I18n
from infra.media_store import MediaStore

_PREVIEW_CHARS = 200
_KEY_STAT_COUNT = 6
_COC_CORE_ATTRS = ("STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC")


def _companion_uid(companion_id: str) -> str:
    """The virtual per-player user_key a companion's CharacterSheet is stored under (matches M10)."""
    return f"companion:{companion_id}"


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
    keys = [attr for attr in _COC_CORE_ATTRS if attr in attrs] if sheet.system == "CoC" else list(attrs)
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


async def _module_summary(services: Services, chat_key: str) -> str:
    """A brief, player-safe module summary (from the analyzed player pool) to fit the character to
    the adventure; best-effort -- returns "" when no module has been initialized."""
    try:
        raw = await services.store.get(user_key="", store_key=f"module_player_pool.{chat_key}")
        if not raw:
            return ""
        data = json.loads(raw)
        summary = data.get("summary") if isinstance(data, dict) else ""
        return str(summary or "")[:400]
    except Exception:
        return ""


class CharcardTools:
    """AI-KP tools for importing SillyTavern cards as a player PC or an AI companion."""

    def __init__(self, services: Services) -> None:
        self._services = services
        self._npcs = NpcManager(services.store)

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool
    async def import_character(self, ctx: AgentCtx, file_path: str, system: str = "coc7", as_: str = "pc", name: str = "") -> str:
        """Import a SillyTavern character card and drop it into the adventure with an auto-generated,
        rule-legal sheet -- as the acting player's PC, or as an AI player companion. Any lore in the
        card's character_book is imported into the world.

        Args:
            file_path: The sandbox/logical path to the card (PNG or JSON), resolved via ctx.fs.
            system: Target rules system for the generated sheet (coc7/dnd5e).
            as_: "pc" to make it the acting player's character, or "companion" for an AI party member.
            name: Optional name override (defaults to the card's name).

        Returns:
            A localized summary: name, system, key stats, and how many lore entries were imported.
        """
        i18n = self._i18n(ctx)
        if ctx.fs is None:
            return i18n.t("charcard.tools.import.no_fs")
        try:
            host_path = Path(ctx.fs.get_file(file_path))
            if not host_path.exists():
                return i18n.t("charcard.tools.import.no_file", path=file_path)

            card = parse_card_file(host_path)
            module_context = await _module_summary(self._services, ctx.chat_key)
            sheet = await build_sheet_from_persona(self._services, card, system, module_context=module_context)
            final_name = name.strip() or card.name or sheet.name
            sheet.name = final_name
            sheet, violations = validate_sheet(sheet, system)
            await _register_png_avatar(self._services, ctx, host_path, sheet)
            validation_notice = render_validation_notice(i18n, violations)

            if as_.strip().lower() == "companion":
                record = await self._npcs.create_companion(
                    ctx.chat_key,
                    final_name,
                    persona=_persona_text(card),
                    playstyle=", ".join(card.tags),
                    stat_char=final_name,
                    pronouns=_card_pronouns(card),
                )
                await self._services.characters.save_character(_companion_uid(record.id), ctx.chat_key, sheet)
                lore = await self._import_card_lore(ctx, card)
                result = i18n.t(
                    "charcard.tools.import.done_companion",
                    name=final_name,
                    id=record.id,
                    system=sheet.system,
                    stats=_key_stats(sheet),
                    lore=lore,
                )
                return f"{result}\n{validation_notice}" if validation_notice else result

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
            return f"{result}\n{validation_notice}" if validation_notice else result
        except Exception as exc:
            return i18n.t("charcard.tools.import.failed", error=str(exc))

    @tool
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

            card = parse_card_file(host_path)
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
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("charcard.tools.preview.failed", error=str(exc))

    async def _import_card_lore(self, ctx: AgentCtx, card: CharacterCard) -> int:
        """Fold the card's embedded `character_book` into the world lore (M11); 0 when it has none."""
        if not card.character_book:
            return 0
        return await self._services.worldbook.import_entries(ctx.chat_key, card.character_book, source=card.name)
