"""Knowledge-domain AI-KP tools: module knowledge pools, document ingestion,
KP notes/clock, and session/battle-report recording.

Ported from ``nekro_trpg_dice_plugin``'s ``trpg_dice/plugin.py`` per the M1
spec (``docs/specs/M1.md`` §6.3): every tool body below is the corresponding
``@plugin.mount_sandbox_method`` function from that source, with
``_ctx``/globals swapped for ``ctx``/an injected ``agent.services.Services``
bundle, hardcoded Chinese UI strings routed through ``services.i18n``, and
``@tool``/``keeper_only`` replacing the source's AGENT/BEHAVIOR/TOOL method
types (a keeper_only tool's raw result is only ever meant to reach the model
as a ``role: tool`` message, never echoed straight back to a player).

Four provider classes, one per M1.md's tool grouping:
``ModuleTools`` (11, 7 keeper_only), ``DocumentTools`` (4), ``NoteTools``
(2), ``SessionTools`` (4, all prep-phase). Every keeper_only tool's return value is prefixed
with a localized ``kp_tools.know.keeper_banner`` reminder (in addition to
the system-prompt-level ``prompt.keeper_discipline`` block another module
installs) so the model is nudged at the exact point it reads secret
material, not only once at the top of its context.

Two deliberate deviations from a byte-for-byte port, both required because
this repo's ``core.module_initializer.ModuleInitializer`` (M1 §5, DONE/GREEN,
not modified here) persists a different shape than the legacy source:

- **No separate catalog copy at all (M17).** The source's v2 initializer
  wrote a *raw full-text analysis* dict to a ``module_catalog`` store key
  separately from the keeper/player pools derived from that same dict — a
  persisted derived copy that could only drift. Under the M17 document model
  the knowledge pools are ONE ``module_pool`` document (``data = {"keeper",
  "player"}``, keeper half = the catalog's exact fields), and
  ``ModuleTools._load_catalog`` below simply reads the document's keeper
  half, so the catalog-reading tools
  (``get_module_catalog``/``list_module_elements``/
  ``get_module_element_detail``/``get_module_summary``) can never go stale
  after an ``update_knowledge_pool`` patch. ``get_module_catalog`` itself
  renders a per-category directory (counts + names) instead of the source's
  per-chunk risk-level listing, since nothing in this port's data model
  produces chunk-level ``risk_level``/``spoiler_tags`` entries.
- **``query_knowledge_pool``'s search fields.** The source searched
  ``title``/``summary``/``keywords``/``spoiler_tags`` -- fields that only
  ever existed on the legacy per-chunk catalog, never on this port's
  scene/npc/clue/truth dicts (which use ``name``/``description``). Searching
  only the source's field names against this port's data would silently
  match nothing; ``query_knowledge_pool`` here falls back to
  ``name``/``description`` when ``title``/``summary`` are absent.

Determinism/robustness note carried over from the source, now load-bearing
for tests: every tool method catches its own exceptions and returns a
localized error string. ``agent.tools.Toolset.dispatch`` only catches
``ToolArgumentError``/``TypeError`` (bad/missing arguments); anything a tool
body itself raises would otherwise escape into the function-calling loop.

Where the M1 spec calls for reusing an existing deterministic helper instead
of the source's naive port, this module does: ``NoteTools.game_clock``'s
``advance`` action calls ``core.game_clock.advance_game_time`` (real
date/delta parsing with a readable-string fallback) rather than the source's
plain ``f"{current} → advance {delta}"`` concatenation.

i18n: every user-visible string here is looked up via ``services.i18n`` under
the ``kp_tools.know.*`` sub-namespace (``locales/{en,zh}/kp_tools.json`` --
shared with the sibling mechanics-tools module, hence the distinct
sub-namespace to avoid key collisions). Knowledge-pool/catalog *category*
names (``scenes``, ``npcs``, ``clues``, ``timeline``, ``threats``,
``truths``, ``summary``, ``background``) are left as literal, untranslated
field-name tokens when rendered as headers -- consistent with
``core.prompt_sections.inject_document_context_prompt``, which renders the
exact same categories the exact same way (``f"### {category}"``) -- since
they are the fixed JSON-schema contract's field names (see
``core/module_initializer.py``'s ``_ANALYSIS_JSON_SCHEMA``), not natural-
language UI text. The keeper-sensitive-content regex list
(``_KEEPER_SENSITIVE_PATTERNS``) and the query tokenizer's stop-word set
(``_QUERY_STOP_WORDS``) are likewise internal text-processing data, the same
sanctioned exemption ``core.document_manager``'s ``_CHUNK_BREAK_POINTS``
uses -- both are ported verbatim from the source (Chinese literals) with a
handful of English equivalents appended, since unlike ``_CHUNK_BREAK_POINTS``
these specifically exist to catch *natural-language* prompt-injection/
spoiler patterns in uploaded documents, and this repo's own module fixture
(``tests/fixtures/module_en.txt``) is English.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, load_chain
from agent.services import Services
from agent.tool_phase import CAPABILITY_MODULE_POOL
from agent.tools import tool
from core.battle_report import _default_session_name
from core.documents import KEEPER_VIEWER, MODULE_POOL_ID
from core.game_clock import advance_game_time, face_is_engine_readable, parse_time_delta
from core.module_initializer import ProgressCb, _emit
from infra.i18n import I18n
from infra.room_facets import STORAGE_DOCUMENTS, RoomStateFacet

# Document-type -> emoji, purely a decorative icon lookup keyed by an
# internal (English) data tag -- same sanctioned exemption as
# `core.prompt_sections._DOCUMENT_TYPE_EMOJI` (not natural-language text).
_DOC_TYPE_EMOJI = {
    "module": "\U0001f4d8",  # 📘
    "rule": "\U0001f4dc",  # 📜
    "story": "\U0001f4d6",  # 📖
    "background": "\U0001f30d",  # 🌍
}
_DEFAULT_DOC_EMOJI = "\U0001f4c4"  # 📄
_VALID_DOC_TYPES = ("module", "rule", "story", "background")
# Uploading one of these auto-triggers module-knowledge-pool initialization
# (and is the only case `module_fulltext.{chat_key}` gets (over)written --
# see the module docstring).
_MODULE_INIT_DOC_TYPES = ("module", "story")

# Query tokenizer stop words: ported verbatim from the source (Chinese
# function words) plus a few English equivalents for this repo's bilingual
# fixtures. Internal text-processing data, not user-visible UI text (see the
# module docstring).
_QUERY_STOP_WORDS = {
    "的", "了", "是", "在", "和", "或", "与", "及", "主要", "初始",
    "a", "an", "the", "of", "and", "or",
}

# KP-only sensitive-content detector for `search_documents` results: ported
# verbatim from the source (Chinese patterns) with English equivalents
# appended -- see the module docstring's second deviation note.
_KEEPER_SENSITIVE_PATTERNS = [
    # instructions attempting to change/bypass model behavior
    r"忽略之前.{0,10}规则", r"忽略所有.{0,10}指令", r"绕过.{0,10}限制",
    r"改变.{0,10}行为", r"展示完整.{0,10}真相", r"泄露.{0,10}秘密",
    r"ignore (all |any )?(previous|prior) (rules|instructions)",
    r"bypass.{0,10}(restrictions|rules|limits)",
    r"reveal.{0,10}(the )?(secret|truth|hidden)",
    # keeper-viewpoint markers
    r"守秘人[：:]", r"KP[：:]", r"幕后[：:]", r"真相[是:为]",
    r"秘密[：:]", r"隐藏.{0,5}信息", r"未触发", r"未来.{0,5}场景",
    r"后续.{0,5}事件", r"剧透", r"GM[：:]", r"DM[：:]",
    r"keeper('s)?[：:]", r"behind[- ]the[- ]scenes", r"spoiler",
    # monster/NPC stat blocks
    r"HP[=：]\d+", r"MP[=：]\d+", r"AC[=：]\d+", r"伤害加值",
    r"攻击加值", r"DB[=：]", r"体格[=：]",
    # check-outcome hints that could leak information early
    r"建议检定", r"应当检定", r"需要.{0,3}检定",
    r"成功后[：,.，。]", r"失败后[：,.，。]",
    r"若.{0,5}失败", r"若.{0,5}成功",
    r"on (a )?(success|failure)[:,.，。]", r"if (the )?(check|roll) (succeeds|fails)",
    # handout numbering
    r"展示材料\s*\d+", r"[Hh]andout\s*\d+",
]


async def _load_pools(services: Services, chat_key: str) -> dict[str, Any]:
    """The module knowledge-pool document's keeper-side view: ``{"keeper": …,
    "player": …}`` (``{}`` when no module has been initialized). These tools run
    on the keeper side of the table, so they read the FULL projection; every
    player-facing surface projects the same document with a player viewer."""
    view = await services.documents.get_view(chat_key, "module_pool", MODULE_POOL_ID, KEEPER_VIEWER)
    return view if isinstance(view, dict) else {}


async def _save_pools(services: Services, chat_key: str, keeper: dict, player: dict) -> None:
    await services.documents.put_singleton(chat_key, "module_pool", {"keeper": keeper, "player": player})


def _status_key(chat_key: str) -> str:
    return "module_init_status"


def _error_key(chat_key: str) -> str:
    return "module_init_error"


def _fulltext_key(chat_key: str) -> str:
    return "module_fulltext"


# kp_note categories that live on the player-visible `scene` singleton document
# instead of keeper-only `note` documents.
_SCENE_CATEGORIES = ("current_scene", "current_focus")


def _game_clock_key(chat_key: str) -> str:
    return "game_clock"


def _battle_report_key(chat_key: str, timestamp: str) -> str:
    return f"battle_report.{timestamp}"


def _deep_merge(base: dict, patch: dict) -> dict:
    """Recursively merge `patch` into `base`: nested dicts merge, lists concatenate, everything else overwrites."""
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        elif isinstance(value, list) and isinstance(base.get(key), list):
            base[key].extend(value)
        else:
            base[key] = value
    return base


def _find_by_name(items: list[Any], name: str) -> Any:
    """Exact-then-fuzzy (substring) case-insensitive lookup of `name`/`title` within `items`.

    Shared by `get_module_element_detail` and `unlock_for_player`, which the
    source duplicated byte-for-byte (see plugin.py's two identical
    exact-then-fuzzy loops).
    """
    name_lower = name.lower()
    exact = [item for item in items if isinstance(item, dict) and item.get("name", item.get("title", "")).lower() == name_lower]
    if exact:
        return exact[0]
    for item in items:
        item_name = item.get("name", item.get("title", "")) if isinstance(item, dict) else str(item)
        if name_lower in item_name.lower():
            return item
    return None


async def render_session_report(
    services: Services,
    ctx: AgentCtx,
    i18n: I18n,
    *,
    detailed: bool = False,
    session_name: str = "",
) -> tuple[str, str] | None:
    """Render the in-progress (or, failing that, the latest archived) session as a Markdown report and
    persist it, WITHOUT ending the session -- the players' keepsake / review export ("团报").

    Reuses ``services.battles.generator.generate_markdown_report``; it does not duplicate any rendering.
    ``detailed`` is what loads the room's real conversation (`agent.history.load_chain`) and hands it to
    the renderer, which is what makes the full report a TRANSCRIPT rather than a scoreboard. The current
    path only: a rewound room (M20 D) keeps its abandoned branches on disk, and a keepsake that showed
    the table a story it decided did not happen would be worse than no keepsake. `trim_folded` is
    deliberately NOT applied -- what a turn replays and what happened are different questions.

    The rendered Markdown is stored under the same ``battle_report.{chat_key}.{timestamp}`` key
    ``get_battle_report_markdown`` reads, and written best-effort to ``ctx.fs.shared_path`` (the exact
    shared-reports save path ``generate_session_report`` already uses).

    Returns ``(markdown, saved_note)`` -- ``saved_note`` is the localized "saved to {path}" line, or ``""``
    when no ``ctx.fs`` was available to write a file -- or ``None`` when there is no session to export.
    Shared by the ``export_report`` tool and the gateway ``.report`` command so neither duplicates the
    render/save flow.
    """
    generator = services.battles.generator
    record = await generator.get_current_session(ctx.chat_key)
    scope = "current"
    if record is None:
        record = await generator.get_latest_history(ctx.chat_key)
        scope = "latest"
    if record is None:
        return None

    name = session_name.strip()
    if not name:
        name = await services.store.state_get(ctx.chat_key, f"session_name.{scope}")
    if not name:
        name = _default_session_name(datetime.fromtimestamp(record.start_time), i18n)

    transcript = await load_chain(services, ctx.chat_key, DEFAULT_HISTORY_KEY) if detailed else None
    markdown = generator.generate_markdown_report(record, name, i18n=i18n, transcript=transcript)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    await services.store.state_set(ctx.chat_key, _battle_report_key(ctx.chat_key, timestamp), markdown)

    saved_note = ""
    if ctx.fs is not None:
        try:
            report_path = ctx.fs.shared_path / f"session_report_{timestamp}.md"
            report_path.write_text(markdown, encoding="utf-8")
            saved_note = i18n.t("kp_tools.know.session.export.saved_note", path=ctx.fs.forward_file(report_path))
        except Exception:
            pass  # best-effort file write; the markdown itself is still returned/stored above
    return markdown, saved_note


class _KnowledgeToolsBase:
    """Shared `__init__` + locale-binding helper for this module's four provider classes."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)


class ModuleTools(_KnowledgeToolsBase):
    """Module knowledge-pool tools: 7 keeper-only lookups over the analyzed module (the catalog/pools
    `services.module_init` builds), plus 4 non-keeper controls to patch the pools, unlock information to
    players, and manage (re-)initialization.
    """

    def _keeper_wrap(self, i18n: I18n, body: str) -> str:
        """Prefix a keeper-only tool's body with the localized reasoning-only banner."""
        return f"{i18n.t('kp_tools.know.keeper_banner')}\n\n{body}"

    async def _load_catalog(self, chat_key: str) -> dict | None:
        """Catalog view of the module: the knowledge-pool document's keeper half
        (the source of truth `core.module_initializer.ModuleInitializer`
        persists) — no mirrored copy exists to go stale, see the module
        docstring's first deviation note."""
        keeper = (await _load_pools(self._services, chat_key)).get("keeper")
        return keeper if isinstance(keeper, dict) and keeper else None

    @tool(keeper_only=True, prep_only=True, read_only=True)
    async def get_module_catalog(self, ctx: AgentCtx) -> str:
        """Get this chat's module catalog: a directory of every analyzed scene/NPC/clue/timeline/threat/
        truth (KEEPER-ONLY -- for the AI's own reasoning, never quote to players).

        Returns:
            The catalog's status plus a per-category name directory.
        """
        i18n = self._i18n(ctx)
        try:
            catalog = await self._load_catalog(ctx.chat_key)
            if not catalog:
                body = i18n.t("kp_tools.know.catalog.empty")
            else:
                status = await self._services.store.state_get(ctx.chat_key, _status_key(ctx.chat_key))
                lines = [i18n.t("kp_tools.know.catalog.header", status=status or i18n.t("kp_tools.know.status.unknown"))]
                for category in ("scenes", "npcs", "clues", "timeline", "threats", "truths"):
                    items = catalog.get(category) or []
                    if not items:
                        continue
                    lines.append("")
                    lines.append(i18n.t("kp_tools.know.catalog.category_line", category=category, count=len(items)))
                    for item in items:
                        name = item.get("name", item.get("title", "?")) if isinstance(item, dict) else str(item)
                        lines.append(f"  - {name}")
                if catalog.get("summary"):
                    lines.append("")
                    lines.append(i18n.t("kp_tools.know.catalog.summary_line", summary=catalog["summary"]))
                body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.catalog.failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(keeper_only=True, read_only=True, needs=CAPABILITY_MODULE_POOL)
    async def query_knowledge_pool(self, ctx: AgentCtx, query: str, pool_type: str = "keeper") -> str:
        """Search the module knowledge pool for a topic -- an NPC's truth, a scene's behind-the-scenes
        setting, already-unlocked clues, etc. (KEEPER-ONLY; results are for the AI's own reasoning).

        Args:
            query: Search keywords (space/comma-separated; matching ANY token is enough).
            pool_type: "keeper" searches the keeper-only pool (behind-the-scenes truths); "player" searches
                the player-unlocked pool.

        Returns:
            Matching knowledge-pool entries, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            if pool_type not in ("keeper", "player"):
                body = i18n.t("kp_tools.know.pool.invalid_type")
            else:
                pool_label = i18n.t(f"kp_tools.know.pool.label.{pool_type}")
                pool = (await _load_pools(self._services, ctx.chat_key)).get(pool_type)
                if not pool:
                    body = i18n.t("kp_tools.know.pool.missing", pool=pool_label)
                else:
                    tokens = [
                        token
                        for token in re.split(r"[\s,，、]+", query.lower())
                        if token.strip() and token.strip() not in _QUERY_STOP_WORDS and len(token.strip()) >= 2
                    ] or [query.lower().strip()]

                    matches = []
                    for category, items in pool.items():
                        if not isinstance(items, list):
                            continue
                        for item in items:
                            if not isinstance(item, dict):
                                continue
                            # `title`/`summary` for parity with the legacy per-chunk catalog shape;
                            # `name`/`description` for this port's actual scene/npc/clue/truth shape
                            # (see the module docstring's second deviation note).
                            searchable = " ".join(
                                [
                                    str(item.get("title", item.get("name", ""))),
                                    str(item.get("summary", item.get("description", ""))),
                                    " ".join(str(k) for k in item.get("keywords", [])),
                                    " ".join(str(t) for t in item.get("spoiler_tags", [])),
                                    str(item.get("tags", "")),
                                ]
                            ).lower()
                            if any(token in searchable for token in tokens):
                                matches.append({"category": category, **item})

                    if not matches:
                        body = i18n.t("kp_tools.know.pool.no_matches", pool=pool_label, query=query)
                    else:
                        lines = [
                            i18n.t("kp_tools.know.pool.results_header", pool=pool_label, query=query),
                            i18n.t("kp_tools.know.pool.results_count", count=len(matches)),
                            "",
                        ]
                        for index, match in enumerate(matches[:20], 1):
                            title = match.get("title", match.get("name", "?"))
                            lines.append(f"{index}. [{match['category']}] {title}")
                            summary = match.get("summary", match.get("description", ""))
                            if summary:
                                lines.append(i18n.t("kp_tools.know.pool.item_summary", summary=summary))
                            if match.get("keywords"):
                                lines.append(
                                    i18n.t("kp_tools.know.pool.item_keywords", keywords=", ".join(str(k) for k in match["keywords"]))
                                )
                            if match.get("spoiler_tags"):
                                lines.append(
                                    i18n.t("kp_tools.know.pool.item_spoiler", tags=", ".join(str(t) for t in match["spoiler_tags"]))
                                )
                            lines.append("")
                        if len(matches) > 20:
                            lines.append(i18n.t("kp_tools.know.pool.more_results", count=len(matches) - 20))
                        body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.pool.query_failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(keeper_only=True, prep_only=True, read_only=True)
    async def inspect_knowledge_pool(self, ctx: AgentCtx, pool_type: str = "keeper") -> str:
        """Dump a knowledge pool's raw contents (KEEPER-ONLY) -- use when query_knowledge_pool finds
        nothing, to see what the pool actually holds.

        Args:
            pool_type: "keeper" or "player".

        Returns:
            The pool's raw structure, one section per category.
        """
        i18n = self._i18n(ctx)
        try:
            if pool_type not in ("keeper", "player"):
                body = i18n.t("kp_tools.know.pool.invalid_type")
            else:
                pool_label = i18n.t(f"kp_tools.know.pool.label.{pool_type}")
                pool = (await _load_pools(self._services, ctx.chat_key)).get(pool_type)
                if not pool:
                    body = i18n.t("kp_tools.know.pool.missing", pool=pool_label)
                else:
                    background = str(pool.get("background", ""))
                    if len(background) > 200:
                        background = background[:200] + "..."
                    lines = [
                        i18n.t("kp_tools.know.inspect.header", pool=pool_label),
                        f"summary: {pool.get('summary', '')}",
                        f"background: {background}",
                        "",
                    ]
                    for category, items in pool.items():
                        if category in ("summary", "background") or not items:
                            continue
                        if isinstance(items, str):
                            lines.append(f"## {category}: {items}")
                            continue
                        lines.append(i18n.t("kp_tools.know.inspect.category_header", category=category, count=len(items)))
                        for item in items:
                            if isinstance(item, str):
                                lines.append(f"- {item}")
                                continue
                            lines.append(f"- {item.get('name', item.get('title', '?'))}")
                            for key, value in item.items():
                                if key in ("name", "title"):
                                    continue
                                if isinstance(value, list):
                                    if value:
                                        lines.append(f"  {key}: {value}")
                                else:
                                    lines.append(f"  {key}: {value}")
                        lines.append("")
                    body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.inspect.failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(keeper_only=True, read_only=True, needs=CAPABILITY_MODULE_POOL)
    async def list_module_elements(self, ctx: AgentCtx, element_type: str = "scenes") -> str:
        """List the names of every scene/NPC/clue/truth in the module (KEEPER-ONLY), for browsing before
        drilling into one with get_module_element_detail.

        Args:
            element_type: scenes/npcs/clues/truths/timeline.

        Returns:
            A numbered name list.
        """
        i18n = self._i18n(ctx)
        try:
            catalog = await self._load_catalog(ctx.chat_key)
            if not catalog:
                body = i18n.t("kp_tools.know.catalog.empty")
            else:
                items = catalog.get(element_type) or []
                if not items:
                    body = i18n.t("kp_tools.know.elements.empty", element_type=element_type)
                else:
                    lines = [i18n.t("kp_tools.know.elements.header", element_type=element_type, count=len(items)), ""]
                    for index, item in enumerate(items, 1):
                        if isinstance(item, dict):
                            name = item.get("name", item.get("title", i18n.t("kp_tools.know.elements.unnamed", index=index)))
                            brief = str(item.get("description", item.get("summary", "")))[:60]
                        else:
                            name, brief = str(item), ""
                        lines.append(f"{index}. {name} - {brief}...")
                    lines.append("")
                    lines.append(i18n.t("kp_tools.know.elements.detail_hint", element_type=element_type))
                    body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.elements.failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(keeper_only=True, read_only=True, needs=CAPABILITY_MODULE_POOL)
    async def get_module_element_detail(self, ctx: AgentCtx, element_type: str, name: str) -> str:
        """Get one scene/NPC/clue/truth's full field-by-field detail (KEEPER-ONLY) -- solves
        inspect_knowledge_pool's truncation for long entries.

        Args:
            element_type: scenes/npcs/clues/truths/timeline.
            name: The element's name (fuzzy match supported).

        Returns:
            The matched element's full detail.
        """
        i18n = self._i18n(ctx)
        try:
            catalog = await self._load_catalog(ctx.chat_key)
            if not catalog:
                body = i18n.t("kp_tools.know.catalog.empty")
            else:
                items = catalog.get(element_type) or []
                if not items:
                    body = i18n.t("kp_tools.know.elements.empty", element_type=element_type)
                else:
                    target = _find_by_name(items, name)
                    if target is None:
                        body = i18n.t("kp_tools.know.elements.not_found", element_type=element_type, name=name)
                    else:
                        title = target.get("name", target.get("title", "?")) if isinstance(target, dict) else str(target)
                        lines = [
                            i18n.t("kp_tools.know.elements.detail_header", element_type=element_type, name=title),
                            "=" * 40,
                            "",
                        ]
                        if isinstance(target, dict):
                            for key, value in target.items():
                                if key in ("name", "title"):
                                    continue
                                if isinstance(value, list):
                                    if value:
                                        lines.append(f"[{key}]")
                                        for sub in value:
                                            if isinstance(sub, dict):
                                                sub_name = sub.get("name", sub.get("title", ""))
                                                lines.append(f"  - {sub_name}: {sub.get('description', sub.get('summary', ''))}")
                                            else:
                                                lines.append(f"  - {sub}")
                                        lines.append("")
                                elif isinstance(value, str) and value:
                                    lines.append(f"[{key}]")
                                    lines.append(value)
                                    lines.append("")
                        body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.elements.detail_failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(keeper_only=True, read_only=True, needs=CAPABILITY_MODULE_POOL)
    async def get_module_summary(self, ctx: AgentCtx) -> str:
        """Get the module's global overview -- summary + background + truths + timeline + scene/NPC/threat
        lists (KEEPER-ONLY). Call this once before the session opens to build full behind-the-scenes context.

        Returns:
            The module's structured overview.
        """
        i18n = self._i18n(ctx)
        try:
            catalog = await self._load_catalog(ctx.chat_key)
            if not catalog:
                body = i18n.t("kp_tools.know.catalog.empty")
            else:
                lines = [
                    i18n.t("kp_tools.know.summary.title"),
                    "",
                    i18n.t("kp_tools.know.summary.summary_heading"),
                    catalog.get("summary") or i18n.t("kp_tools.know.summary.none"),
                    "",
                    i18n.t("kp_tools.know.summary.background_heading"),
                    catalog.get("background") or i18n.t("kp_tools.know.summary.none"),
                    "",
                    i18n.t("kp_tools.know.summary.timeline_heading", count=len(catalog.get("timeline") or [])),
                ]
                for entry in catalog.get("timeline") or []:
                    involved = ", ".join(entry.get("involved", []))
                    lines.append(
                        i18n.t("kp_tools.know.summary.timeline_item", time=entry.get("time", "?"), event=entry.get("event", ""), involved=involved)
                    )

                lines += ["", i18n.t("kp_tools.know.summary.truths_heading", count=len(catalog.get("truths") or []))]
                for entry in catalog.get("truths") or []:
                    lines.append(i18n.t("kp_tools.know.summary.truth_item", name=entry.get("name", "?"), description=entry.get("description", "")))
                    if entry.get("revealed_by"):
                        lines.append(i18n.t("kp_tools.know.summary.revealed_by_line", revealed_by=entry["revealed_by"]))

                lines += ["", i18n.t("kp_tools.know.summary.threats_heading", count=len(catalog.get("threats") or []))]
                for entry in catalog.get("threats") or []:
                    lines.append(
                        i18n.t(
                            "kp_tools.know.summary.threat_item",
                            name=entry.get("name", "?"),
                            type=entry.get("type", ""),
                            san_loss=entry.get("san_loss") or i18n.t("kp_tools.know.summary.none"),
                            location=entry.get("location") or i18n.t("kp_tools.know.summary.unknown_location"),
                        )
                    )

                lines += ["", i18n.t("kp_tools.know.summary.scenes_heading", count=len(catalog.get("scenes") or []))]
                for entry in catalog.get("scenes") or []:
                    lines.append(
                        i18n.t(
                            "kp_tools.know.summary.scene_item",
                            name=entry.get("name", "?"),
                            clues=len(entry.get("clues") or []),
                            npcs=len(entry.get("npcs_present") or []),
                        )
                    )

                lines += ["", i18n.t("kp_tools.know.summary.npcs_heading", count=len(catalog.get("npcs") or []))]
                for entry in catalog.get("npcs") or []:
                    lines.append(i18n.t("kp_tools.know.summary.npc_item", name=entry.get("name", "?"), role=entry.get("role", "")))

                body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.summary.failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(keeper_only=True, prep_only=True, read_only=True)
    async def search_documents(self, ctx: AgentCtx, query: str, doc_type: str | None = None, limit: int = 15) -> str:
        """KP document search: retrieves KP prep material (module text, behind-the-scenes setting, NPC
        secrets, untriggered clues) from uploaded documents (KEEPER-ONLY -- never paraphrase raw hits to
        players; digest into what an investigator could currently perceive first).

        Args:
            query: Search query (an NPC name, a location, a clue keyword, etc.)
            doc_type: Optional document-type filter (module/rule/story/background).
            limit: Maximum number of results.

        Returns:
            KP-internal search results, flagged where they contain behind-the-scenes information.
        """
        i18n = self._i18n(ctx)
        try:
            if not self._services.settings.enable_vector_db:
                body = i18n.t("kp_tools.know.document.disabled")
            elif not query.strip():
                body = i18n.t("kp_tools.know.search.empty_query")
            else:
                results = await self._services.vector_db.search_documents(
                    query=query, chat_key=ctx.chat_key, document_type=doc_type, limit=limit
                )
                if not results:
                    body = i18n.t("kp_tools.know.search.no_results")
                else:
                    lines = [
                        i18n.t("kp_tools.know.search.divider"),
                        i18n.t("kp_tools.know.search.banner_title"),
                        i18n.t("kp_tools.know.search.divider"),
                        "",
                        i18n.t("kp_tools.know.search.disclaimer_1"),
                        i18n.t("kp_tools.know.search.disclaimer_2"),
                        i18n.t("kp_tools.know.search.disclaimer_3"),
                        "",
                        i18n.t("kp_tools.know.search.results_header", query=query),
                    ]
                    for index, result in enumerate(results, 1):
                        text = result["text"][:200]
                        flagged = any(re.search(pattern, text, re.IGNORECASE) for pattern in _KEEPER_SENSITIVE_PATTERNS)
                        warning = f" {i18n.t('kp_tools.know.search.sensitive_flag')}" if flagged else ""
                        lines.append(
                            i18n.t(
                                "kp_tools.know.search.result_line",
                                index=index,
                                filename=result["filename"],
                                score=int(result["score"] * 100),
                                warning=warning,
                            )
                        )
                        if flagged:
                            lines.append(i18n.t("kp_tools.know.search.sensitive_note"))
                        lines.append(f"   {text}...")
                        lines.append("")
                    lines.append(i18n.t("kp_tools.know.search.divider"))
                    lines.append(i18n.t("kp_tools.know.search.footer"))
                    lines.append(i18n.t("kp_tools.know.search.divider"))
                    body = "\n".join(lines)
        except Exception as exc:
            body = i18n.t("kp_tools.know.search.failed", error=str(exc))
        return self._keeper_wrap(i18n, body)

    @tool(prep_only=True)
    async def update_knowledge_pool(self, ctx: AgentCtx, player_visible_patch: str = "", keeper_only_patch: str = "") -> str:
        """Incrementally patch the module knowledge pool(s). The given JSON is deep-merged into the
        existing pool rather than overwriting it -- use this to append improvised scenes, world-state
        changes, or NPC updates that emerge during play.

        Args:
            player_visible_patch: Player-visible incremental JSON (deep-merged into the existing player pool).
            keeper_only_patch: Keeper-only incremental JSON (deep-merged into the existing keeper pool).

        Returns:
            Confirmation that the pool(s) were updated.
        """
        i18n = self._i18n(ctx)
        chat_key = ctx.chat_key
        try:
            pools = await _load_pools(self._services, chat_key)
            keeper_raw, player_raw = pools.get("keeper"), pools.get("player")
            keeper = keeper_raw if isinstance(keeper_raw, dict) else {}
            player = player_raw if isinstance(player_raw, dict) else {}
            if player_visible_patch:
                player = _deep_merge(player, json.loads(player_visible_patch))
            if keeper_only_patch:
                keeper = _deep_merge(keeper, json.loads(keeper_only_patch))
            if player_visible_patch or keeper_only_patch:
                await _save_pools(self._services, chat_key, keeper, player)

            return i18n.t("kp_tools.know.update.done")
        except Exception as exc:
            return i18n.t("kp_tools.know.update.failed", error=str(exc))

    @tool(needs=CAPABILITY_MODULE_POOL)
    async def unlock_for_player(self, ctx: AgentCtx, element_type: str, name: str) -> str:
        """Unlock a scene/NPC/clue/truth from the keeper pool into the player pool once the players have
        actually discovered it through investigation or conversation -- keep this in sync as play
        progresses to avoid both spoilers and confusion.

        Args:
            element_type: scenes/npcs/clues/truths.
            name: The element's name (fuzzy match supported).

        Returns:
            Confirmation of the unlock, or an explanation of why it couldn't be done.
        """
        i18n = self._i18n(ctx)
        store = self._services.store
        chat_key = ctx.chat_key
        try:
            pools = await _load_pools(self._services, chat_key)
            keeper = pools.get("keeper")
            if not isinstance(keeper, dict) or not keeper:
                return i18n.t("kp_tools.know.unlock.no_keeper_pool")
            player_raw = pools.get("player")
            player = player_raw if isinstance(player_raw, dict) else {}

            target = _find_by_name(keeper.get(element_type, []), name)
            if target is None:
                return i18n.t("kp_tools.know.unlock.not_found", element_type=element_type, name=name)

            target_name = target.get("name", target.get("title", "?"))

            if element_type == "scenes":
                unlocked = {
                    "name": target_name,
                    "description": target.get("description", ""),
                    "npcs_present": target.get("npcs_present", []),
                    "clues": [
                        {
                            "name": c.get("name", ""),
                            "description": c.get("description", ""),
                            "discovery_method": c.get("discovery_method", ""),
                        }
                        for c in target.get("clues", [])
                    ],
                }
            elif element_type == "npcs":
                unlocked = {"name": target_name, "description": target.get("description", ""), "role": target.get("role", "")}
            elif element_type == "clues":
                unlocked = {
                    "name": target_name,
                    "description": target.get("description", ""),
                    "location": target.get("location", ""),
                    "leads_to": target.get("leads_to", ""),
                }
            elif element_type == "truths":
                unlocked = {"name": target_name, "description": target.get("description", "")}
            else:
                return i18n.t("kp_tools.know.unlock.unsupported_type", element_type=element_type)

            player.setdefault(element_type, [])
            already = any((u.get("name") == target_name or u.get("title") == target_name) for u in player[element_type])
            if already:
                return i18n.t("kp_tools.know.unlock.already_unlocked", element_type=element_type, name=target_name)

            player[element_type].append(unlocked)
            await _save_pools(self._services, chat_key, keeper, player)

            try:
                docs = self._services.documents
                fact_doc = await docs.get(chat_key, "note", "confirmed_facts")
                entries = fact_doc.data.get("content") if fact_doc is not None else None
                entries = entries if isinstance(entries, list) else []
                clock_data = await store.state_get(chat_key, _game_clock_key(chat_key))
                game_time = json.loads(clock_data).get("current_time", "?") if clock_data else "?"
                fact_content = i18n.t("kp_tools.know.unlock.confirmed_fact", time=game_time, element_type=element_type, name=target_name)
                entries.append({"time": game_time, "content": fact_content})
                await docs.put(chat_key, "note", "confirmed_facts", {"category": "confirmed_facts", "content": entries})
            except Exception:
                pass  # best-effort sync; the unlock itself already succeeded above

            try:
                # M10: the party just discovered this -> every AI companion learns it too, so
                # companions stay current with (but never ahead of) the party. The unlocked element
                # is player-safe by construction (it now lives in the player pool), so witnessing it
                # to companions can't leak keeper material. Best-effort: never break the unlock.
                from agent.kp_tools_companion import witness

                description = unlocked.get("description", "")
                await witness(self._services, chat_key, f"{target_name}: {description}" if description else target_name)
            except Exception:
                pass

            return i18n.t("kp_tools.know.unlock.done", element_type=element_type, name=target_name)
        except Exception as exc:
            return i18n.t("kp_tools.know.unlock.failed", error=str(exc))

    @tool(prep_only=True)
    async def start_module_initialization(self, ctx: AgentCtx) -> str:
        """Manually (re-)trigger module knowledge-pool initialization. upload_document already
        auto-triggers this for module/story uploads; call this directly to force a re-analysis.

        Returns:
            Confirmation that initialization ran, including the resulting status.
        """
        i18n = self._i18n(ctx)
        store = self._services.store
        chat_key = ctx.chat_key
        try:
            status = await store.state_get(chat_key, _status_key(chat_key))
            if status == "processing":
                return i18n.t("kp_tools.know.init.already_processing")

            fulltext = await store.state_get(chat_key, _fulltext_key(chat_key))
            chunks = await self._services.vector_db.list_all_chunks(chat_key)
            if not fulltext and not chunks:
                return i18n.t("kp_tools.know.init.no_document")

            await self._services.module_init.initialize(chat_key)

            new_status = await store.state_get(chat_key, _status_key(chat_key))
            if new_status == "ready_fallback":
                error = await store.state_get(chat_key, _error_key(chat_key))
                return i18n.t(
                    "kp_tools.know.init.completed_fallback",
                    count=len(chunks),
                    error=error or i18n.t("kp_tools.know.status.unknown_error"),
                )
            return i18n.t("kp_tools.know.init.completed", count=len(chunks), status=new_status or i18n.t("kp_tools.know.status.unknown"))
        except Exception as exc:
            return i18n.t("kp_tools.know.init.start_failed", error=str(exc))

    @tool(prep_only=True, read_only=True)
    async def get_module_init_status(self, ctx: AgentCtx) -> str:
        """Check this chat's module knowledge-pool initialization status.

        Returns:
            not-started / processing / ready (with an analyzed-entry count) / failed.
        """
        i18n = self._i18n(ctx)
        try:
            status = await self._services.store.state_get(ctx.chat_key, _status_key(ctx.chat_key))
            if not status:
                return i18n.t("kp_tools.know.init.status_none")
            if status == "processing":
                return i18n.t("kp_tools.know.init.status_processing")
            if status in {"ready", "ready_fallback"}:
                catalog = await self._load_catalog(ctx.chat_key)
                total = sum(len(v) for v in (catalog or {}).values() if isinstance(v, list))
                if status == "ready_fallback":
                    error = await self._services.store.state_get(ctx.chat_key, _error_key(ctx.chat_key))
                    return i18n.t(
                        "kp_tools.know.init.status_ready_fallback",
                        count=total,
                        error=error or i18n.t("kp_tools.know.status.unknown_error"),
                    )
                return i18n.t("kp_tools.know.init.status_ready", count=total)
            if status.startswith("failed"):
                error = await self._services.store.state_get(ctx.chat_key, _error_key(ctx.chat_key))
                if not error and ":" in status:  # backward-compatible legacy status payload
                    error = status.split(":", 1)[1]
                return i18n.t(
                    "kp_tools.know.init.status_failed",
                    error=error or i18n.t("kp_tools.know.status.unknown_error"),
                )
            return i18n.t("kp_tools.know.init.status_other", status=status)
        except Exception as exc:
            return i18n.t("kp_tools.know.init.status_failed_query", error=str(exc))


class DocumentTools(_KnowledgeToolsBase):
    """Document upload/management tools: TXT/PDF/DOCX ingestion into the vector store, backing both
    ad-hoc `search_documents` retrieval and (for module/story uploads) module-analysis initialization.
    """

    @tool(prep_only=True)
    async def upload_document(self, ctx: AgentCtx, file_path: str, doc_type: str = "module", custom_filename: str | None = None, progress: ProgressCb = None) -> str:
        """Process an uploaded document file: extract its text, chunk + embed it into the vector store, and
        (for module/story documents) auto-trigger module knowledge-pool initialization.

        Args:
            file_path: The sandbox/logical file path (resolved to a host path via ctx.fs).
            doc_type: Document type (module/rule/story/background).
            custom_filename: Optional display filename override.

        Returns:
            A confirmation summarizing what was stored.
        """
        i18n = self._i18n(ctx)
        if not self._services.settings.enable_vector_db:
            return i18n.t("kp_tools.know.document.disabled")
        if doc_type not in _VALID_DOC_TYPES:
            return i18n.t("kp_tools.know.upload.bad_doc_type")
        if ctx.fs is None:
            return i18n.t("kp_tools.know.document.no_fs")

        try:
            host_path = Path(ctx.fs.get_file(file_path))
            if not host_path.exists():
                return i18n.t("kp_tools.know.upload.file_missing")

            filename = custom_filename or host_path.stem
            file_content = host_path.read_bytes()

            try:
                text_content = self._services.vector_db.document_processor.extract_text_by_extension(host_path.name, file_content)
            except ValueError as exc:
                return i18n.t("kp_tools.know.upload.parse_failed", error=str(exc))

            if not text_content.strip():
                return i18n.t("kp_tools.know.upload.empty_content")

            chat_key = ctx.chat_key
            await _emit(progress, "read", str(len(text_content)))
            await _emit(progress, "embed")
            chunk_count = await self._services.vector_db.store_document(
                document_id=str(uuid.uuid4()),
                filename=filename,
                text_content=text_content,
                chat_key=chat_key,
                document_type=doc_type,
            )

            init_note = ""
            if doc_type in _MODULE_INIT_DOC_TYPES:
                # module_fulltext is the exact source text ModuleInitializer analyzes (see
                # core/module_initializer.py's `_load_full_text`); only module/story uploads are
                # "the module" being analyzed, so only those may (over)write it -- a `rule`/
                # `background` upload must never clobber a previously uploaded module's full text.
                await self._services.store.state_set(chat_key, _fulltext_key(chat_key), text_content)
                # `initialize` emits the "analyze"/"build" stages itself (its LLM analysis is the
                # slow one); we bracket it with the fast read/embed and the final done here.
                await self._services.module_init.initialize(chat_key, progress=progress)
                status = await self._services.store.state_get(chat_key, _status_key(chat_key))
                await _emit(progress, "done", status or "")
                if status == "ready_fallback":
                    error = await self._services.store.state_get(chat_key, _error_key(chat_key))
                    init_note = "\n" + i18n.t(
                        "kp_tools.know.upload.init_done_fallback",
                        error=error or i18n.t("kp_tools.know.status.unknown_error"),
                    )
                else:
                    init_note = "\n" + i18n.t(
                        "kp_tools.know.upload.init_done",
                        status=status or i18n.t("kp_tools.know.status.unknown"),
                    )

            emoji = _DOC_TYPE_EMOJI.get(doc_type, _DEFAULT_DOC_EMOJI)
            return (
                i18n.t("kp_tools.know.upload.done", emoji=emoji, filename=filename, chunk_count=chunk_count, char_count=len(text_content))
                + init_note
            )
        except Exception as exc:
            return i18n.t("kp_tools.know.upload.failed", error=str(exc))

    @tool(prep_only=True)
    async def delete_document(self, ctx: AgentCtx, filename: str) -> str:
        """Delete a previously uploaded document by filename. Deleting a module/story document also clears
        its knowledge pools/catalog/init-status/full-text, so the AI is never left with stale content.

        Args:
            filename: The document's display filename.

        Returns:
            Confirmation of the deletion, or why it failed.
        """
        i18n = self._i18n(ctx)
        if not self._services.settings.enable_vector_db:
            return i18n.t("kp_tools.know.document.disabled")

        try:
            chat_key = ctx.chat_key
            documents = await self._services.vector_db.list_documents(chat_key)
            target = next((doc for doc in documents if doc["filename"] == filename), None)
            if target is None:
                return i18n.t("kp_tools.know.delete.not_found", filename=filename)

            success = await self._services.vector_db.delete_document(target["document_id"], chat_key)
            if not success:
                return i18n.t("kp_tools.know.delete.failed_generic", filename=filename)

            if target.get("document_type") in _MODULE_INIT_DOC_TYPES:
                store = self._services.store
                await self._services.documents.delete_type(chat_key, "module_pool")
                for key in (
                    _status_key(chat_key),
                    _error_key(chat_key),
                    _fulltext_key(chat_key),
                ):
                    await store.state_set(chat_key, key, "")

            emoji = _DOC_TYPE_EMOJI.get(target["document_type"], _DEFAULT_DOC_EMOJI)
            return i18n.t("kp_tools.know.delete.done", emoji=emoji, filename=filename)
        except Exception as exc:
            return i18n.t("kp_tools.know.delete.failed", filename=filename, error=str(exc))

    @tool(prep_only=True, read_only=True)
    async def list_my_documents(self, ctx: AgentCtx, doc_type: str | None = None) -> str:
        """List every document uploaded to this chat, optionally filtered by type.

        Args:
            doc_type: Optional document-type filter (module/rule/story/background).

        Returns:
            A list of filenames with a short preview of each.
        """
        i18n = self._i18n(ctx)
        if not self._services.settings.enable_vector_db:
            return i18n.t("kp_tools.know.document.disabled")

        try:
            documents = await self._services.vector_db.list_documents(ctx.chat_key, doc_type)
            if not documents:
                return i18n.t("kp_tools.know.list_docs.empty_filtered", doc_type=doc_type) if doc_type else i18n.t("kp_tools.know.list_docs.empty")

            lines = [i18n.t("kp_tools.know.list_docs.header")]
            for index, doc in enumerate(documents, 1):
                emoji = _DOC_TYPE_EMOJI.get(doc["document_type"], _DEFAULT_DOC_EMOJI)
                lines.append(i18n.t("kp_tools.know.list_docs.item", index=index, emoji=emoji, filename=doc["filename"], doc_type=doc["document_type"]))
                lines.append(i18n.t("kp_tools.know.list_docs.preview", preview=doc["preview"]))
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.know.list_docs.failed", error=str(exc))

    @tool(prep_only=True, read_only=True)
    async def get_supported_file_types(self, ctx: AgentCtx) -> str:
        """Get the list of supported upload file types and document categories.

        Returns:
            Help text describing supported formats and document types.
        """
        return self._i18n(ctx).t("kp_tools.know.file_types.help")


class NoteTools(_KnowledgeToolsBase):
    """Free-form KP note-taking + game-clock tools: the mutable, session-scoped bookkeeping layer that
    sits alongside the (read-mostly) module knowledge pools.
    """

    @tool
    async def kp_note(self, ctx: AgentCtx, action: str, category: str, content: str = "") -> str:
        """The AI KP's free-form notebook -- improvised scenes, world-state changes, NPC status updates,
        player-action history, etc. Kept separate from the (read-only, official) module knowledge pool;
        this is for whatever comes up during play.

        Args:
            action: set (set a single-value state) / add (append a note) / update (edit the last note) /
                delete (remove a whole category) / get or list (read a category back: the single
                value, or every note in it).
            category: The note category, e.g. current_scene, current_focus, improvised_scenes, npc_status,
                world_changes, player_actions, kp_reasoning.
            content: The note text. For action=set this is the single value (e.g. a scene name); for
                action=add/update it is the note's content.

        Returns:
            Confirmation of the note operation, or its listing.
        """
        i18n = self._i18n(ctx)
        docs = self._services.documents
        chat_key = ctx.chat_key
        try:
            # current_scene/current_focus are the player-visible `scene` singleton
            # document (its projection is all-viewer); everything else is a
            # keeper-only `note` document per category.
            if category in _SCENE_CATEGORIES:
                return await self._scene_note(i18n, chat_key, action, category, content)

            doc = await docs.get(chat_key, "note", category)
            stored = doc.data.get("content") if doc is not None else None

            if action == "set":
                await docs.put(chat_key, "note", category, {"category": category, "content": content})
                return i18n.t("kp_tools.know.note.set_done", category=category, content=content)

            if action == "add":
                entries = stored if isinstance(stored, list) else []
                entries.append({"time": datetime.now().strftime("%Y-%m-%d %H:%M"), "content": content})
                await docs.put(chat_key, "note", category, {"category": category, "content": entries})
                return i18n.t("kp_tools.know.note.add_done", category=category, preview=content[:50])

            if action == "update":
                if doc is None:
                    return i18n.t("kp_tools.know.note.category_missing", category=category)
                if not isinstance(stored, list) or not stored:
                    return i18n.t("kp_tools.know.note.empty_category", category=category)
                stored[-1]["content"] = content
                await docs.put(chat_key, "note", category, {"category": category, "content": stored})
                return i18n.t("kp_tools.know.note.update_done", category=category)

            if action == "delete":
                if doc is None:
                    return i18n.t("kp_tools.know.note.category_missing", category=category)
                await docs.delete(chat_key, "note", category)
                return i18n.t("kp_tools.know.note.delete_done", category=category)

            if action in ("list", "get"):
                # `get` is the read-back a `set` value never had: `list` treated a
                # single-value category as empty, so the model asked for `get` (40 times
                # in one 50-turn 《安土》 run) and was told the action did not exist.
                if isinstance(stored, str) and stored:
                    return i18n.t("kp_tools.know.note.get_done", category=category, content=stored)
                items = stored if isinstance(stored, list) else []
                if not items:
                    return i18n.t("kp_tools.know.note.list_empty", category=category)
                lines = [i18n.t("kp_tools.know.note.list_header", category=category, count=len(items)), ""]
                for index, item in enumerate(items, 1):
                    lines.append(i18n.t("kp_tools.know.note.list_item", index=index, time=item.get("time", "?"), content=item.get("content", "")))
                return "\n".join(lines)

            return i18n.t("kp_tools.know.note.bad_action", action=action)
        except Exception as exc:
            return i18n.t("kp_tools.know.note.failed", error=str(exc))

    async def _scene_note(self, i18n: I18n, chat_key: str, action: str, category: str, content: str) -> str:
        """current_scene/current_focus route to the `scene` singleton document.

        `add`/`update` coerce to `set` — a singleton scene value has no entry
        list to append to (pre-M17 they silently corrupted the scene display).
        """
        docs = self._services.documents
        doc = await docs.get_singleton(chat_key, "scene")
        data = dict(doc.data) if doc is not None else {}
        field = "name" if category == "current_scene" else "focus"

        if action in ("set", "add", "update"):
            data[field] = content
            await docs.put_singleton(chat_key, "scene", data)
            return i18n.t("kp_tools.know.note.set_done", category=category, content=content)

        if action == "delete":
            if field not in data:
                return i18n.t("kp_tools.know.note.category_missing", category=category)
            data.pop(field, None)
            await docs.put_singleton(chat_key, "scene", data)
            return i18n.t("kp_tools.know.note.delete_done", category=category)

        if action in ("list", "get"):
            value = data.get(field, "")
            if not value:
                return i18n.t("kp_tools.know.note.list_empty", category=category)
            if action == "get":
                return i18n.t("kp_tools.know.note.get_done", category=category, content=value)
            lines = [
                i18n.t("kp_tools.know.note.list_header", category=category, count=1),
                "",
                i18n.t("kp_tools.know.note.list_item", index=1, time="-", content=value),
            ]
            return "\n".join(lines)

        return i18n.t("kp_tools.know.note.bad_action", action=action)

    @tool
    async def game_clock(self, ctx: AgentCtx, action: str = "show", value: str = "") -> str:
        """Manage in-game time: advance the clock, log a scheduled event, or view the current timeline
        during play.

        Args:
            action: show (view current time) / set (set the time) / advance (move time forward) /
                add_event (log a scheduled event) / list_events (list every logged event).
            value: Depends on action. For set, e.g. "1926-03-15 14:00"; for advance, e.g. "+2 hours"/"+1
                day"; for add_event, the event description.

        Returns:
            The current time/event listing, or confirmation of the change.
        """
        i18n = self._i18n(ctx)
        store = self._services.store
        store_key = _game_clock_key(ctx.chat_key)
        try:
            clock_data = await store.state_get(ctx.chat_key, store_key)
            clock = json.loads(clock_data) if clock_data else {"current_time": i18n.t("kp_tools.know.clock.unset"), "events": []}

            if action == "show":
                lines = [i18n.t("kp_tools.know.clock.current", time=clock.get("current_time", i18n.t("kp_tools.know.clock.unset"))), ""]
                events = clock.get("events", [])
                if events:
                    lines.append(i18n.t("kp_tools.know.clock.events_heading"))
                    for event in events[-10:]:
                        lines.append(i18n.t("kp_tools.know.clock.event_line", time=event.get("time", "?"), description=event.get("description", "")))
                else:
                    lines.append(i18n.t("kp_tools.know.clock.no_events"))
                return "\n".join(lines)

            if action == "set":
                clock["current_time"] = value
                await store.state_set(ctx.chat_key, store_key, json.dumps(clock, ensure_ascii=False))
                return i18n.t("kp_tools.know.clock.set_done", time=value)

            if action == "advance":
                current = clock.get("current_time", i18n.t("kp_tools.know.clock.unset"))
                advanced_time, parsed_cleanly = advance_game_time(current, value)
                if not parsed_cleanly:
                    if parse_time_delta(value) is None:
                        # The DELTA is the problem: nothing to record, nothing to move.
                        return i18n.t("kp_tools.know.clock.advance_unparsed", delta=value, time=current)
                    if face_is_engine_readable(current):
                        # Delta AND face parse, yet the engine declined: the move would
                        # land before day 1. A refusal, not an advance — nothing recorded.
                        return i18n.t("kp_tools.know.clock.advance_refused", delta=value, time=current)
                    # The delta parses; only the FACE does not — a module running its own
                    # calendar ("澹洲三百年六月初二 午时"). The face stays as written (a
                    # "X → +2 hours" chain would pollute the HUD and the model can `set` a
                    # new face), but the advance is still a real event: the room's calendar
                    # hooks consume the DELTA, never the face, so it is recorded exactly as a
                    # parseable clock's advance would be. Dropping it here silently froze
                    # every custom-calendar module's day counter (2026-08-18 《安土》 run 1).
                    advances = ctx.extra.setdefault("clock_advances", [])
                    if isinstance(advances, list) and len(advances) < 8:
                        advances.append({"from": str(current), "to": str(current), "delta": value})
                    return i18n.t("kp_tools.know.clock.advance_face_kept", delta=value, time=current)
                clock["current_time"] = advanced_time
                await store.state_set(ctx.chat_key, store_key, json.dumps(clock, ensure_ascii=False))
                # Record the advance for the room's event hooks (Layer C): the turn
                # finalizer fires `clock_advanced` once per recorded advance, capped.
                advances = ctx.extra.setdefault("clock_advances", [])
                if isinstance(advances, list) and len(advances) < 8:
                    advances.append({"from": str(current), "to": advanced_time, "delta": value})
                return i18n.t("kp_tools.know.clock.advance_done", delta=value, time=advanced_time)

            if action == "add_event":
                event = {"time": clock.get("current_time", "?"), "description": value}
                clock.setdefault("events", []).append(event)
                await store.state_set(ctx.chat_key, store_key, json.dumps(clock, ensure_ascii=False))
                return i18n.t("kp_tools.know.clock.event_added", time=event["time"], description=value)

            if action == "list_events":
                events = clock.get("events", [])
                if not events:
                    return i18n.t("kp_tools.know.clock.no_events")
                lines = [i18n.t("kp_tools.know.clock.all_events_heading"), ""]
                for event in events:
                    lines.append(i18n.t("kp_tools.know.clock.event_line", time=event.get("time", "?"), description=event.get("description", "")))
                return "\n".join(lines)

            return i18n.t("kp_tools.know.clock.bad_action", action=action)
        except Exception as exc:
            return i18n.t("kp_tools.know.clock.failed", error=str(exc))


class SessionTools(_KnowledgeToolsBase):
    """Session-recording tools: thin wrappers over `services.battles` (start/end a recorded session and
    render its report). Nothing here logs the STORY — the room's conversation is already the record,
    and the report is rendered from it.
    """

    @tool(prep_only=True)
    async def start_session_recording(
        self, ctx: AgentCtx, session_name: str | None = None, force_new: bool = False
    ) -> str:
        """Start recording this TRPG session, so a battle report can be generated from it later.

        Args:
            session_name: Optional session name.
            force_new: Archive an active recording before starting a fresh one.

        Returns:
            Confirmation that recording started.
        """
        i18n = self._i18n(ctx)
        try:
            current = await self._services.battles.generator.get_current_session(ctx.chat_key)
            if current is not None and not force_new:
                current_name = await self._services.store.get(
                    "session_name.current"
                )
                return i18n.t(
                    "kp_tools.know.session.already_active",
                    session_id=current.session_id,
                    name=current_name or "-",
                )
            await self._services.battles.start_session(
                ctx.chat_key,
                session_name,
                i18n=i18n,
                force_new=force_new,
            )
            if session_name:
                return i18n.t("kp_tools.know.session.started_named", name=session_name)
            return i18n.t("kp_tools.know.session.started")
        except Exception as exc:
            return i18n.t("kp_tools.know.session.start_failed", error=str(exc))

    @tool(prep_only=True)
    async def generate_session_report(self, ctx: AgentCtx) -> str:
        """End the current session and generate its battle report (text, plus a Markdown file written to
        the shared filesystem on a best-effort basis).

        Returns:
            The text battle report, plus a reference to the Markdown file when one could be written.
        """
        i18n = self._i18n(ctx)
        try:
            # The Markdown file is the players' keepsake, so it carries the room's whole
            # conversation; the text report returned below stays a compact scoreboard.
            transcript = await load_chain(self._services, ctx.chat_key, DEFAULT_HISTORY_KEY)
            text_report, markdown_report, _session_name = await self._services.battles.generate_battle_report(
                ctx.chat_key, i18n=i18n, transcript=transcript
            )
            if not text_report:
                return i18n.t("kp_tools.know.session.no_active_session")
            markdown_report = markdown_report or ""

            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            await self._services.store.state_set(ctx.chat_key, _battle_report_key(ctx.chat_key, timestamp), markdown_report)

            file_note = ""
            if ctx.fs is not None:
                try:
                    report_path = ctx.fs.shared_path / f"battle_report_{timestamp}.md"
                    report_path.write_text(markdown_report, encoding="utf-8")
                    sandbox_ref = ctx.fs.forward_file(report_path)
                    file_note = "\n\n" + i18n.t("kp_tools.know.session.report_file_note", path=sandbox_ref)
                except Exception:
                    pass  # best-effort: the text report below is still returned even if the file write fails

            return f"{text_report}{file_note}"
        except Exception as exc:
            return i18n.t("kp_tools.know.session.report_failed", error=str(exc))

    @tool(prep_only=True, read_only=True)
    async def get_battle_report_markdown(self, ctx: AgentCtx, timestamp: str) -> str:
        """Fetch a previously generated Markdown battle report by its timestamp.

        Args:
            timestamp: The report's timestamp (as embedded in generate_session_report's reply).

        Returns:
            The Markdown report text.
        """
        i18n = self._i18n(ctx)
        try:
            markdown_report = await self._services.store.state_get(ctx.chat_key, _battle_report_key(ctx.chat_key, timestamp))
            if not markdown_report:
                return i18n.t("kp_tools.know.session.report_not_found")
            return markdown_report
        except Exception as exc:
            return i18n.t("kp_tools.know.session.report_fetch_failed", error=str(exc))

    @tool(prep_only=True)
    async def export_report(self, ctx: AgentCtx, detailed: bool = False, session_name: str = "") -> str:
        """Export the session report ("团报") for the players to keep and review -- a concise summary by
        default, or the whole session with detailed=True. Unlike generate_session_report this does NOT end
        the session, so players can save a keepsake at any point (mid-session or after). This is the
        players' own record, not keeper-only material.

        Args:
            detailed: False exports the summary alone; True adds the full dice log and the room's entire
                conversation -- every player message and every reply -- on top of it.
            session_name: Optional title override for the exported report.

        Returns:
            The saved file path plus a short preview of the report.
        """
        i18n = self._i18n(ctx)
        try:
            rendered = await render_session_report(
                self._services, ctx, i18n, detailed=detailed, session_name=session_name
            )
            if rendered is None:
                return i18n.t("kp_tools.know.session.export.no_session")
            markdown, saved_note = rendered
            mode = i18n.t(
                "kp_tools.know.session.export.mode_detailed"
                if detailed
                else "kp_tools.know.session.export.mode_summary"
            )
            # Bounded preview: small/medium reports (incl. their detailed transcript) render whole; only a
            # genuinely long transcript gets truncated, so the return stays digestible in a tool/chat reply.
            body = markdown.strip()
            preview_body = body if len(body) <= 4000 else body[:4000] + "\n…"
            preview = i18n.t("kp_tools.know.session.export.preview", preview=preview_body)
            parts = [i18n.t("kp_tools.know.session.export.done", mode=mode)]
            if saved_note:
                parts.append(saved_note)
            parts.append(preview)
            return "\n\n".join(parts)
        except Exception as exc:
            return i18n.t("kp_tools.know.session.export.failed", error=str(exc))


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="keeper_notes",
        owner="agent.kp_tools_knowledge",
        reset_scope="story",
        # The keeper's private working memory and the current-scene singleton: both
        # describe the session in progress, so both end with it.
        doc_types=frozenset({"note", "scene"}),
        storages=frozenset({STORAGE_DOCUMENTS}),
    ),
)
