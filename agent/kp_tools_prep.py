"""The prep-phase script hatch as a Keeper tool (M20 F).

`core.prep_script` turns a script into a PLAN; this is where the plan meets the engine.
Every operation goes through `Toolset.dispatch`, which means it goes through exactly the
same argument coercion, `keeper_only` marking, `gated` unlock check and `prep_only` phase
check a model-issued call does — because it IS that code, not a parallel copy of it.

Two things this deliberately does not do:

- It does not run in the play phase. The tool is `prep_only`, so it is not even offered
  there, and `dispatch` refuses it a second time if the name is called blind.
- It does not reach commands. `.import … world` and `.var expose` are keeper COMMANDS,
  and a plan can only name tools — so the 拆卡 doctrine's two keeper-only affordances stay
  outside the script-reachable surface by construction rather than by an exclusion list
  someone has to remember to update.
"""

from __future__ import annotations

import logging

from agent.context import AgentCtx
from agent.services import Services
from agent.tool_phase import PREP_PHASE, room_capabilities
from agent.tools import Toolset, tool
from core.prep_script import MAX_OPERATIONS, build_plan
from infra.i18n import I18n

logger = logging.getLogger(__name__)


class PrepScriptTools:
    """The plan-then-apply hatch. Bound to the room's own toolset, which is what it applies through."""

    def __init__(self, services: Services, *, toolset_factory=None) -> None:
        self._services = services
        # The toolset this hatch applies through is the room's real one. It is supplied
        # lazily because `build_kp_toolset` constructs this provider WHILE building that
        # toolset — a direct reference would be a cycle.
        self._toolset_factory = toolset_factory

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(prep_only=True)
    async def run_prep_plan(self, ctx: AgentCtx, script: str = "", apply: bool = False, script_ref: str = "") -> str:
        """Run a small JavaScript script that PLANS bulk prep work, then optionally apply it.

        For work that is forty near-identical tool calls: seeding a cast from a list,
        defining a family of variables, importing in bulk. The script cannot call tools —
        it calls plan(toolName, argsObject) as many times as it likes, and the engine
        applies each planned call through the ordinary tool path afterwards. Leave apply
        false first to see exactly what it would do.

        Args:
            script: JavaScript. Only plan(tool, args) has any effect; there is no engine
                state to read, so compute what you need from literals in the script.
            apply: False previews the plan; True applies it, in order, stopping at the
                first failure.
            script_ref: Instead of inline script text, a pack-relative reference to a
                script an installed pack ships (e.g. "blackmoor/prep/setup.js"). Exactly
                one of script/script_ref must be given.

        Returns:
            The planned operations, and — when applied — what each one returned.
        """
        i18n = self._i18n(ctx)
        if bool(script.strip()) == bool(script_ref.strip()):
            return i18n.t("prep_script.source_usage")
        if script_ref.strip():
            from core.pack import resolve_installed_path
            from core.prep_script import MAX_SCRIPT_CHARS

            resolved = resolve_installed_path(self._services.settings.data_dir, script_ref.strip())
            if resolved is None:
                return i18n.t("prep_script.ref_not_found", ref=script_ref.strip())
            try:
                script = resolved.read_text(encoding="utf-8")[: MAX_SCRIPT_CHARS + 1]
            except (OSError, UnicodeDecodeError) as exc:
                return i18n.t("prep_script.ref_not_found", ref=f"{script_ref.strip()} ({exc})")
        plan = build_plan(script)
        if not plan:
            return i18n.t("prep_script.invalid", error=plan.error)
        if not plan.operations:
            return i18n.t("prep_script.empty")

        preview = "\n".join(
            i18n.t("prep_script.operation", index=index, tool=operation["tool"], args=str(operation["args"])[:200])
            for index, operation in enumerate(plan.operations, start=1)
        )
        if not apply:
            return i18n.t("prep_script.preview", count=len(plan.operations), operations=preview)

        toolset = self._toolset_factory() if self._toolset_factory is not None else None
        if toolset is None:
            return i18n.t("prep_script.unavailable")

        from core.skills import unlocked_tools_for

        # The room's REAL unlocked set, not an empty one: "the same gating" means a plan
        # reaches exactly what a model-issued call in this room reaches — no more (a locked
        # gated tool stays locked) and no less (a skill the keeper enabled is not quietly
        # revoked just because the call arrived via a script).
        unlocked = await unlocked_tools_for(self._services.store, ctx.chat_key)
        # …and the room's real capability set, for the same reason (a pool tool in a
        # world-card room is unreachable for a script exactly as it is for the model).
        capabilities = await room_capabilities(self._services.documents, ctx.chat_key)

        unreachable = self._unreachable(toolset, plan.operations, unlocked, capabilities)
        if unreachable:
            return i18n.t("prep_script.unreachable", tools=", ".join(unreachable))
        return await self._apply(ctx, toolset, plan.operations, unlocked, capabilities, i18n)

    @staticmethod
    def _unreachable(
        toolset: Toolset, operations: list[dict], unlocked: set[str], capabilities: set[str]
    ) -> list[str]:
        """Named tools this plan cannot reach — checked BEFORE anything is applied.

        This is the atomicity the CodeAct exclusion said a scripted lane would lose, and
        the only form of it worth promising: the whole plan is validated first, so a plan
        that names a tool that does not exist (or one this room has not unlocked) applies
        NOTHING rather than half of itself. Rollback of already-applied writes is not on
        offer and is not implied.
        """
        known = set(toolset.names())
        return sorted(
            {
                operation["tool"]
                for operation in operations
                if operation["tool"] not in known
                or (toolset.is_gated(operation["tool"]) and operation["tool"] not in unlocked)
                or (toolset.needs(operation["tool"]) and toolset.needs(operation["tool"]) not in capabilities)
            }
        )

    async def _apply(
        self,
        ctx: AgentCtx,
        toolset: Toolset,
        operations: list[dict],
        unlocked: set[str],
        capabilities: set[str],
        i18n: I18n,
    ) -> str:
        """Apply each pre-checked operation through the ordinary tool path, in order.

        `Toolset.dispatch` never raises — a bad argument comes back as a localized string —
        so a per-operation result is reported as-is rather than parsed for success. What
        the pre-check already guaranteed is that no operation is refused for a reason the
        plan could have known about in advance.
        """
        lines: list[str] = []
        for index, operation in enumerate(operations[:MAX_OPERATIONS], start=1):
            try:
                result = await toolset.dispatch(
                    operation["tool"], ctx, operation["args"], unlocked, phase=PREP_PHASE, capabilities=capabilities
                )
            except Exception as exc:  # noqa: BLE001 — a raising tool body stops the run
                logger.warning("prep plan operation %s failed", operation["tool"], exc_info=True)
                lines.append(i18n.t("prep_script.failed", index=index, tool=operation["tool"], error=str(exc)))
                break
            lines.append(
                i18n.t("prep_script.applied", index=index, tool=operation["tool"], result=str(result)[:200])
            )
        return i18n.t("prep_script.done", count=len(lines), results="\n".join(lines))
