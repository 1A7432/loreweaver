"""Assembles the AI-KP system prompt for one turn from the ``core.prompt_sections``
section builders.

**Section order is STABLE HEAD → VOLATILE TAIL (P1, 2026-08-07).** Every section
still lands in ONE system prompt (iron rule #5 is untouched); only their order
changed, and it changed for a measurable reason. The 1.x order opened with the
archived-session recap and game state — the two things that change every single
turn — so each turn invalidated the whole downstream prefix: the module pool, the
rulepack expertise, the style layer and the skill bodies were re-read from scratch
every time, at full price. A 2026-08-07 long session burned 40% of a weekly quota
partly this way.

So the assembly is now two explicit halves (see :class:`SystemPrompt`):

- **stable head** — TRPG identity, system expertise, interaction style, the module
  knowledge pool, the preset layer, the enabled skill bodies, and the M18 rolling
  campaign summary (+ its keeper margin). These change when the ROOM's configuration
  changes (a module loads, a keeper enables a skill), or — for the summary — when a
  chronicle fold runs. This is the cacheable prefix.
- **volatile tail** — world lore (retrieval-dependent), live game state, relationship
  tracks, module variables, MVU leaves, scribe whispers, hook injections, and the rest
  of the M18 chronicle section (open threads + records recalled against this turn),
  which closes the tail.

Two properties were deliberately preserved through the move:

- the preset layer still precedes the skill bodies, so keeper-enabled skills remain
  the strongest STANDING directive, and the volatile tail's own instructional items
  (whispers, hook injections) still come last, so per-turn direction keeps recency;
- ``inject_document_context_prompt``'s knowledge pool sits at the END of the stable
  head, directly adjacent to the world lore it governs — the keeper-discipline and
  module-fidelity blocks it carries still read as framing for the lore below them.

Two nuances are worth knowing, and they are the same nuance twice: the rule for the
head is not "never changes", it is **does not change independently of an
invalidation that is already happening**.

- a room with NO initialized module pool falls back to vector search over raw
  uploads, and that text varies per turn, on nothing. Such a section is routed to
  the volatile tail instead, so the stable head stays honestly stable rather than
  nominally stable.
- the campaign summary DOES change — but only when a fold writes it, and a fold also
  moves ``campaign_summary.through_turn``, which makes ``agent.history.trim_folded``
  drop the front of the replayed history that very turn. The prefix was lost
  regardless; the summary merely rides an invalidation that has already happened,
  and is a cache read on every other turn. Open threads (``update_thread`` may fire
  any turn), the recalled records (re-retrieved every turn) and live state change
  ASYNCHRONOUSLY of any such event, so they stay in the tail: moving one of them up
  would blow the whole prefix at random.

``tests/agent/test_prompt_cache_layout.py`` is the oracle.

``i18n`` is rebound to ``ctx.locale`` so the whole prompt renders in the
caller's locale for this turn, independent of the process-wide default locale.

Whenever an initialized module knowledge pool exists,
``inject_document_context_prompt`` folds in the localized keeper-secrecy
discipline block (``prompt.keeper_discipline``) instructing the KP that
keeper-only material is for its own reasoning only and must never be quoted
to players; that instruction rides along automatically as part of this
assembly, it needs no special handling here.

KP skills (Layer B.1 — ``docs/plugins.md`` "Layer B") enabled for this room close
the stable head. This module reads the room's enabled-skill ids DIRECTLY off the
store (never importing ``gateway.ops`` — that would invert the layering; only
``core.skills`` is imported, which is below `agent`), tolerating a
missing/corrupt flag the same way ``gateway.ops.get_enabled_skills`` does. A
room with no skills enabled contributes nothing, so its prompt stays
byte-identical to a build with no skills layer at all.

Deterministic relationship tracks (``core.relationships`` — 好感/情欲, see iron
rule #1: the values are real code, only the narration around them is the model's
job) and module variables (``core.modvars`` — the same split: validated, clamped,
persisted values the model only narrates around) are live state and sit in the
volatile tail, read straight off the store the same inline way as the skills block
(never importing ``agent.kp_tools_relationships`` or ``gateway``). The Keeper sees
EVERY variable, with keeper-only ones carrying a localized never-reveal tag (iron
rule #3 — the transport-side filter in ``net.state`` is the structural guarantee;
this tag is the behavioral one). A room with neither contributes neither section,
not even an empty header.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass

from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, load_chain
from agent.services import Services
from core.dice_engine import DiceRoller
from core.ejs_full import create_full_engine
from core.ejs_lite import MacroContext
from core.modvars import describe_modvars, load_modvars
from core.mvu_compat import apply_set, flatten_leaves, load_mvu, save_mvu
from core.preset import style_bands
from core.preset_store import load_preset
from core.prompt_sections import (
    inject_document_context_prompt,
    inject_game_state_prompt,
    inject_interaction_style_prompt,
    inject_system_expertise_prompt,
    inject_trpg_system_prompt,
)
from core.relationships import RelationshipManager
from core.skills import load_skill
from core.table_habits import HABITS_DOC_TYPE, HABITS_ID, index_lines
from core.varspace import build_resolver
from core.worldbook import inject_world_lore_prompt

# How much of the room's conversation seeds the retrieval context (`_recent_transcript`).
_RECENT_CONTEXT_MESSAGES = 6
_RECENT_CONTEXT_MAX_CHARS = 2000


@dataclass(frozen=True)
class SystemPrompt:
    """ONE assembled prompt, split at its cache boundary (P1/M20 — module docstring).

    Iron rule #5's invariant is the single ASSEMBLER, not the message count: this is
    one object built in one place, and ``agent.loop`` decides where each half lands on
    the wire (M20 A1 puts the stable head in the system message and the volatile tail
    in a state message just before the player's, so the whole cacheable prefix —
    system + replayed history — stays byte-stable between folds).

    ``text`` is the two halves joined, for every caller that wants the prompt as one
    string (``build_system_prompt``, the doctor, tests).
    """

    stable: str
    volatile: str

    @property
    def text(self) -> str:
        return "\n\n".join(part for part in (self.stable, self.volatile) if part)


async def build_system_prompt(ctx: AgentCtx, services: Services) -> str:
    """The assembled system prompt as one string — see :func:`build_system_prompt_parts`."""
    return (await build_system_prompt_parts(ctx, services)).text


async def habit_index(services, chat_key: str) -> list[str]:
    """The resident one-line summaries of this table's learned habits (`[]` when none)."""
    try:
        document = await services.documents.get(chat_key, HABITS_DOC_TYPE, HABITS_ID)
    except Exception:  # noqa: BLE001 — a missing/broken habits doc simply contributes nothing
        return []
    return index_lines(document.data) if document is not None else []


async def build_system_prompt_parts(
    ctx: AgentCtx, services: Services, *, advance_timers: bool = True
) -> SystemPrompt:
    """Build the full AI-KP system prompt for `ctx`'s current turn, split at its
    cache boundary.

    Calls the `core.prompt_sections` builders, folds in the M11 world-lore section
    (retrieved against the recent narrative/history, `role="keeper"` so the KP — and
    only the KP — also sees secret lore), and joins every non-empty result with
    `"\\n\\n"`, stable half first (module docstring).

    `advance_timers` drives the worldbook's sticky/cooldown/delay counter, which ticks
    once per injection pass. It is a parameter rather than a constant because M23 WS2
    re-assembles this prompt a second time within ONE turn after a context-overflow
    recovery fold: a rebuild is the same turn seen again, not a new one, and letting it
    tick would age every sticky window twice.
    """
    i18n = services.i18n.with_locale(ctx.locale)

    document_context = await inject_document_context_prompt(
        ctx, services.vector_db, services.store, i18n, services.settings.enable_vector_db
    )
    # World lore grounds the KP in the reusable world beneath this adventure; the tail of the
    # room's real conversation + this turn's user message (when threaded via ctx.extra) is the
    # retrieval context — see `_recent_transcript`.
    extra = getattr(ctx, "extra", {}) or {}
    recent_context = "\n".join(
        part
        for part in (await _recent_transcript(services, ctx), str(extra.get("user_message", "") or ""))
        if part
    )
    # One state load serves every conditioned/templated worldbook entry this turn: the closed
    # expression grammar resolves through `core.varspace`, and (when the `ejs` extra is
    # installed and enabled) one per-turn QuickJS sandbox runs full-EJS content against the
    # same snapshots. Template setvar() writes buffer in the engine and flush to the MVU tree
    # right after the lore section renders, so the variable sections below show post-template
    # state — the ST "evaluate at generate time" contract.
    modvar_state = await load_modvars(services.documents, ctx.chat_key)
    mvu_tree = await load_mvu(services.documents, ctx.chat_key)
    variable_resolver = build_resolver(modvar_state["values"], mvu_tree)
    engine = None
    if services.settings.enable_full_ejs:
        room_entries = await services.worldbook.list(ctx.chat_key)
        engine = create_full_engine(
            flat_variables=modvar_state["values"],
            tree=mvu_tree,
            worldinfo={entry.title: entry.content for entry in room_entries},
        )
    # M23 WS3: everything random that reaches the model is seeded from persisted state.
    from agent.chronicle import chronicle_turn

    replay_turn = await chronicle_turn(services.store, ctx.chat_key) + 1
    macros = await _build_macro_context(services, ctx, turn_rng(ctx.chat_key, replay_turn, "macros"))
    world_lore = await inject_world_lore_prompt(
        ctx,
        services.worldbook,
        i18n,
        role="keeper",
        recent_context=recent_context,
        resolve=variable_resolver,
        engine=engine,
        macros=macros,
        rng=turn_rng(ctx.chat_key, replay_turn, "worldbook"),
        advance_timers=advance_timers,  # the once-per-turn injection path drives sticky/cooldown/delay
        # Keeper-turn injection budget, tuned for imported module cards: their rule/timeline
        # entries are constant (a keeper world import preserves the flag) and a handful run
        # 2-5KB each, so the browse-path default (8 entries / 4000 chars) starves the module.
        # Oversized protocol/teaching blocks (10KB+) still stay out — `_cap_entries` skips
        # anything that alone exceeds the budget, which also keeps ST JSONPatch tutors from
        # steering the model off the engine's `_.set` wire.
        limit=12,
        budget_chars=12_000,
    )
    if engine is not None:
        mvu_tree = await _flush_template_writes(services, ctx.chat_key, engine, mvu_tree)

    # Card-imported module rooms (`.import … world`) have no knowledge pool, so the pool
    # section's keeper_discipline / module_fidelity blocks never fired for them — the
    # model ran whole imported modules with NEITHER block in context (2026-08-05 round-3
    # root cause: every discipline clause silently inapplicable). Fold both blocks in
    # ahead of the lore they govern — but ONLY for rooms that actually loaded a module
    # (the `world_import` marker the keeper's `.import … world` persists). A free-sandbox
    # room whose keeper `.lore add`ed a few setting notes gets plain lore, no
    # run-the-module directives: improvisation is the job there.
    if world_lore:
        world_imported = await services.store.state_get(ctx.chat_key, "world_import")
        if world_imported:
            discipline = i18n.t("prompt.keeper_discipline")
            if discipline not in document_context:
                world_lore = "\n\n".join([discipline, i18n.t("prompt.module_fidelity"), world_lore])

    # M18 campaign chronicle (agent.chronicle), split at the SAME cache boundary this
    # assembly is: the rolling campaign summary rides the stable head, open threads and
    # the topical recall ride the tail. See the module docstring for why a section that
    # changes may still sit in the head. A room with no chronicle yet contributes
    # neither half, so its prompt stays byte-identical to a pre-M18 build. KP-grade
    # throughout: keeper annotations ride here; player surfaces consume projections only.
    from agent.chronicle import build_chronicle_sections

    chronicle = await build_chronicle_sections(ctx, services, i18n, recent_context=recent_context)

    # --- STABLE HEAD: changes when the ROOM's configuration changes, not per turn ---
    stable: list[str] = [
        await inject_trpg_system_prompt(ctx, i18n),
        await inject_system_expertise_prompt(
            ctx, services.characters, i18n, default_system=services.settings.default_rulepack
        ),
        await inject_interaction_style_prompt(ctx, i18n),
    ]
    # The knowledge pool is a stored document — genuinely constant between turns. The
    # vector-search FALLBACK for a room with no initialized module is retrieval-driven
    # and is not; routing it to the tail keeps the head honestly stable instead of
    # nominally stable (an unstable section inside the head would invalidate the whole
    # prefix anyway, just invisibly).
    document_context_is_stable = await _module_pool_ready(services, ctx.chat_key)
    if document_context_is_stable:
        stable.append(document_context)

    # Imported-preset style layer (`.preset enable <id>`), four placement bands (see
    # `_enabled_preset_bands`). The head band folds before the skill bodies so
    # keeper-enabled skills still read as the stronger STANDING directive; the other
    # three ride the volatile tail below. One assembler — iron rule #5 stays intact.
    preset_bands = await _enabled_preset_bands(ctx, services, i18n)
    stable.append(preset_bands.get("head", ""))

    skill_bodies = await _enabled_skill_bodies(ctx, services)
    if skill_bodies:
        stable.append(i18n.t("prompt.skills_header") + "\n\n" + "\n\n".join(skill_bodies))

    # The campaign summary closes the head — the last thing before the replayed turns
    # it summarises, which is where narrative continuity reads best, and the position
    # that costs the least on a prefix-caching provider when the one non-fold writer of
    # this text (`.chronicle note`/`edit`) fires.
    stable.append(chronicle.stable)

    # --- VOLATILE TAIL: rebuilt most turns -------------------------------------
    volatile: list[str] = []
    if not document_context_is_stable:
        volatile.append(document_context)
    volatile.extend(
        [
            # The preset's world-info framing brackets the lore it was authored around.
            preset_bands.get("pre_lore", ""),
            world_lore,
            preset_bands.get("post_lore", ""),
            await inject_game_state_prompt(ctx, services.characters, services.store, i18n),
        ]
    )

    relationship_lines = await RelationshipManager(services.store).describe(ctx.chat_key, i18n)
    if relationship_lines:
        volatile.append(i18n.t("prompt.relationships_header") + "\n" + "\n".join(relationship_lines))

    # M20 E procedural memory: how THIS table plays. INDEX ONLY — the one-line summaries
    # ride every turn, the details do not. A habits document allowed to grow into the
    # prompt would become a fifth memory mechanism competing with the four that work; the
    # keeper reads the bodies on demand with `.habits`. Volatile because it is learned as
    # the campaign runs, and keeper-side because every line describes the players.
    habit_lines = await habit_index(services, ctx.chat_key)
    if habit_lines:
        volatile.append(i18n.t("prompt.table_habits") + "\n" + "\n".join(f"- {line}" for line in habit_lines))

    modvar_lines = await describe_modvars(services.documents, ctx.chat_key, i18n, ctx.locale)
    if modvar_lines:
        volatile.append(i18n.t("prompt.modvars_header") + "\n" + "\n".join(f"- {line}" for line in modvar_lines))

    # Imported MVU card variables (core.mvu_compat) — same fold-in pattern: the Keeper sees the
    # current tree every turn (post-template-writes — see above) and updates it via
    # set_stat/adjust_stat (or the card's own UpdateVariable protocol, which agent.loop applies
    # deterministically on the way out).
    mvu_leaves = flatten_leaves(mvu_tree, 100)
    if mvu_leaves:
        leaf_lines = "\n".join(f"- {leaf['path']} = {leaf['value']}" for leaf in mvu_leaves)
        volatile.append(i18n.t("prompt.mvu_header") + "\n" + leaf_lines)

    # The preset's post-history band — ST's position-critical slot, honored
    # faithfully (owner verdict 2026-08-15): the closest STANDING text to generation.
    # It still yields the very end to the engine's own per-turn direction below
    # (whispers, hook injections, the chronicle's recalled records) — standing
    # directives before per-turn ones is the recency order everything here follows.
    volatile.append(preset_bands.get("post_history", ""))

    # This turn's own direction goes LAST, keeping recency where it matters most.
    # Scribe whispers (agent.scribe): keeper-side bookkeeping reminders from the
    # post-turn reconciliation pass, consumed read-and-clear. Marker-gated by their
    # own existence — a room with nothing pending gets no section at all, and the KP
    # keeps full judgment over what to do with each note.
    from agent.scribe import pop_whispers

    whispers = await pop_whispers(services, ctx.chat_key)
    if whispers:
        volatile.append(i18n.t("prompt.scribe_notes") + "\n" + "\n".join(f"- {note}" for note in whispers))

    # Event-hook inject() texts for THIS turn (Layer C — agent.hook_runtime stashes them on
    # ctx.extra before this build; consumed per turn, never persisted).
    hook_injections = [text for text in (extra.get("hook_injections") or []) if isinstance(text, str)]
    if hook_injections:
        volatile.append(i18n.t("prompt.hooks_header") + "\n" + "\n".join(hook_injections))

    # The chronicle's volatile half (built above, with the head's): open threads and
    # the records recalled against this turn. Both move on their own schedule, so they
    # close the tail where the per-turn direction keeps recency.
    volatile.append(chronicle.volatile)

    return SystemPrompt(
        stable="\n\n".join(section for section in stable if section),
        volatile="\n\n".join(section for section in volatile if section),
    )


async def _recent_transcript(services: Services, ctx: AgentCtx) -> str:
    """The tail of this room's real conversation — half of the retrieval context.

    `recent_context` feeds two retrievals: worldbook lore matching and the M18
    chronicle's topical recall. Its other half is this turn's user message; this
    half is what the table was just talking about, which is what makes a lore
    entry keyed on a place or a person fire while the scene is still in it.

    Read straight off the append-only history tree (`agent.history.load_chain`),
    NOT `trim_folded`: a folded turn stopped being replayed, it did not stop
    being what just happened. Bounded twice — the last few messages, then the
    last characters of those — because a retrieval query is a query, not a
    context: a whole scene of prose buries the terms an entry is keyed on and
    costs an embedding call proportional to its length. Best-effort; a room with
    no history yet contributes nothing.
    """
    try:
        chain = await load_chain(services, ctx.chat_key, DEFAULT_HISTORY_KEY)
    except Exception:  # noqa: BLE001 — retrieval context is best-effort, never a turn's problem
        return ""
    tail = [str(message.get("content", "")).strip() for message in chain[-_RECENT_CONTEXT_MESSAGES:]]
    return "\n".join(part for part in tail if part)[-_RECENT_CONTEXT_MAX_CHARS:]


async def _module_pool_ready(services: Services, chat_key: str) -> bool:
    """Whether this room's document context comes from an initialized knowledge pool
    (a stored document, constant between turns) rather than per-turn vector search.

    Mirrors the precedence `core.prompt_sections.inject_document_context_prompt` applies;
    reading the same flag here is what lets the cache boundary be drawn honestly."""
    if not services.settings.enable_vector_db:
        return False
    try:
        return await services.store.state_get(chat_key, "module_init_status") in {"ready", "ready_fallback"}
    except Exception:  # noqa: BLE001 — an unreadable flag just means "treat it as volatile"
        return False


def turn_rng(chat_key: str, turn: int, stream: str) -> random.Random:
    """A per-turn RNG seeded from PERSISTED state only (M23 WS3).

    `{{random}}`/`{{pick}}` macro expansion and the worldbook's `probability` /
    inclusion-group rolls both reach the model, and both used to draw from an unseeded
    `random.Random()`. That made two model-visible inputs unreconstructable: an undo
    replay, a join replay, playtest forensics and the behavioural evals all silently
    lacked what the model actually saw. The seed is derived from the room's chat key and
    the turn now in flight — both already persisted, so nothing new has to be stored and
    the same room state always replays the same expansion.

    `stream` separates the consumers. One shared generator would work for replay too, but
    it would mean that adding a `{{random}}` macro anywhere shifts every worldbook
    probability roll after it; separate streams keep each lane's sequence its own.
    """
    digest = hashlib.sha256(f"{chat_key}\x00{turn}\x00{stream}".encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


async def _build_macro_context(services: Services, ctx: AgentCtx, rng: random.Random) -> MacroContext:
    """The per-turn ST-native macro context: `{{user}}` = the caller's active PC name (the
    `"default"` sentinel means unset — mirrors `net.state.resolve_active_character` without
    importing `net`), `{{time}}`/`{{date}}` = the GAME clock, `{{roll:...}}` = the real dice
    engine (iron rule #2), `{{random/pick:...}}` = real code randomness. `{{char}}` is bound
    statically at card import, so it is deliberately absent here. Best-effort throughout."""
    names: dict[str, str] = {}
    try:
        sheet = await services.characters.get_character(ctx.uid(), ctx.chat_key)
        if sheet is not None and sheet.name and sheet.name != "default":
            names["user"] = sheet.name
    except Exception:
        pass
    clock_time = ""
    try:
        raw = await services.store.state_get(ctx.chat_key, "game_clock")
        clock = json.loads(raw) if raw else {}
        if isinstance(clock, dict):
            clock_time = str(clock.get("current_time") or "")
    except Exception:
        pass
    roller = DiceRoller()

    def _roll(expression: str) -> str:
        return str(roller.roll_expression(expression).total)

    return MacroContext(names=names, clock_time=clock_time, rng=rng, roll=_roll)


async def _flush_template_writes(services: Services, chat_key: str, engine, mvu_tree: dict) -> dict:
    """Apply the full-EJS engine's buffered template `setvar` writes to the MVU tree through
    `core.mvu_compat.apply_set` (tolerant per write — one bad path never blocks the rest),
    persist once, and return the updated tree. A template with no writes is a no-op."""
    writes = engine.pending_writes
    if not writes:
        return mvu_tree
    for path, value in writes:
        try:
            mvu_tree = apply_set(mvu_tree, path, value)
        except (ValueError, TypeError):
            continue
    await save_mvu(services.documents, chat_key, mvu_tree)
    return mvu_tree


async def _enabled_preset_bands(ctx: AgentCtx, services: Services, i18n) -> dict[str, str]:
    """The imported-preset style layer for this room, folded into the four placement
    bands of `core.preset.style_bands` (the marker→section contract, v1) — each
    non-empty band rendered with the provenance header, empty dict when no preset.

    Reads the ``preset_enabled`` room_state flag inline off the store (the same
    layering rule as the skills block below: never import ``gateway.ops``). Where the
    bands land is this module's decision (iron rule #5 — one assembler): ``head``
    stays in the stable head before the skill bodies (the v0 position, so a
    marker-less preset builds byte-identically), ``pre_lore``/``post_lore`` bracket
    the world-lore section, and ``post_history`` closes in on generation late in the
    volatile tail — real geometry, because the tail rides the wire after the
    replayed history. Contributes nothing when no preset is enabled or the file is
    missing/broken — a bad preset never breaks a turn."""
    try:
        raw = await services.store.state_get(ctx.chat_key, "preset_enabled")
    except Exception:
        return {}
    preset_id = str(raw or "").strip()
    if not preset_id:
        return {}
    preset = load_preset(services.settings.data_dir, preset_id)
    if preset is None:
        return {}
    header = i18n.t("prompt.preset_header")
    return {
        band: header + "\n\n" + text if text else ""
        for band, text in style_bands(preset).items()
    }


async def _enabled_skill_bodies(ctx: AgentCtx, services: Services) -> list[str]:
    """Markdown bodies of every KP skill enabled for `ctx.chat_key`'s room, in
    enablement order. Reads the store flag inline (see module docstring) rather
    than importing `gateway.ops.get_enabled_skills`; an unknown skill id (already
    removed from `skills/`) is silently skipped via `load_skill` returning `None`.
    """
    raw = await services.store.state_get(ctx.chat_key, "skills_enabled")
    if not raw:
        return []
    try:
        skill_ids = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(skill_ids, list):
        return []

    bodies = []
    for skill_id in skill_ids:
        skill = load_skill(str(skill_id))
        if skill is not None:
            bodies.append(skill.body)
    return bodies
