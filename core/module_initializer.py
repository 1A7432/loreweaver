"""Module (adventure/scenario) initialization: full-text LLM analysis into
keeper/player knowledge pools.

Ported from ``nekro_trpg_dice_plugin``'s ``core/module_initializer.py`` per
the M1 spec (``docs/specs/M1.md`` §5). The module's full text is handed to
the LLM in one shot (vector-store chunking is for retrieval only —
initialization always reassembles the full text first), parsed into a
structured analysis, and split into a keeper-only knowledge pool (full
secrets: NPC ``secret``, scene ``keeper_notes``, ``truths``, ``threats``,
``timeline``) and a player-safe knowledge pool (spoiler-free subset). Only
two things differ from the source:

- ``gen_openai_chat_response`` (a nekro-framework global) is replaced by the
  injected ``infra.llm.LLMClient``'s ``chat()``, called with
  ``temperature=0.3`` and ``model=settings.llm.analysis_model or
  settings.llm.chat_model``;
- the analysis prompt's *framing* text is localized (``module.analysis_prompt``,
  via the injected ``infra.i18n.I18n``) while the JSON schema it instructs the
  model to emit (``_ANALYSIS_JSON_SCHEMA`` below) is a fixed contract, not
  re-localized per locale — the model must always emit these exact field
  names regardless of the operator's chosen locale.

``_build_knowledge_pools`` and ``_fallback_full_analysis`` are ported
byte-for-byte per the source's data shapes, including their literal Chinese
default values (e.g. the fallback's ``"探索"`` focus / ``"场景{i+1}"`` scene
name). These are TRPG *game data* defaults, the same sanctioned exemption
`core.character_manager`'s skill names and
`core.prompt_sections.summarize_knowledge_item`'s glue literals use (see
those modules' docstrings) — not user-facing UI text, so they stay literal
instead of going through i18n.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from infra.config import Settings
from infra.i18n import I18n
from infra.llm import LLMClient
from infra.store import Store
from infra.usage_stats import record_usage_stats

logger = logging.getLogger(__name__)

# An optional progress reporter the gateway may pass in to surface import STAGES to
# the room while a slow full-module analysis runs. Core only SIGNALS a stage id (+
# an opaque detail string); the gateway formats + publishes it. Best-effort: a
# progress hiccup must never fail the import itself.
ProgressCb = Callable[[str, str], Awaitable[None]] | None


@dataclass(frozen=True)
class _AnalysisOutcome:
    analysis: dict
    used_fallback: bool = False
    error_summary: str = ""


def _exception_summary(exc: Exception) -> str:
    """Return a bounded diagnostic suitable for the module-init sidecar key."""
    message = str(exc).strip()
    summary = f"{type(exc).__name__}: {message}" if message else type(exc).__name__
    return summary[:1000]


async def _emit(progress: ProgressCb, stage: str, detail: str = "") -> None:
    if progress is None:
        return
    try:
        await progress(stage, detail)
    except Exception:
        pass

# Fields every analysis dict (LLM-produced or fallback) is normalized to
# carry, per the M1 spec's data shape: scenes/npcs/clues/timeline/background/
# threats/truths/opening_facts/summary.
_LIST_FIELDS = ("scenes", "npcs", "clues", "timeline", "threats", "truths", "opening_facts")
_STR_FIELDS = ("background", "summary")

# Cheap safety cap on how much module text gets sent to the LLM in one prompt
# (~1 token/CJK-char, generous margin for the framing text + a large-context
# analysis model). Not part of the source's data shape, just an input guard.
_MAX_ANALYSIS_CHARS = 400_000

_CODE_FENCE_PREFIX_RE = re.compile(r"^```[a-zA-Z]*\s*")
_CODE_FENCE_SUFFIX_RE = re.compile(r"\s*```$")

# The fixed JSON-schema contract the analysis prompt instructs the model to
# emit. Deliberately NOT routed through i18n (see the module docstring): it
# is machine-format instruction, not user-visible text, and must stay
# byte-identical regardless of the operator's locale so downstream parsing
# (`_build_knowledge_pools`) can rely on fixed field names.
_ANALYSIS_JSON_SCHEMA = """{
    "scenes": [
        {
            "name": "scene name (e.g. 'Abandoned Hospital Lobby')",
            "focus": "the scene's current focus (explore/negotiate/chase/combat/horror/stealth/rest - pick the single best fit)",
            "description": "player-visible description (appearance, layout, atmosphere - no spoilers)",
            "keeper_notes": "keeper-only background (hidden rooms, traps, an NPC's true location, danger warnings, etc. - never tell players)",
            "npcs_present": ["names of NPCs present in this scene"],
            "clues": [
                {
                    "name": "clue name",
                    "description": "what the clue reveals",
                    "discovery_method": "how it is found (e.g. a Spot Hidden roll, searching the room, talking to an NPC)"
                }
            ]
        }
    ],
    "npcs": [
        {
            "name": "NPC's full name",
            "description": "outward description (appearance, clothing, mannerisms, accent - anything players can directly observe)",
            "secret": "hidden information (true motive, connection to the case, dark secret, real identity)",
            "role": "the NPC's role in the module (e.g. client, suspect, victim, antagonist)"
        }
    ],
    "clues": [
        {
            "name": "clue name",
            "description": "clue content",
            "location": "the scene or NPC where it is found",
            "leads_to": "what it points to (e.g. the next scene, a truth, an NPC)"
        }
    ],
    "timeline": [
        {"time": "point in time", "event": "what happens", "involved": ["NPCs involved"]}
    ],
    "background": "the module's background story (setting, history, how the situation came about)",
    "threats": [
        {
            "name": "threat name (e.g. 'Feral Dog Pack Leader')",
            "type": "monster/NPC/environmental/trap",
            "description": "outward description (features players can see)",
            "stats": {"HP": "hit points", "STR": "strength", "CON": "constitution", "DEX": "dexterity", "SIZ": "size"},
            "attacks": ["attack forms (e.g. 'bite 1d6+db')"],
            "san_loss": "Sanity loss (e.g. '0/1d6')",
            "special_abilities": "special abilities (e.g. pack tactics, cannot be tamed)",
            "location": "where it appears"
        }
    ],
    "truths": [
        {
            "name": "truth name",
            "description": "the full behind-the-scenes truth",
            "revealed_by": "which clues/scenes reveal it"
        }
    ],
    "opening_facts": [
        "a fact the investigators already know at the start of the module",
        "another opening fact"
    ],
    "summary": "a one-sentence summary of the module (under 30 words)"
}"""


def _extract_json_object(content: str, i18n: I18n) -> dict:
    """Best-effort JSON-object extraction from a raw LLM response.

    Tolerates markdown code fences and leading/trailing commentary around
    the JSON payload: fences are stripped, then a direct `json.loads` of the
    remaining text is tried, falling back to slicing out the first ``{`` ..
    last ``}`` span and parsing that. Raises `ValueError` — caught by
    `ModuleInitializer._analyze_full_text`, which falls back to
    `_fallback_full_analysis` — if no JSON object can be recovered either way.
    """
    text = _CODE_FENCE_SUFFIX_RE.sub("", _CODE_FENCE_PREFIX_RE.sub("", content.strip())).strip()

    candidates = [text]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidates.append(text[start : end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed

    raise ValueError(i18n.t("module.analysis_no_json_found"))


class ModuleInitializer:
    """Background LLM-driven full-text module analysis.

    Reads a module's full text (previously uploaded/stored), asks the LLM to
    structure it into scenes/NPCs/clues/timeline/background/threats/truths/
    opening_facts/summary, and splits the result into a keeper-only
    knowledge pool (full secrets) and a player-safe knowledge pool
    (spoiler-free subset) — see the module docstring for the full contract.
    """

    def __init__(self, store: Store, vector_db: Any, llm: LLMClient, settings: Settings, i18n: I18n) -> None:
        self.store = store
        # Duck-typed: only `list_all_chunks(chat_key, limit=...)` is used
        # (shaped like `core.document_manager.VectorDatabaseManager`), and
        # only as a fallback when no `module_fulltext.{chat_key}` is stored.
        # May be `None` if the caller never wires a vector store up.
        self.vector_db = vector_db
        self.llm = llm
        self.settings = settings
        self.i18n = i18n

    async def initialize(self, chat_key: str, progress: ProgressCb = None) -> None:
        """Run (or skip, if already running) full-module analysis for `chat_key`.

        Orchestrates: read the stored module full text (or reassemble it
        from vector-store chunks) -> analyze (LLM, falling back to the
        offline heuristic on any failure) -> build the keeper/player
        knowledge pools -> persist them -> mark `module_init_status.{chat_key}`
        `"ready"` or `"ready_fallback"`. Sets `"failed"` instead if there is
        nothing to analyze, or if persistence itself raises. Diagnostics live
        separately under `module_init_error.{chat_key}`.
        A concurrent call while one is already `"processing"` is a no-op.
        """
        status_key = f"module_init_status.{chat_key}"
        error_key = f"module_init_error.{chat_key}"

        current_status = await self.store.get(user_key="", store_key=status_key)
        if current_status == "processing":
            return

        await self.store.set(user_key="", store_key=status_key, value="processing")
        try:
            full_text, doc_name = await self._load_full_text(chat_key)
            if not full_text:
                await self.store.set(user_key="", store_key=error_key, value="module text unavailable")
                await self.store.set(user_key="", store_key=status_key, value="failed")
                return

            # An uploaded module owns its own timeline. Clear the prior module's
            # clock as soon as the new source text is confirmed, before the
            # potentially slow analysis can leave stale dates in the sidebar.
            await self.store.delete(user_key="", store_key=f"game_clock.{chat_key}")
            await _emit(progress, "analyze")
            outcome = await self._analyze_full_text(full_text, doc_name, chat_key)
            await _emit(progress, "build")
            keeper_pool, player_pool = self._build_knowledge_pools(outcome.analysis)
            keeper_json = json.dumps(keeper_pool, ensure_ascii=False)

            await self.store.set(
                user_key="",
                store_key=f"module_keeper_pool.{chat_key}",
                value=keeper_json,
            )
            await self.store.set(
                user_key="",
                store_key=f"module_player_pool.{chat_key}",
                value=json.dumps(player_pool, ensure_ascii=False),
            )
            # Keep the lazily-read catalog synchronized with the new keeper
            # pool in this same initialization pass, rather than allowing a
            # stale catalog from the previous module to survive.
            await self.store.set(user_key="", store_key=f"module_catalog.{chat_key}", value=keeper_json)
            if outcome.used_fallback:
                await self.store.set(user_key="", store_key=error_key, value=outcome.error_summary)
                status = "ready_fallback"
            else:
                await self.store.delete(user_key="", store_key=error_key)
                status = "ready"
            await self.store.set(user_key="", store_key=status_key, value=status)
        except Exception as exc:
            summary = _exception_summary(exc)
            logger.exception("module initialization failed for chat_key=%s", chat_key)
            await self.store.set(user_key="", store_key=error_key, value=summary)
            await self.store.set(user_key="", store_key=status_key, value="failed")

    async def _load_full_text(self, chat_key: str) -> tuple[str, str]:
        """Return `(full_text, doc_name)` for `chat_key`.

        Prefers the pre-assembled `module_fulltext.{chat_key}` store key;
        falls back to reassembling `self.vector_db`'s stored chunks (sorted
        by filename then chunk index, matching upload order) when that key
        is unset. Returns `("", "")` if neither source has anything.
        """
        stored = await self.store.get(user_key="", store_key=f"module_fulltext.{chat_key}")
        if stored:
            return stored, self.i18n.t("module.default_document_name")

        if self.vector_db is None:
            return "", ""

        chunks = await self.vector_db.list_all_chunks(chat_key, limit=1000)
        if not chunks:
            return "", ""

        chunks = sorted(chunks, key=lambda c: (c.get("filename", ""), c.get("chunk_index", 0)))
        full_text = "\n\n".join(c.get("text", "") for c in chunks)
        doc_name = chunks[0].get("filename") or self.i18n.t("module.default_document_name")
        return full_text, doc_name

    async def _analyze_full_text(self, full_text: str, doc_name: str, chat_key: str) -> _AnalysisOutcome:
        """Analyze with one retry, then return an explicit fallback outcome."""
        prompt = self._build_analysis_prompt(full_text, doc_name)
        model = self.settings.llm.analysis_model or self.settings.llm.chat_model

        last_error = ""
        for attempt in range(2):
            try:
                result = await self.llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.3,
                    model=model,
                )
                # A response consumed provider tokens even when its JSON is
                # malformed, so account for usage before parsing it.
                await record_usage_stats(self.store, chat_key, result.usage, model=model)
                analysis = _extract_json_object(result.content or "", self.i18n)
                for field in _LIST_FIELDS:
                    analysis.setdefault(field, [])
                for field in _STR_FIELDS:
                    analysis.setdefault(field, "")
                return _AnalysisOutcome(analysis=analysis)
            except Exception as exc:
                last_error = _exception_summary(exc)
                logger.warning(
                    "module analysis attempt %d/2 failed for chat_key=%s: %s",
                    attempt + 1,
                    chat_key,
                    last_error,
                    exc_info=True,
                )

        return _AnalysisOutcome(
            analysis=self._fallback_full_analysis(full_text),
            used_fallback=True,
            error_summary=last_error,
        )

    def _build_analysis_prompt(self, full_text: str, doc_name: str) -> str:
        """Render the full-text analysis prompt sent to the LLM: localized
        framing text (`module.analysis_prompt`) wrapping the fixed JSON
        schema contract the model must emit (`_ANALYSIS_JSON_SCHEMA`)."""
        truncated = full_text[:_MAX_ANALYSIS_CHARS]
        return self.i18n.t(
            "module.analysis_prompt",
            doc_name=doc_name or self.i18n.t("module.default_document_name"),
            full_text=truncated,
            schema=_ANALYSIS_JSON_SCHEMA,
        )

    def _fallback_full_analysis(self, text: str) -> dict:
        """Offline heuristic analysis used when the LLM call fails or returns
        unparsable JSON: no LLM, just paragraph-splitting + truncation.

        Ported verbatim (data shape and literal defaults) from the source's
        ``_fallback_full_analysis`` — see the module docstring.
        """
        paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 50]
        scenes = []
        for i, para in enumerate(paragraphs[:20]):
            scenes.append(
                {
                    "name": f"场景{i + 1}",
                    "focus": "探索",
                    "description": para[:200],
                    "keeper_notes": "",
                    "npcs_present": [],
                    "clues": [],
                }
            )

        return {
            "scenes": scenes,
            "npcs": [],
            "clues": [],
            "timeline": [],
            "background": text[:500] if len(text) > 500 else text,
            "threats": [],
            "truths": [],
            "summary": text[:100] if len(text) > 100 else text,
        }

    def _build_knowledge_pools(self, analysis: dict) -> tuple[dict, dict]:
        """Split `analysis` into `(keeper_pool, player_pool)`.

        Ported verbatim (data shape) from the source's
        ``_build_knowledge_pools`` — see the module docstring. Notably:
        `player_pool["clues"]` starts (and stays) empty — clues are unlocked
        into it one at a time during play (an agent-layer concern, M1 §6.3's
        `unlock_for_player` tool) — while scene-local clues are immediately
        player-visible via each scene's own `"clues"` list.
        """
        keeper_pool: dict[str, Any] = {
            "scenes": [],
            "npcs": [],
            "clues": [],
            "truths": [],
            "timeline": [],
            "background": analysis.get("background", ""),
            "summary": analysis.get("summary", ""),
        }
        player_pool: dict[str, Any] = {
            "scenes": [],
            "npcs": [],
            "clues": [],
            "background": analysis.get("background", ""),
            "summary": analysis.get("summary", ""),
        }

        # scenes: keeper gets the full scene (incl. keeper_notes), player
        # only the spoiler-free fields.
        for scene in analysis.get("scenes", []):
            keeper_pool["scenes"].append(scene)
            player_pool["scenes"].append(
                {
                    "name": scene.get("name", ""),
                    "focus": scene.get("focus", "探索"),
                    "description": scene.get("description", ""),
                    "npcs_present": scene.get("npcs_present", []),
                    "clues": [
                        {
                            "name": c.get("name", ""),
                            "description": c.get("description", ""),
                            "discovery_method": c.get("discovery_method", ""),
                        }
                        for c in scene.get("clues", [])
                    ],
                }
            )

        # npcs: keeper gets the full NPC (incl. secret), player only the
        # outward-visible fields.
        for npc in analysis.get("npcs", []):
            keeper_pool["npcs"].append(npc)
            player_pool["npcs"].append(
                {
                    "name": npc.get("name", ""),
                    "description": npc.get("description", ""),
                    "role": npc.get("role", ""),
                }
            )

        # clues (module-wide catalog): keeper only — player's copy is
        # unlocked incrementally during play, not seeded here.
        keeper_pool["clues"] = analysis.get("clues", [])

        # threats (combat stat blocks): keeper only, never player-visible.
        keeper_pool["threats"] = analysis.get("threats", [])

        # timeline, truths: keeper only.
        keeper_pool["timeline"] = analysis.get("timeline", [])
        keeper_pool["truths"] = analysis.get("truths", [])

        return keeper_pool, player_pool
