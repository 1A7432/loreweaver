"""AI-KP tools for Layer B.3: the self-extension engines (`agent.forge`).

`ForgeTools` exposes the three `generate_*` tools -- `generate_skill` (B.3a), `generate_rulepack`
and `generate_module` (B.3b) -- and all three are `gated=True` (Layer B.2 -- see `agent.tools.tool`
and `docs/plugins.md` "Layer B"): hidden from the model's toolset and refused on dispatch unless
the room has enabled the matching forge skill (`skill-forge`/`rule-forge`/`module-forge`, whose
`allowed-tools:` is what unlocks each one). A fresh install can never have the AI Keeper author and
install new skills/rule systems/modules on its own initiative -- the keeper must opt in first.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.forge import generate_and_install_module, generate_and_install_rulepack, generate_and_install_skill
from agent.services import Services
from agent.tools import tool
from infra.i18n import I18n


class ForgeTools:
    """The forge tool provider: authors + installs a new KP skill / rule system / module from a
    natural-language ask, reusing `agent.forge`'s three generators."""

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

    @tool(gated=True)
    async def generate_rulepack(self, ctx: AgentCtx, description: str) -> str:
        """Author and install a brand-new TTRPG rule system (a rulepacks/<id>.yaml data pack) from a
        natural-language description of the system's sheet and how its checks resolve. Only
        available once the `rule-forge` skill is enabled for this room.

        Args:
            description: A clear, self-contained description of the rule system to package: its
                core attributes/skills and their starting values, how a check succeeds or fails,
                and any derived stats (health, damage bonus, modifiers, ...) it needs.

        Returns:
            Confirmation naming the new rule system and its id, or an explanation of why generation
            failed (nothing is installed on failure).
        """
        i18n = self._i18n(ctx)
        result = await generate_and_install_rulepack(self._services, description)
        if result.ok:
            return i18n.t("agent.forge.rulepack_installed", name=result.name, rulepack_id=result.skill_id, path=result.path)
        if result.error == "no_data_dir":
            return i18n.t("agent.forge.rulepack_no_data_dir")
        if result.error.startswith("bad_id"):
            return i18n.t("agent.forge.rulepack_bad_id", error=result.error.removeprefix("bad_id: "))
        return i18n.t("agent.forge.rulepack_invalid", error=result.error)

    @tool(gated=True)
    async def generate_module(self, ctx: AgentCtx, description: str) -> str:
        """Author and install a brand-new module/scenario document from a natural-language
        description (or a keeper-provided premise), landing it directly in THIS room's module
        knowledge pool through the same analysis the `.module` command uses. Only available once
        the `module-forge` skill is enabled for this room.

        Args:
            description: A clear, self-contained description of the scenario to author: setting,
                premise, the key NPCs/threats involved, and the shape of the mystery/adventure.

        Returns:
            Confirmation naming the new module and summarizing this room's resulting knowledge-pool
            state, or an explanation of why generation failed (nothing is installed on failure).
        """
        i18n = self._i18n(ctx)
        result = await generate_and_install_module(self._services, ctx, description)
        if result.ok:
            return i18n.t("agent.forge.module_installed", name=result.name, path=result.path, detail=result.detail)
        if result.error == "no_data_dir":
            return i18n.t("agent.forge.module_no_data_dir")
        if result.error.startswith("bad_id"):
            return i18n.t("agent.forge.module_bad_id", error=result.error.removeprefix("bad_id: "))
        return i18n.t("agent.forge.module_invalid", error=result.error)
