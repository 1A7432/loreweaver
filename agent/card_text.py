"""Consumption-time rendering of SillyTavern-card-derived prose for sub-actor prompts.

Imported card fields (description/personality -> ``NpcRecord.persona``, tags -> ``playstyle``,
...) routinely contain EJS templates and ``{{user}}``/``{{char}}`` macros written for the
ST-Prompt-Template extension. The stored record keeps the RAW authored text (so it always
evaluates against the CURRENT room variables); this module renders it at the moment an actor
prompt is assembled (`agent.npc_actor` / `agent.companion_actor`), never at import time.

RED LINE (iron rule #3 -- information isolation): everything rendered here resolves through the
PLAYER view of the room's variable state (the same filter as
``core.varspace.load_resolver(..., player_view=True)``), and the full-EJS engine -- when
``settings.enable_full_ejs`` is on -- is fed ONLY the player-visible modvars, the MVU tree
(which has no visibility concept upstream), and an EMPTY worldinfo map. An NPC/companion actor
must never observe keeper-only variables or the room worldbook through a card template; a
template branch that reads a keeper-only variable behaves exactly as if it were unset.

Rendering here is READ-ONLY: template ``setvar()``/``incvar()`` writes are deliberately
DISCARDED (subset path: ``setter=None`` so statements no-op; full engine: ``pending_writes``
is never read back). Only the main Keeper prompt lane (`agent.prompt_builder`) flushes
template writes to the store -- an actor voicing a line must not mutate room state.

FAIL-SAFE: raw ``<% %>`` syntax never reaches the LLM. The full engine (built lazily, AT MOST
ONCE per renderer, i.e. per actor turn) degrades to the `core.ejs_lite` subset on any error,
and the subset itself degrades to tag-stripped plain text -- never to raw template syntax.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agent.services import Services
from core.documents import MODVARS_ID, PLAYER_VIEWER
from core.ejs_full import EjsFullError, FullEjsEngine, create_full_engine
from core.ejs_lite import render as render_subset
from core.ejs_lite import substitute_macros
from core.modvars import MODVARS_DOC_TYPE
from core.mvu_compat import load_mvu
from core.varspace import build_resolver, modvar_values_from_view

# Mirrors `net.state.resolve_active_character`'s sentinel (agent must not import net):
# `CharacterManager.get_character` resolves an unset active-character pointer to a fresh,
# unsaved sheet named "default", so that name means "no character bound".
_UNSET_CHARACTER_NAME = "default"


async def _active_character_name(services: Services, uid: str, chat_key: str) -> str:
    """`uid`'s active character name for `chat_key`, or "" when unset/unreadable.

    Reimplements the tolerant lookup of `net.state.resolve_active_character` (best-effort:
    a failed lookup and the `"default"` sentinel both mean "unset").
    """
    try:
        sheet = await services.characters.get_character(uid, chat_key)
    except Exception:
        return ""
    if not sheet or not sheet.name or sheet.name == _UNSET_CHARACTER_NAME:
        return ""
    return sheet.name


async def build_card_text_renderer(
    services: Services,
    chat_key: str | None,
    *,
    char_name: str,
    user_uid: str | None = None,
) -> Callable[[str], str]:
    """Build the one render step an actor prompt build applies to card-derived prose.

    Loads the room's variable state ONCE (player view -- see the module docstring's red line)
    and returns a pure synchronous ``render(text) -> str`` closure that:

    1. renders EJS templates when the text contains ``<%`` -- via the full QuickJS engine when
       ``settings.enable_full_ejs`` is on and available, else the fail-safe `core.ejs_lite`
       subset (also the fallback for any full-engine error);
    2. then substitutes ST macros: ``{{getvar::x}}``/``{{var:x}}`` through the player-view
       resolver, ``{{char}}`` -> the actor's own name, ``{{user}}`` -> `user_uid`'s active
       character name. With no meaningful `user_uid` (or no bound character) ``{{user}}`` is
       left untouched (`substitute_macros` skips names mapped to "").

    ``chat_key=None`` (a caller with no room context) still strips/renders templates fail-safe
    against an empty variable space -- raw ``<% %>`` must never reach the LLM from any path.
    """
    player_values: dict[str, Any] = {}
    mvu_tree: dict[str, Any] = {}
    if chat_key:
        # The PLAYER projection of the modvars document feeds both the subset resolver and
        # the full engine's flat_variables (one document read, structurally identical views).
        # Keeper-only modvars never reach either renderer — the projection dropped them.
        view = await services.documents.get_view(chat_key, MODVARS_DOC_TYPE, MODVARS_ID, PLAYER_VIEWER)
        player_values = modvar_values_from_view(view)
        mvu_tree = await load_mvu(services.documents, chat_key)
    resolve = build_resolver(player_values, mvu_tree)

    user_name = ""
    if chat_key and user_uid:
        user_name = await _active_character_name(services, user_uid, chat_key)
    names = {"user": user_name, "char": char_name}

    full_ejs_enabled = bool(chat_key) and services.settings.enable_full_ejs
    # Lazily built on the first `<%` text, AT MOST ONCE per renderer (== per actor turn);
    # holds `None` after a failed build so we don't retry per field.
    engine_slot: list[FullEjsEngine | None] = []

    def _engine() -> FullEjsEngine | None:
        if not engine_slot:
            # worldinfo={} -- actors do not get the room worldbook (knowledge isolation).
            engine_slot.append(create_full_engine(flat_variables=player_values, tree=mvu_tree, worldinfo={}))
        return engine_slot[0]

    def render(text: str) -> str:
        if not text:
            return text
        rendered = text
        if "<%" in rendered:
            result: str | None = None
            if full_ejs_enabled:
                engine = _engine()
                if engine is not None:
                    try:
                        result = engine.render(rendered).text
                        # engine.pending_writes is deliberately NOT read back: actor-side
                        # rendering is read-only; only the Keeper lane flushes template writes.
                    except EjsFullError:
                        result = None  # degrade to the subset -- never raw syntax out
            if result is None:
                # setter=None: setvar/incvar/decvar statements no-op (read-only rendering).
                result = render_subset(rendered, resolve).text
            rendered = result
        rendered = substitute_macros(rendered, resolve, names)
        # Last-resort scrub: a DANGLING `<%`/`%>` (no closing marker -- not a parseable tag)
        # passes through both renderers as plain text. On the actor path no template syntax
        # may reach the model at all, so any survivor -- including one a `<#escape-ejs>`
        # block deliberately restored -- is dropped, keeping the surrounding prose.
        if "<%" in rendered or "%>" in rendered:
            rendered = rendered.replace("<%", "").replace("%>", "")
        return rendered

    return render
