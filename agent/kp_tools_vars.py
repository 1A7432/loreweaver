"""AI-KP tools for deterministic module variables (author/keeper-declared trackers).

`ModuleVarTools` is the function-calling surface over `core.modvars`: the Keeper
declares a variable once (`define_variable` — kind, bounds, visibility, display label) and then
nudges/sets it as play evolves. Per iron rule #1 (deterministic vs generative split) every write is
validated and clamped by `core.modvars` — the model only narrates around the resulting values;
`agent.prompt_builder` folds the CURRENT state into the main KP prompt every turn, and `net.state`
ships the player-visible subset to clients (keeper-only variables are structurally filtered there —
iron rule #3).

None of these tools are gated: declaring and updating trackers is core keeper workflow, exactly like
the worldbook tools. None are `keeper_only` either — the tools themselves hold no module secrets; a
variable the players must not see is declared ``visibility="keeper"`` and never leaves the server.
All user-visible text is looked up via `services.i18n` under `modvars.*`
(`locales/{en,zh}/modvars.json`).
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.modvars import (
    KINDS,
    VISIBILITIES,
    adjust_modvar,
    build_spec,
    define_modvar,
    label_for,
    load_modvars,
    normalize_id,
    remove_modvar,
    set_modvar,
)
from core.mvu_compat import load_mvu, mvu_flatten, mvu_has_data, save_mvu
from infra.i18n import I18n


class ModuleVarTools:
    """AI-KP tools for defining and updating deterministic module variables."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    def _language(self, ctx: AgentCtx) -> str:
        return (ctx.locale or "en").split("-")[0].lower()

    async def _known_or_error(self, ctx: AgentCtx, i18n: I18n, var_id: str) -> tuple[str | None, dict | None]:
        """Resolve a model-supplied id to a defined variable's (id, spec), or (None, None) after
        composing the localized error into the second slot — callers return the error string."""
        slug = normalize_id(var_id)
        state = await load_modvars(self._services.documents, ctx.chat_key)
        if slug is not None and slug in state["specs"]:
            return slug, state["specs"][slug]
        if not state["specs"]:
            return None, {"error": i18n.t("modvars.tools.none_defined")}
        return None, {
            "error": i18n.t(
                "modvars.tools.unknown_var", id=var_id, known=", ".join(state["specs"])
            )
        }

    @tool
    async def define_variable(
        self,
        ctx: AgentCtx,
        var_id: str,
        kind: str,
        label: str = "",
        visibility: str = "player",
        minimum: int | None = None,
        maximum: int | None = None,
        default: str | None = None,
        options: list[str] | None = None,
    ) -> str:
        """Declare (or redefine) a deterministic module variable — a named tracker whose value the
        engine validates, clamps, and persists. Use these for anything the story should measure
        honestly: suspicion, town fear, quest progress, an NPC's alert state. Define once at module
        start (or when a new tracker becomes relevant), then update with set_variable /
        adjust_variable; the current values appear in your context every turn. Player-visible
        variables also show on players' screens automatically — keeper-only ones never leave the
        server, so hidden trackers stay hidden.

        Args:
            var_id: Stable identifier, lowercase letters/digits/underscores (e.g. "town_fear").
            kind: One of "number" (integer, optional bounds), "bool", "text", or "enum".
            label: Display name shown to players and in your state, in the room's language
                (e.g. "Town Fear" / "小镇恐慌"). Defaults to the id when omitted.
            visibility: "player" (shown on players' screens) or "keeper" (your eyes only —
                never revealed to players).
            minimum: Lower bound, number kind only. Omit for unbounded.
            maximum: Upper bound, number kind only. Omit for unbounded.
            default: Starting value; omit for the kind's natural default (bounded numbers start
                at their minimum, bool at false, enum at its first option).
            options: The allowed values, enum kind only (e.g. ["calm", "uneasy", "panicked"]).

        Returns:
            Confirmation with the stored spec and current value, or a validation error naming
            the problem.
        """
        i18n = self._i18n(ctx)
        if normalize_id(var_id) is None:
            return i18n.t("modvars.tools.bad_id")
        if kind not in KINDS:
            return i18n.t("modvars.tools.bad_kind", allowed=", ".join(KINDS))
        if visibility not in VISIBILITIES:
            return i18n.t("modvars.tools.bad_visibility", allowed=", ".join(VISIBILITIES))
        try:
            labels = {self._language(ctx): label} if label.strip() else None
            spec = build_spec(
                var_id,
                kind,
                labels=labels,
                visibility=visibility,
                minimum=minimum,
                maximum=maximum,
                default=default,
                options=options,
            )
            await define_modvar(self._services.documents, ctx.chat_key, spec)
            state = await load_modvars(self._services.documents, ctx.chat_key)
            return i18n.t(
                "modvars.tools.define.done",
                label=label_for(spec, ctx.locale),
                id=spec["id"],
                kind=kind,
                visibility=i18n.t(f"modvars.visibility.{visibility}"),
                value=state["values"][spec["id"]],
            )
        except Exception as exc:
            return i18n.t("modvars.tools.failed", error=str(exc))

    @tool
    async def set_variable(self, ctx: AgentCtx, var_id: str, value: str) -> str:
        """Set a defined module variable to an exact value. The engine validates the value against
        the variable's declared kind (numbers clamp into their bounds, enums must match an option,
        bools accept true/false forms) — the stored result is authoritative; narrate around it.

        Args:
            var_id: The variable's id, as defined via define_variable.
            value: The new value, as text (e.g. "7", "true", "panicked", "the vault key").

        Returns:
            Confirmation with the old and new values, or a validation error naming the problem.
        """
        i18n = self._i18n(ctx)
        slug, spec_or_error = await self._known_or_error(ctx, i18n, var_id)
        if slug is None:
            return spec_or_error["error"]
        try:
            old, new = await set_modvar(self._services.documents, ctx.chat_key, slug, value)
            return i18n.t(
                "modvars.tools.set.done", label=label_for(spec_or_error, ctx.locale), id=slug, old=old, new=new
            )
        except Exception as exc:
            return i18n.t("modvars.tools.failed", error=str(exc))

    @tool
    async def adjust_variable(self, ctx: AgentCtx, var_id: str, delta: int, reason: str = "") -> str:
        """Nudge a number-kind module variable by a signed delta (clamped into its bounds). Call
        this when play actually moves the tracker — a clue found, a night of terror, a rumor
        spreading — the number should inform your narration's tone, never the other way around.

        Args:
            var_id: The variable's id, as defined via define_variable. Number kind only.
            delta: Signed integer change to apply (e.g. 1, -2).
            reason: Optional free-text note on why, for your own bookkeeping; not required.

        Returns:
            Confirmation with the old and new values, or a validation error naming the problem.
        """
        i18n = self._i18n(ctx)
        slug, spec_or_error = await self._known_or_error(ctx, i18n, var_id)
        if slug is None:
            return spec_or_error["error"]
        try:
            old, new = await adjust_modvar(self._services.documents, ctx.chat_key, slug, delta)
            return i18n.t(
                "modvars.tools.adjust.done",
                label=label_for(spec_or_error, ctx.locale),
                id=slug,
                old=old,
                new=new,
                delta=delta,
            )
        except Exception as exc:
            return i18n.t("modvars.tools.failed", error=str(exc))

    @tool
    async def remove_variable(self, ctx: AgentCtx, var_id: str) -> str:
        """Remove a module variable entirely (its spec and value). Only do this when the tracker
        is truly finished mattering — for a value that merely stops changing, just leave it.

        Args:
            var_id: The variable's id, as defined via define_variable.

        Returns:
            Confirmation of the removal, or an error naming the problem.
        """
        i18n = self._i18n(ctx)
        slug, spec_or_error = await self._known_or_error(ctx, i18n, var_id)
        if slug is None:
            return spec_or_error["error"]
        try:
            await remove_modvar(self._services.documents, ctx.chat_key, slug)
            return i18n.t("modvars.tools.remove.done", label=label_for(spec_or_error, ctx.locale), id=slug)
        except Exception as exc:
            return i18n.t("modvars.tools.failed", error=str(exc))


class MvuStatTools:
    """AI-KP tools for the imported MVU variable tree (`core.mvu_compat`).

    A SillyTavern card built on the MVU framework declares nested variables via its [InitVar]
    entry; import stores them as this room's stat tree. These tools are the function-calling
    channel onto that tree (the card's own `<UpdateVariable>` text-block protocol also works —
    `agent.loop` parses and applies it — but tool calls are the preferred, schema-checked path).
    Engine-native flat trackers live in `ModuleVarTools` above; this class is only for the
    nested, card-defined tree.
    """

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool
    async def get_stat(self, ctx: AgentCtx, path: str = "") -> str:
        """Read the imported card's variable tree (MVU stat data), either one value or the
        whole flattened tree. Prefer the always-on state in your context; this is the
        read-on-demand path for double-checking.

        Args:
            path: Dot-separated variable path (e.g. "理.好感度"); empty returns every leaf.

        Returns:
            The value (or the flattened path list), or an empty-state notice.
        """
        i18n = self._i18n(ctx)
        try:
            documents = self._services.documents
            if not await mvu_has_data(documents, ctx.chat_key):
                return i18n.t("modvars.stat.empty")
            if path.strip():
                leaves = await mvu_flatten(documents, ctx.chat_key, 512)
                wanted = path.strip()
                for leaf in leaves:
                    if leaf["path"] == wanted:
                        return i18n.t("modvars.stat.get.value", path=wanted, value=leaf["value"])
                return i18n.t("modvars.stat.get.missing", path=wanted)
            leaves = await mvu_flatten(documents, ctx.chat_key, 100)
            lines = [i18n.t("modvars.stat.get.header")]
            lines.extend(
                i18n.t("modvars.stat.get.item", path=leaf["path"], value=leaf["value"]) for leaf in leaves
            )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("modvars.stat.failed", error=str(exc))

    @tool
    async def set_stat(self, ctx: AgentCtx, path: str, value: str, reason: str = "") -> str:
        """Set one value in the imported card's variable tree (MVU stat data) when play changes
        it — the deterministic bookkeeping behind the card's trackers. Numbers, true/false, and
        quoted JSON parse as themselves; anything else stores as text.

        Args:
            path: Dot-separated variable path (e.g. "理.情绪状态.pleasure").
            value: The new value, as text (e.g. "0.4", "true", "教堂").
            reason: Optional note on why, for your own bookkeeping; not required.

        Returns:
            Confirmation with the old and new values, or an error naming the problem.
        """
        i18n = self._i18n(ctx)
        try:
            from core.mvu_compat import apply_set, leaf_value

            documents = self._services.documents
            tree = await load_mvu(documents, ctx.chat_key)
            parsed = _parse_stat_value(value)
            old = _stat_at(tree, path.strip())
            new_tree = apply_set(tree, path.strip(), parsed)
            await save_mvu(documents, ctx.chat_key, new_tree)
            shown_old = leaf_value(old) if isinstance(old, list) else old
            return i18n.t("modvars.stat.set.done", path=path.strip(), old=shown_old, new=parsed)
        except Exception as exc:
            return i18n.t("modvars.stat.failed", error=str(exc))

    @tool
    async def adjust_stat(self, ctx: AgentCtx, path: str, delta: float, reason: str = "") -> str:
        """Nudge a numeric value in the imported card's variable tree by a signed delta.

        Args:
            path: Dot-separated variable path to a number (e.g. "理.好感度").
            delta: Signed change to apply (e.g. 2, -0.1).
            reason: Optional note on why, for your own bookkeeping; not required.

        Returns:
            Confirmation with the old and new values, or an error naming the problem.
        """
        i18n = self._i18n(ctx)
        try:
            from core.mvu_compat import apply_add

            documents = self._services.documents
            tree = await load_mvu(documents, ctx.chat_key)
            old = _stat_leaf(tree, path.strip())
            new_tree = apply_add(tree, path.strip(), delta)
            await save_mvu(documents, ctx.chat_key, new_tree)
            new = _stat_leaf(new_tree, path.strip())
            return i18n.t("modvars.stat.adjust.done", path=path.strip(), old=old, new=new, delta=delta)
        except Exception as exc:
            return i18n.t("modvars.stat.failed", error=str(exc))


def _parse_stat_value(value: str):
    text = value.strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text


def _stat_at(tree, path: str):
    from core.varspace import resolve_tree_path

    return resolve_tree_path(tree, path)


def _stat_leaf(tree, path: str):
    from core.mvu_compat import is_value_with_desc, leaf_value

    node = _stat_at(tree, path)
    return leaf_value(node) if is_value_with_desc(node) else node
