"""Avatar binding helpers shared by TUI control frames and commands."""

from __future__ import annotations

from typing import Any

from agent import npc as npc_records
from agent.services import Services
from core.character_manager import CharacterDataError, CharacterSheet, has_character


class AvatarError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def set_user_avatar(
    services: Services,
    *,
    user_id: str,
    chat_key: str,
    avatar: dict[str, Any] | None,
) -> CharacterSheet:
    try:
        sheet = await services.characters.get_character(user_id, chat_key)
    except CharacterDataError as exc:
        # An unreadable row cannot safely carry an avatar update (saving would
        # overwrite it); surface it through the transport-handled AvatarError.
        raise AvatarError("avatar_no_character") from exc
    if not has_character(sheet):
        raise AvatarError("avatar_no_character")
    sheet.avatar = avatar
    await services.characters.save_character(user_id, chat_key, sheet)
    return sheet


async def set_target_avatar(
    services: Services,
    *,
    chat_key: str,
    target: str,
    avatar: dict[str, Any] | None,
) -> CharacterSheet:
    record = await npc_records.get_npc(services.documents, chat_key, target)
    if record is None or not record.stat_char:
        raise AvatarError("avatar_target_not_found")

    candidate_user_ids = [f"companion:{record.id}", f"npc:{record.id}"]
    for user_id in candidate_user_ids:
        try:
            sheet = await services.characters.get_character(user_id, chat_key, record.stat_char)
        except CharacterDataError:
            continue
        if has_character(sheet):
            sheet.avatar = avatar
            await services.characters.save_character(user_id, chat_key, sheet)
            return sheet
    raise AvatarError("avatar_target_not_found")
