"""Assemble the full AI-KP toolset from the mechanics + knowledge + NPC + companion providers.

The tool bodies live in `kp_tools_mechanics` (character / dice / initiative), `kp_tools_knowledge`
(module / document / notes / session), `kp_tools_npc` (AI-played keeper NPC sub-actors --
`docs/specs/M5.md`) and `kp_tools_companion` (AI player companions -- `docs/specs/M10-companions.md`).
This module is the single entry point the agent loop and adapters use to build the toolset for a
`Services` bundle."""

from __future__ import annotations

from typing import TYPE_CHECKING

from agent.kp_tools_charcard import CharcardTools
from agent.kp_tools_companion import CompanionTools
from agent.kp_tools_knowledge import DocumentTools, ModuleTools, NoteTools, SessionTools
from agent.kp_tools_mechanics import CharacterTools, DiceTools, InitiativeTools
from agent.kp_tools_npc import NpcTools
from agent.kp_tools_worldbook import WorldbookTools
from agent.services import Services
from agent.tools import Toolset

if TYPE_CHECKING:
    from gateway.commands import CommandRouter
    from gateway.hub import RoomHub


def build_kp_toolset(
    services: Services,
    *,
    hub: RoomHub | None = None,
    command_router: CommandRouter | None = None,
) -> Toolset:
    """Build the complete Keeper toolset bound to the given services.

    `hub`/`command_router` are supplied only on the shared-room path (the gateway runner), where they
    let the `companion_act` tool drive a live companion turn via `gateway.director`. Left at `None`
    everywhere else (standalone/tests, and every companion turn's own toolset), where `companion_act`
    degrades gracefully -- which is also what keeps companion turns from recursively spawning others.
    """
    return Toolset(
        CharacterTools(services),
        DiceTools(services),
        InitiativeTools(services),
        ModuleTools(services),
        DocumentTools(services),
        NoteTools(services),
        SessionTools(services),
        NpcTools(services),
        CompanionTools(services, hub=hub, command_router=command_router),
        WorldbookTools(services),
        CharcardTools(services),
    )
