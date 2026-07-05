"""Avatar binding helpers shared by TUI control frames and commands."""

from __future__ import annotations

from typing import Any

from agent.services import Services
from core.character_manager import CharacterSheet

_UNSET_CHARACTER_NAME = "default"


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
    sheet = await services.characters.get_character(user_id, chat_key)
    if not sheet or not sheet.name or sheet.name == _UNSET_CHARACTER_NAME:
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
    from agent.npc import NpcManager

    record = await NpcManager(services.store).get_npc(chat_key, target)
    if record is None or not record.stat_char:
        raise AvatarError("avatar_target_not_found")

    candidate_user_ids = [f"companion:{record.id}", f"npc:{record.id}"]
    for user_id in candidate_user_ids:
        sheet = await services.characters.get_character(user_id, chat_key, record.stat_char)
        if sheet and sheet.name and sheet.name != _UNSET_CHARACTER_NAME:
            sheet.avatar = avatar
            await services.characters.save_character(user_id, chat_key, sheet)
            return sheet
    raise AvatarError("avatar_target_not_found")
