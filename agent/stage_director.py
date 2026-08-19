"""The Stage Director (演出导演) — the player-side presentation actor (M19).

Born from the K3×K3 live test: the single moment a naive player scored "the only
thing all session where the picture said more than the text" was a handout image,
and her report asked for more. The presentation layer is the surface players
actually look at, and until now it was either static pack content or the operator
performing beats by hand (`.bgm` switches, copying handout files). This is the
actor that performs them.

**Scoped by construction — the load-bearing design point.** Everything this actor
emits is player-visible, so it joins the knowledge-scoped actor family (the
NPC/companion precedent, iron rule #3): its inputs are the PROJECTED player-visible
stream plus the module's presentation kit, and nothing else. It cannot leak what it
never receives. Concretely, its whole context is:

- the player's own utterance and the Keeper's reply — both ALREADY broadcast to the
  room as `narrative` frames, so neither can carry anything a player has not read;
- ``PLAYER_VIEWER`` projections only (scene, player-visible trackers);
- the presentation kit (`gateway.presentation`), which is authored player-facing
  production notes by definition.

The beat cue from the Scribe is an ENUM, never prose. The Scribe is a keeper-side
actor that reads keeper trackers; letting it hand the Director a written summary
would be a covert channel straight out of the keeper half, however well-meant. So
场记 says only WHICH KIND of moment this is, and the Director reconstructs what
happened from the player-visible stream it already holds.
`tests/architecture/test_director_isolation.py` is the oracle for all of this.

**Boundaries.** The Director never writes fiction (the KP's), never rolls or
adjudicates (the engine's), never reads keeper knowledge. It decides WHAT TO SHOW
and WHEN — a theater director does not rewrite the script mid-performance.

Three output lanes, each validated by deterministic code before it reaches anyone:

1. ``blocks`` — performance templates, through the SAME `core.hooks` sanitizer that
   validates hook emissions. The Director picks the template and the words; it never
   welds the stage.
2. ``audio`` — cue ids the kit declares, resolved to real pack assets and broadcast
   as ordinary `audio_control` frames. An id the kit does not declare is dropped.
3. ``image`` — one generation request per beat, under the kit's discipline:
   ref-mandatory (no 定妆 reference → no portrait, structurally: the Director can
   only name subjects the kit declares), 宁缺毋滥 (an author's ``generation:
   pack_only`` silences it entirely), and a per-room budget. ``prepare`` warms
   likely-next subjects in the background — 慢菜先备, so a beat serves art that was
   cooked during the quiet turns before it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

from agent.context import AgentCtx
from agent.services import Services
from agent.tool_trace import trace_event
from core.documents import PLAYER_VIEWER, SCENE_ID
from core.hooks import sanitize_ui_emissions
from core.modvars import MODVARS_DOC_ID, MODVARS_DOC_TYPE, wire_entries
from infra.llm import LLMClient
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet

if TYPE_CHECKING:
    from gateway.hub import RoomHub
    from gateway.presentation import RoomKit

logger = logging.getLogger(__name__)

# The 场记 vocabulary (M19 open detail 2). A beat is a MOMENT worth dressing; the
# overwhelming majority of turns are `none` and never wake the Director at all.
BEATS = ("scene_change", "act_transition", "handout", "spike")

PREGEN_KEY = "director_pregen"  # subject id -> media hash, the 慢菜先备 larder
SPENT_KEY = "director_images"  # how many generations this room has paid for

# Why a beat did or did not end up showing a picture. Written to the tool probe
# (`agent.tool_trace`, `TRPG_DEBUG__TOOL_TRACE`) under `director`, because "the whole
# session produced zero images" is otherwise unattributable after the fact.
IMAGE_NONE = "none"  # the Director never asked for one
IMAGE_KIT_MISSING = "kit_missing"  # this room's modules ship no presentation kit
IMAGE_TEMPLATE_DENIED = "template_denied"  # the kit's `templates:` allowlist excludes images
IMAGE_IMAGEGEN_OFF = "imagegen_off"  # no provider configured, or the kit/settings say pack-only
IMAGE_REF_MISSING = "ref_missing"  # 宁缺毋滥: no readable 定妆 reference for that subject
IMAGE_BUDGET = "budget"  # the room's generation budget is spent
IMAGE_PROVIDER_FAILED = "llm_failed"  # the provider raised
IMAGE_LARDER = "larder"  # served warm from the 慢菜先备 larder
IMAGE_REF_FALLBACK = "ref_fallback"  # generation declined; the kit's own 定妆 reference was shown
IMAGE_GENERATED = "generated"

DIRECTOR_TRACE_KIND = "director"

MAX_BLOCKS = 6
MAX_AUDIO_CUES = 2
_MAX_TURN_TEXT = 4_000
_MAX_PROMPT_CHARS = 600

_PROMPT = """You are the Stage Director for a tabletop RPG table — the person who decides what the players SEE and HEAR, never what happens.

A beat just landed: {beat}. Dress it. Output ONLY a JSON object:
{{"blocks": [<block>...], "audio": [{{"cue": "<cue id>", "action": "play"|"stop"}}], "image": {{"subject": "<subject id>", "prompt": "<what this picture shows>"}} | null, "prepare": ["<subject id>"...]}}

Block templates (pick what the moment deserves; 0-{max_blocks} blocks, often 1):
{templates}

Rules:
- You never narrate, never roll, never decide outcomes, never speak as a character. You choose a FORM and fill it from what the table has already seen.
- Write in the language the turn is written in. Match the module's period and register; a 1925 newspaper does not sound like a modern one.
- Emit nothing rather than something generic. An empty "blocks" list is a fine answer for a beat that needs only music.
- "audio": only cue ids listed below. "image": at most one, subject id from the list below, and its prompt must describe ONLY what players have already seen or could plainly see now.
- "prepare": subject ids you expect to want a picture of within the next scene or two (0-{pregen} of them). They are generated quietly in advance; naming one costs nothing now.
{image_rule}
Style guide (every generated image inherits it): {style}
Palette (the colors this module dresses in): {palette}
Never depict: {banned}

Picturable subjects (id | kind | name):
{subjects}

Audio cues (id | layer | title):
{cues}

Player-visible trackers right now:
{trackers}
Scene: {scene}

--- THE TURN (everything below is what the players themselves saw) ---
Player: {player}
Keeper: {reply}
--- END ---

JSON only."""

# The remaining model-facing prompt fragments, kept beside `_PROMPT` rather than inline:
# every word the Director is addressed with lives in one place (and the i18n lint's
# convention for prompt text is a module-level constant, same as `agent.scribe`).
# One bullet per stageable block shape; a kit's `templates:` allowlist (presentation v2)
# decides which bullets the Director is even offered. Values are inserted AFTER
# `.format`, so their braces are literal.
_BLOCK_TEMPLATES = {
    "title_card": '- {"kind": "title_card", "title": "...", "subtitle": "...", "act": "..."} — an act/day/chapter turning over.',  # i18n-exempt: model-facing prompt text, like _PROMPT above
    "letter": '- {"kind": "letter", "body": "...", "from": "...", "to": "...", "date": "..."} — a letter, note or diary page the players now hold.',  # i18n-exempt: model-facing prompt text
    "clipping": '- {"kind": "clipping", "headline": "...", "body": "...", "source": "...", "date": "..."} — a newspaper or official document.',  # i18n-exempt: model-facing prompt text
    "text": '- {"kind": "text", "text": "...", "style": "quote"} — a caption line when nothing heavier fits.',  # i18n-exempt: model-facing prompt text
}
_NO_TEMPLATES_NOTE = "(none — this module stages with audio and pictures only; leave blocks empty)"  # i18n-exempt: model-facing prompt text
_NO_REF_NOTE = " (no reference image — may be named, never generated)"  # i18n-exempt: model-facing prompt text, like _PROMPT above
_RULE_NO_GENERATION = '- This module allows NO image generation (the author\'s choice): leave "image" null and "prepare" empty.'  # i18n-exempt: model-facing prompt text
_RULE_GENERATION = "- Ask for an image only when a picture genuinely says more than the words did. Most beats do not need one."  # i18n-exempt: model-facing prompt text


def _director_llm(services: Services) -> LLMClient:
    """The Director's client: a dedicated model when configured, else the main one.
    Unlike the Scribe this defaults to the MAIN model — beats are rare and taste is
    the whole job. Cached on the services bundle (one construction per process)."""
    cached = getattr(services, "_director_llm_cache", None)
    if cached is not None:
        return cached
    settings = services.settings.director
    if settings.provider or settings.chat_model or settings.base_url:
        from infra.providers import build_llm

        patched = services.settings.model_copy(deep=True)
        patched.llm.provider = settings.provider or services.settings.llm.provider
        patched.llm.api_key = settings.api_key or services.settings.llm.api_key
        patched.llm.base_url = settings.base_url
        patched.llm.chat_model = settings.chat_model or services.settings.llm.chat_model
        patched.llm.reasoning_effort = settings.reasoning_effort
        client = build_llm(patched)
    else:
        client = services.llm
    services._director_llm_cache = client  # noqa: SLF001 — our own bundle, deliberate cache slot
    return client


def _extract_json(text: str) -> dict[str, Any] | None:
    """Best-effort: the first {...} object in a possibly chatty completion."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def _player_context(services: Services, ctx: AgentCtx) -> tuple[str, str]:
    """``(tracker lines, scene line)`` — through the PLAYER projection, always.

    This is the one place the Director reads room state, and it reads it exactly as a
    player client does: `PLAYER_VIEWER` drops keeper-only trackers spec and value, and
    ships only keeper-exposed MVU leaves. There is deliberately no branch here that
    could ask for more.
    """
    try:
        view = await services.documents.get_view(ctx.chat_key, MODVARS_DOC_TYPE, MODVARS_DOC_ID, PLAYER_VIEWER)
        entries = wire_entries(view or {}, ctx.locale)
    except Exception:  # noqa: BLE001 — a room without trackers still gets its beat staged
        entries = []
    trackers = "\n".join(f"- {entry.get('label')}: {entry.get('value')}" for entry in entries) or "(none)"
    try:
        scene_view = await services.documents.get_view(ctx.chat_key, "scene", SCENE_ID, PLAYER_VIEWER) or {}
    except Exception:  # noqa: BLE001
        scene_view = {}
    scene = " · ".join(str(scene_view.get(key)) for key in ("name", "focus") if scene_view.get(key)) or "(unset)"
    return trackers, scene


def _build_prompt(kit: RoomKit, beat: str, player_text: str, reply_text: str, trackers: str, scene: str) -> str:
    subjects = "\n".join(
        f"- {item.subject.id} | {item.subject.kind} | {item.subject.display_name(None)}"
        + ("" if item.generatable else _NO_REF_NOTE)
        for item in kit.subjects
    ) or "(none)"
    cues = "\n".join(f"- {item.cue.id} | {item.cue.layer} | {item.cue.title or item.cue.id}" for item in kit.cues) or "(none)"
    templates = "\n".join(
        _BLOCK_TEMPLATES[kind] for kind in _BLOCK_TEMPLATES if kit.allows_template(kind)
    ) or _NO_TEMPLATES_NOTE
    images_allowed = kit.generates and kit.allows_template("image")
    image_rule = _RULE_GENERATION if images_allowed else _RULE_NO_GENERATION
    return _PROMPT.format(
        beat=beat,
        max_blocks=MAX_BLOCKS,
        pregen=0 if not images_allowed else MAX_AUDIO_CUES,
        image_rule=image_rule,
        templates=templates,
        style=" / ".join(kit.style) or "(none declared)",
        palette=", ".join(kit.palette) or "(none declared)",
        banned=", ".join(kit.banned) or "(nothing declared)",
        subjects=subjects,
        cues=cues,
        trackers=trackers,
        scene=scene,
        player=player_text[:_MAX_TURN_TEXT],
        reply=reply_text[:_MAX_TURN_TEXT],
    )


async def _json_state(services: Services, chat_key: str, key: str, default: Any) -> Any:
    raw = await services.store.state_get(chat_key, key)
    if not raw:
        return default
    try:
        return json.loads(raw)
    except ValueError:
        return default


async def _generate_subject(
    services: Services, ctx: AgentCtx, kit: RoomKit, subject_id: str, prompt: str
) -> tuple[str | None, str]:
    """Generate (or serve from the 慢菜先备 larder) one subject's picture.

    Returns ``(media hash, outcome)`` — the hash is ``None`` whenever the kit, the budget
    or the provider said no, and the outcome NAMES which of them did. The reason is the
    load-bearing half: a whole session that produced zero pictures used to be
    indistinguishable from a session nobody asked for one in (run 2, 2026-08-19).

    Ref-mandatory is enforced HERE as well as in the prompt: a subject with no readable
    reference image never reaches the provider, whatever the model asked for.
    """
    settings = services.settings.director
    larder = await _json_state(services, ctx.chat_key, PREGEN_KEY, {})
    if isinstance(larder, dict) and isinstance(larder.get(subject_id), str):
        return larder[subject_id], IMAGE_LARDER
    if not settings.images or not kit.generates or not kit.allows_template("image") or services.imagegen is None:
        return None, IMAGE_IMAGEGEN_OFF
    entry = kit.subject(subject_id)
    if entry is None or not entry.generatable:
        logger.info("director: refusing to generate %r (no 定妆 reference in the kit)", subject_id)
        return None, IMAGE_REF_MISSING
    spent = await _json_state(services, ctx.chat_key, SPENT_KEY, 0)
    spent = spent if isinstance(spent, int) else 0
    if spent >= max(0, settings.max_images):
        logger.info("director: image budget spent for %s (%d)", ctx.chat_key, spent)
        return None, IMAGE_BUDGET

    full_prompt = ". ".join(
        part
        for part in (
            entry.subject.prompt,
            str(prompt or "")[:_MAX_PROMPT_CHARS],
            " / ".join(kit.style),
            ("palette: " + ", ".join(kit.palette)) if kit.palette else "",
            ("avoid: " + ", ".join(kit.banned)) if kit.banned else "",
        )
        if part
    )
    try:
        reference = entry.ref_path.read_bytes() if entry.ref_path is not None else None
        data, mime = await services.imagegen.generate(
            full_prompt,
            size=services.settings.imagegen.size,
            reference=reference,
            reference_mime=entry.ref_mime,
        )
    except Exception as exc:  # noqa: BLE001 — a dead image provider must not break the table
        logger.info("director: image generation failed for %r: %s", subject_id, exc)
        return None, IMAGE_PROVIDER_FAILED

    digest = await _store_picture(services, ctx, subject_id, data, mime)
    await services.store.state_set(ctx.chat_key, SPENT_KEY, json.dumps(spent + 1))
    return digest, IMAGE_GENERATED


async def _store_picture(services: Services, ctx: AgentCtx, subject_id: str, data: bytes, mime: str) -> str:
    """Put one subject's picture into the room's media store and the 慢菜先备 larder.

    `register_blob` is content-addressed and returns the existing record for bytes the
    room already holds, so re-storing the same picture costs nothing.
    """
    from infra.media_store import ALLOWED_IMAGE_MIMES, MediaStore

    tui = services.settings.tui
    store = MediaStore(
        services.store,
        services.settings.data_dir,
        max_file_bytes=tui.media_max_file_bytes,
        room_quota_bytes=tui.media_room_quota_bytes,
        allowed_mimes=ALLOWED_IMAGE_MIMES,
    )
    record = await store.register_blob(
        room=ctx.chat_key,
        data=data,
        mime=mime,
        name=f"{subject_id}.png",
        uploader=ctx.uid(),
    )
    larder = await _json_state(services, ctx.chat_key, PREGEN_KEY, {})
    larder = larder if isinstance(larder, dict) else {}
    larder[subject_id] = record.hash
    await services.store.state_set(ctx.chat_key, PREGEN_KEY, json.dumps(larder, ensure_ascii=False))
    return record.hash


async def _show_reference(services: Services, ctx: AgentCtx, kit: RoomKit, subject_id: str) -> str | None:
    """Serve the subject's own 定妆 reference when generation could not run.

    The kit already ships an authored, on-model picture of every generatable subject —
    it is the very image a generation would have been conditioned on. A room with no
    image provider, a spent budget or a dead vendor showed the table NOTHING rather than
    that (run 2, 2026-08-19: fourteen 定妆 references on disk, zero pictures all
    session). Generation still wins whenever it is available; this is only what happens
    after it has already declined.

    Costs no generation budget — nothing was generated — and rides the same media path,
    so the hash a client fetches is a real room asset.
    """
    entry = kit.subject(subject_id)
    if entry is None or entry.ref_path is None or not entry.ref_path.is_file():
        return None
    try:
        data = entry.ref_path.read_bytes()
    except OSError:
        logger.info("director: reference for %r is unreadable", subject_id, exc_info=True)
        return None
    if not data:
        return None
    try:
        return await _store_picture(services, ctx, subject_id, data, entry.ref_mime or "image/png")
    except Exception:  # noqa: BLE001 — presentation must never break the table
        logger.info("director: could not show the reference for %r", subject_id, exc_info=True)
        return None


async def _publish(
    hub: RoomHub | None,
    services: Services,
    ctx: AgentCtx,
    blocks: list[dict[str, Any]],
    cues: list[tuple[Any, str]],
) -> None:
    """Broadcast one beat's staging: `ui` frames first (the visual), then audio."""
    from gateway.audio import build_audio_control
    from gateway.hub import Event
    from gateway.ui_media import filter_ui_media

    if blocks:
        frames = sanitize_ui_emissions([{"blocks": blocks, "panel": "inline"}])
        for frame in await filter_ui_media(services, ctx.chat_key, frames):
            if hub is not None:
                await hub.publish(ctx.chat_key, Event.ui(frame))
    for cue, action in cues:
        try:
            control, state = await build_audio_control(
                services.store,
                ctx.chat_key,
                layer=cue.cue.layer,
                action=action,
                item=cue.audio_item() if action == "play" else None,
                loop=cue.cue.layer != "sfx",
            )
        except ValueError:
            continue
        if hub is None:
            continue
        await hub.publish(ctx.chat_key, Event.audio(control))
        if state is not None:
            await hub.publish(ctx.chat_key, Event.audio(state))


async def run_director(
    services: Services,
    ctx: AgentCtx,
    player_text: str,
    reply_text: str,
    *,
    beat: str,
    hub: RoomHub | None = None,
) -> bool:
    """Stage ONE beat. Returns whether anything was published. Never raises.

    Called fire-and-forget after the reply has already streamed, so a slow image or a
    dead provider costs the table nothing.
    """
    settings = services.settings.director
    if not settings.enabled or beat not in BEATS or not reply_text.strip():
        return False

    from gateway.presentation import load_room_kit

    def _trace(*, blocks: int, cues: int, prepared: int, image: dict[str, Any]) -> None:
        trace_event(
            DIRECTOR_TRACE_KIND,
            {"beat": beat, "blocks": blocks, "cues": cues, "prepared": prepared, "image": image},
            chat_key=ctx.chat_key,
        )

    kit = await load_room_kit(services, ctx.chat_key, ctx.locale)
    if not kit:
        # a room whose modules ship no kit has nothing authored to stage
        _trace(blocks=0, cues=0, prepared=0, image={"outcome": IMAGE_KIT_MISSING})
        return False

    trackers, scene = await _player_context(services, ctx)
    prompt = _build_prompt(kit, beat, player_text, reply_text, trackers, scene)
    try:
        result = await _director_llm(services).chat([{"role": "user", "content": prompt}])
    except Exception as exc:  # noqa: BLE001 — presentation must never break the table
        logger.debug("director: llm call failed: %s", exc)
        _trace(blocks=0, cues=0, prepared=0, image={"outcome": IMAGE_PROVIDER_FAILED})
        return False
    parsed = _extract_json(result.content or "")
    if parsed is None:
        _trace(blocks=0, cues=0, prepared=0, image={"outcome": IMAGE_NONE})
        return False

    raw_blocks = parsed.get("blocks")
    blocks = [
        block
        for block in (raw_blocks if isinstance(raw_blocks, list) else [])[:MAX_BLOCKS]
        # The kit's `templates:` allowlist binds the OUTPUT too, not just the offer —
        # a model that stages a shape the author excluded gets that block dropped here.
        if isinstance(block, dict) and kit.allows_template(str(block.get("kind") or ""))
    ]

    image = parsed.get("image")
    image_trace: dict[str, Any] = {"outcome": IMAGE_NONE}
    if isinstance(image, dict) and image.get("subject"):
        subject_id = str(image["subject"])
        image_trace = {"subject": subject_id, "outcome": IMAGE_TEMPLATE_DENIED}
        if kit.allows_template("image"):
            digest, outcome = await _generate_subject(
                services, ctx, kit, subject_id, str(image.get("prompt") or "")
            )
            if not digest:
                # Generation declined — no provider, spent budget, a dead vendor. The
                # kit's own 定妆 reference is an authored picture of this very subject,
                # so show that rather than nothing (`_show_reference`).
                digest = await _show_reference(services, ctx, kit, subject_id)
                if digest:
                    outcome = IMAGE_REF_FALLBACK
            image_trace = {"subject": subject_id, "outcome": outcome}
            if digest:
                entry = kit.subject(subject_id)
                caption = entry.subject.display_name(ctx.locale) if entry is not None else ""
                blocks.insert(0, {"kind": "image", "hash": digest, "caption": caption})
                image_trace["hash"] = digest

    cues: list[tuple[Any, str]] = []
    raw_audio = parsed.get("audio")
    for item in (raw_audio if isinstance(raw_audio, list) else [])[:MAX_AUDIO_CUES]:
        if not isinstance(item, dict):
            continue
        entry = kit.cue(str(item.get("cue") or ""))
        action = str(item.get("action") or "play")
        if entry is not None and action in ("play", "stop"):
            cues.append((entry, action))

    await _publish(hub, services, ctx, blocks, cues)

    # 慢菜先备: warm likely-next subjects AFTER this beat is on screen, so the latency
    # lands in the quiet turns instead of in front of a player.
    prepared = 0
    prepare = parsed.get("prepare")
    if isinstance(prepare, list) and kit.generates and kit.allows_template("image"):
        for subject_id in prepare[: max(0, settings.pregen_per_beat)]:
            _spawn_pregen(services, ctx, kit, str(subject_id))
            prepared += 1

    _trace(blocks=len(blocks), cues=len(cues), prepared=prepared, image=image_trace)
    return bool(blocks or cues)


_PREGEN_TASKS: set[asyncio.Task] = set()


def _spawn_pregen(services: Services, ctx: AgentCtx, kit: RoomKit, subject_id: str) -> None:
    """Warm one subject in the background (fire-and-forget, failures swallowed)."""

    async def _warm() -> None:
        try:
            await _generate_subject(services, ctx, kit, subject_id, "")  # (hash, outcome) unused here
        except Exception:  # noqa: BLE001
            logger.debug("director: pre-generation of %r failed", subject_id, exc_info=True)

    task = asyncio.create_task(_warm())
    _PREGEN_TASKS.add(task)
    task.add_done_callback(_PREGEN_TASKS.discard)


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="director_images",
        owner="agent.stage_director",
        reset_scope="story",
        # Owner verdict 2026-08-14: both go with the session. The pre-generation larder is
        # keyed by subject id, so a new story reusing a name would have inherited the old
        # story's portrait of it; the spend counter goes too, so "how many images did this
        # story cost" is a question about THIS story.
        state_keys=frozenset({SPENT_KEY, PREGEN_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
