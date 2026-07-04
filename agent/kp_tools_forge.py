"""AI-KP tool for Layer B.3a: the skill-generation engine (`agent.forge`).

`ForgeTools.generate_skill` is the one tool this module exposes, and it is `gated=True` (Layer
B.2 -- see `agent.tools.tool` and `docs/plugins.md` "Layer B"): hidden from the model's toolset and
refused on dispatch unless the room has the `skill-forge` skill enabled (its `allowed-tools:
[generate_skill]` is what unlocks it). A fresh install can never have the AI Keeper author and
install new skills on its own initiative -- the keeper must opt in first.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.forge import generate_and_install_skill
from agent.services import Services
from agent.tools import tool
from infra.i18n import I18n


class ForgeTools:
    """The skill-forge tool provider: authors + installs a new KP skill from a natural-language ask."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(gated=True)
    async def generate_skill(self, ctx: AgentCtx, description: str) -> str:
        """Author and install a brand-new KP skill (a SKILL.md play-style bundle) from a
        natural-language description of the desired play-style. Only available once the
        `skill-forge` skill is enabled for this room.

        Args:
            description: A clear, self-contained description of the play-style to package: what
                it's for, what tone or mechanics it should bring, and (if anything) what tools it
                should unlock.

        Returns:
            Confirmation naming the new skill and its id, or an explanation of why generation
            failed (nothing is installed on failure).
        """
        i18n = self._i18n(ctx)
        result = await generate_and_install_skill(self._services, description)
        if result.ok:
            return i18n.t("agent.forge.installed", name=result.name, skill_id=result.skill_id, path=result.path)
        if result.error == "no_data_dir":
            return i18n.t("agent.forge.no_data_dir")
        if result.error.startswith("bad_id"):
            return i18n.t("agent.forge.bad_id", error=result.error.removeprefix("bad_id: "))
        return i18n.t("agent.forge.invalid", error=result.error)
