"""Layer B.3 — the KP self-extension engines ("a skill that creates skills/rule systems/modules").

See ``docs/plugins.md`` "Layer B". Three generators share one shape: ask the room's LLM to author
a complete artifact for a natural-language description, validate the result through the SAME
parser real discovery/ingestion uses -- writing NOTHING until that succeeds -- then install it and
make it immediately live.

- `generate_and_install_skill` (B.3a) -- a ``SKILL.md`` bundle, validated via
  `core.skills.parse_skill_text`, installed under `core.skills._USER_SKILL_DIR`.
- `generate_and_install_rulepack` (B.3b) -- a flat ``<id>.yaml`` rulepack, validated via
  `core.rulepacks.parse_rulepack_text` (including its `derived:` section compiling through the
  safe DSL), installed under `core.rulepacks._USER_RULEPACK_DIR`.
- `generate_and_install_module` (B.3b) -- a Markdown module/scenario document, installed as a flat
  ``<id>.md`` file under `_USER_MODULE_DIR` and then run through the EXISTING module-ingestion
  pipeline (`agent.kp_tools_knowledge.DocumentTools.upload_document`) so it lands in the CALLING
  room's own knowledge pool -- unlike the other two, this is per-room content, not a new global
  discovery registry.

Trust boundary (``docs/plugins.md`` "The trust boundary"): all three are still **data plugins**
even though the model wrote them -- no code ever runs. Nothing here `eval`/`exec`s anything; a
skill/rulepack is parsed with `yaml.safe_load` exactly like a hand-authored one, and a module is
opaque Markdown text handed to the same analysis pipeline a manual upload uses. The one privileged
operation each performs is a scoped filesystem write, confined by construction
(`_confined_target`/`_confined_file_target` assert the resolved path never escapes its directory)
and gated behind a `generate_*` tool (`agent.kp_tools_forge`), each itself gated (Layer B.2) and
invisible until its forge skill unlocks it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import core.rulepacks as rulepacks
import core.skills as skills
from agent.context import AgentCtx
from agent.kp_tools_knowledge import DocumentTools
from agent.services import Services

# A placeholder id used only to probe generated content for a name/title before the real id is
# known (see step (c) in each `generate_and_install_*` function) -- never written to disk, never
# shown to a user; chosen unlikely to collide with a real generated name.
_PROBE_ID = "_forge_probe"

_SLUG_OK_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# Cap the derived id so a pathologically long generated name can't slugify into a directory/file
# component longer than the filesystem allows (NAME_MAX) — which would raise OSError at write time.
_MAX_SLUG_LEN = 64

# Layer B.3b (`generate_and_install_module`) discovery target: a user data-dir `modules/`
# directory, set once at startup (`app.py`: `agent.forge._USER_MODULE_DIR =
# Path(settings.data_dir) / "modules"`). Unlike `_USER_SKILL_DIR`/`_USER_RULEPACK_DIR` this is NOT
# a discovery registry with built-ins to protect -- a generated module is per-room content
# (`ctx.chat_key`-scoped via the existing module-ingestion pipeline), so this directory is only a
# confined place to persist the generated Markdown before/while it is ingested. `None` (the
# default, and every test unless it opts in) means `generate_and_install_module` refuses with
# `"no_data_dir"`, exactly like the other two generators.
_USER_MODULE_DIR: Path | None = None


@dataclass(frozen=True)
class ForgeResult:
    """Outcome of a `generate_and_install_*` call (skill / rulepack / module).

    `skill_id`/`name` are the generic "installed id" / "display name" slots each generator fills in
    (a rulepack's system id/its first declared name, a module's slug/title) -- kept as one shared
    shape across all three generators rather than three near-identical dataclasses. `detail` is an
    optional extra payload only the module generator uses (the room-install confirmation from
    `agent.kp_tools_knowledge.DocumentTools.upload_document`); it is always `""` for skills/rulepacks.

    `error` is an internal (English, untranslated) diagnostic -- `agent.kp_tools_forge.ForgeTools`
    maps it to a localized string for the model/player. `"no_data_dir"` and a `"bad_id: ..."` /
    `"invalid_skill: ..."` / `"invalid_rulepack: ..."` / `"path_escape: ..."` / `"write_failed:
    ..."` prefix are the recognized shapes; callers that only care about success/failure should
    just check `ok`.
    """

    ok: bool
    skill_id: str
    name: str
    path: str
    error: str
    detail: str = ""


def _slugify(text: str) -> str:
    """Lowercase, collapse whitespace/underscores to `-`, strip everything else, and require the
    result to match `^[a-z0-9][a-z0-9-]*$`. Returns `""` when nothing safe survives (e.g. an
    all-CJK or all-punctuation name) -- the caller treats that as a rejection, never a fallback
    to unsafe input. Any path-shaped character (`/`, `\\`, `.`) is stripped, not preserved, so a
    traversal attempt (e.g. `"../../etc"`) sanitizes down to a plain, safe token (here: `"etc"`)
    rather than smuggling a path separator through into a directory name.
    """
    lowered = text.strip().lower()
    collapsed = re.sub(r"[\s_]+", "-", lowered)
    stripped = re.sub(r"[^a-z0-9-]", "", collapsed)
    slug = re.sub(r"-{2,}", "-", stripped).strip("-")
    if len(slug) > _MAX_SLUG_LEN:
        slug = slug[:_MAX_SLUG_LEN].rstrip("-")
    return slug if _SLUG_OK_RE.match(slug) else ""


def _unique_user_id(user_dir: Path, base: str) -> str:
    """Return `base`, else `base-2`, `base-3`, ... — the first id whose user-dir directory does
    NOT already exist and is not a built-in — so installing a generated skill never silently
    clobbers an existing user skill (or a built-in) of the same name."""
    candidate = base
    counter = 2
    while (user_dir / candidate).exists() or candidate in skills.built_in_skill_ids():
        candidate = f"{base}-{counter}"
        counter += 1
        if counter > 999:  # pathological guard; effectively unreachable
            return candidate
    return candidate


def _confined_target(user_dir: Path, skill_id: str) -> Path:
    """Resolve `<user_dir>/<skill_id>/SKILL.md`, asserting the result stays inside `user_dir`.

    Independent of `_slugify`: this rejects any `skill_id` that is not a plain safe slug — so `.`,
    `..`, `""`, and anything with a path separator are refused here directly (not merely by relying
    on `_slugify` never having a bug), which makes the confinement guard true and self-standing
    (see `tests/agent/test_forge.py`'s path-confinement test).
    """
    if not _SLUG_OK_RE.match(skill_id):
        raise ValueError(f"unsafe skill id (not a plain slug): {skill_id!r}")  # i18n-exempt
    base = user_dir.resolve()
    target = (user_dir / skill_id / "SKILL.md").resolve()
    if not target.is_relative_to(base):
        # Internal diagnostic only -- never shown raw; `generate_and_install_skill` folds it into
        # a `"path_escape: ..."` `ForgeResult.error`, localized by `agent.kp_tools_forge`.
        raise ValueError(f"refusing to write outside the user skill directory: {skill_id!r}")  # i18n-exempt
    return target


def _confined_file_target(user_dir: Path, entry_id: str, filename: str) -> Path:
    """Resolve `<user_dir>/<filename>`, asserting the result stays inside `user_dir`.

    A flat-file sibling of `_confined_target` (which assumes a `<id>/SKILL.md` directory shape):
    the rulepack (`<id>.yaml`) and module (`<id>.md`) generators each install a single flat file
    rather than a subdirectory, so they confine directly by filename. Independent of `_slugify`,
    same as `_confined_target`: `entry_id` (the id `filename` was derived from) must itself already
    be a plain safe slug -- `.`, `..`, `""`, and anything with a path separator are refused here
    directly, not merely by relying on `_slugify` never having a bug.
    """
    if not _SLUG_OK_RE.match(entry_id):
        raise ValueError(f"unsafe id (not a plain slug): {entry_id!r}")  # i18n-exempt
    base = user_dir.resolve()
    target = (user_dir / filename).resolve()
    if not target.is_relative_to(base):
        # Internal diagnostic only -- never shown raw; folded into a `"path_escape: ..."`
        # `ForgeResult.error`, localized by `agent.kp_tools_forge`.
        raise ValueError(f"refusing to write outside the user directory: {entry_id!r}")  # i18n-exempt
    return target


def _build_messages(services: Services, description: str) -> list[dict]:
    """The two-message prompt sent to `services.llm.chat`: the schema+example framing text
    (localized, mirroring `core.module_initializer._build_analysis_prompt`'s "framing text is
    localized" convention -- see `locales/{en,zh}/agent.json`'s `agent.forge.system_prompt`) as
    the system message, and the keeper's raw play-style `description` as the user message.
    """
    return [
        {"role": "system", "content": services.i18n.t("agent.forge.system_prompt")},
        {"role": "user", "content": description},
    ]


async def generate_and_install_skill(services: Services, description: str) -> ForgeResult:
    """Ask `services.llm` to author a SKILL.md for `description`, validate it, and install it.

    Never writes anything to disk before the generated text validates as a real `Skill` via the
    same parser `core.skills` discovery uses, never `eval`/`exec`s the model's output, and refuses
    both an empty/unsafe derived id and a collision with a built-in skill id. On success, installs
    under `core.skills._USER_SKILL_DIR` and reloads discovery (`core.skills.reload_skills()`) so
    the new skill is immediately visible to `.skill list` / `.skill enable`.
    """
    user_dir = skills._USER_SKILL_DIR
    if user_dir is None:
        return ForgeResult(False, "", "", "", "no_data_dir")

    result = await services.llm.chat(_build_messages(services, description))
    content = (result.content or "").strip()
    if not content:
        return ForgeResult(False, "", "", "", "empty_response")

    # Step (c): derive the slug BEFORE full validation, from the frontmatter `name` (falling back
    # to the caller's own description when the model omitted one). Reuses the same parser as the
    # real validation below; a parse failure here is reported as "invalid", not "bad_id" -- the id
    # can't be trusted to have been derived from anything meaningful when the frontmatter itself
    # doesn't parse.
    try:
        probe = skills.parse_skill_text(_PROBE_ID, content)
    except Exception as exc:
        return ForgeResult(False, "", "", "", f"invalid_skill: {exc}")

    name_source = probe.name if probe.name and probe.name != _PROBE_ID else description
    skill_id = _slugify(name_source)
    if not skill_id:
        # Internal diagnostic (see `ForgeResult.error`'s docstring) -- localized by
        # `agent.kp_tools_forge` via `agent.forge.bad_id`, never shown raw.
        return ForgeResult(False, "", "", "", "bad_id: could not derive a valid id from the generated name/description")  # i18n-exempt
    if skill_id in skills.built_in_skill_ids():
        return ForgeResult(False, "", "", "", f"bad_id: '{skill_id}' collides with a built-in skill")  # i18n-exempt

    # Step (d): the AUTHORITATIVE validation, re-parsed with the real id so `Skill.id` matches the
    # directory it will be written under. Nothing is written to disk before this succeeds.
    try:
        parsed = skills.parse_skill_text(skill_id, content)
    except Exception as exc:
        return ForgeResult(False, "", "", "", f"invalid_skill: {exc}")
    if not parsed.name.strip():
        return ForgeResult(False, "", "", "", "invalid_skill: generated SKILL.md has no name")  # i18n-exempt

    # Non-destructive install: if a user skill of this id already exists, uniquify (base-2, ...)
    # rather than silently overwriting someone's existing custom skill.
    skill_id = _unique_user_id(user_dir, skill_id)

    # Step (e): write, confined to the user skill directory.
    try:
        target = _confined_target(user_dir, skill_id)
    except ValueError as exc:
        return ForgeResult(False, "", "", "", f"path_escape: {exc}")

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        # A filesystem-level failure (permissions, name-too-long, disk) is reported through the same
        # ForgeResult contract as every other failure instead of escaping as an unhandled OSError.
        return ForgeResult(False, "", "", "", f"write_failed: {exc}")  # i18n-exempt

    # Step (f): make it discoverable immediately.
    skills.reload_skills()

    return ForgeResult(True, skill_id, parsed.name, str(target), "")


# ---------------------------------------------------------------------------
# Layer B.3b -- the rulepack generator: a "skill that creates rule systems."
# ---------------------------------------------------------------------------


def _unique_user_rulepack_id(user_dir: Path, base: str) -> str:
    """Rulepack analogue of `_unique_user_id`: a rulepack installs as a flat `<id>.yaml` file (not
    a `<id>/` directory), so existence is checked against the FILE. Also mirrors `_unique_user_id`
    in never landing on a built-in id, so a generated pack can never silently occupy `coc7`'s or
    `dnd5e`'s name even after the earlier explicit collision rejection in
    `generate_and_install_rulepack` -- defense in depth against the same class of bug.
    """
    candidate = base
    counter = 2
    while (user_dir / f"{candidate}.yaml").exists() or candidate in rulepacks.built_in_rulepack_ids():
        candidate = f"{base}-{counter}"
        counter += 1
        if counter > 999:  # pathological guard; effectively unreachable
            return candidate
    return candidate


def _build_rulepack_messages(services: Services, description: str) -> list[dict]:
    """The two-message prompt sent to `services.llm.chat` for rulepack authoring: the localized
    schema+example framing text (`agent.forge.rulepack_system_prompt`) as the system message, and
    the keeper's raw rule-system `description` as the user message -- mirrors `_build_messages`.
    """
    return [
        {"role": "system", "content": services.i18n.t("agent.forge.rulepack_system_prompt")},
        {"role": "user", "content": description},
    ]


async def generate_and_install_rulepack(services: Services, description: str) -> ForgeResult:
    """Ask `services.llm` to author a rulepack YAML for `description`, validate it, and install it.

    Mirrors `generate_and_install_skill` step for step, adapted for a rulepack's FLAT-FILE shape
    (`<id>.yaml`, not a `<id>/SKILL.md` directory): never writes anything to disk before the
    generated YAML validates as a real `RulePack` via the same builder
    (`core.rulepacks.parse_rulepack_text`) real discovery uses -- including its `derived:` section
    compiling through the safe DSL / named-computer vocabulary, so a bad derived spec raises and is
    rejected here -- and refuses both an empty/unsafe derived id and a collision with a built-in
    system id (`coc7`, `dnd5e`). On success, installs under `core.rulepacks._USER_RULEPACK_DIR` and
    reloads discovery (`core.rulepacks.reload_rulepacks()`) so the new system is immediately visible
    to `available_systems()`/`load_rulepack()`.
    """
    user_dir = rulepacks._USER_RULEPACK_DIR
    if user_dir is None:
        return ForgeResult(False, "", "", "", "no_data_dir")

    result = await services.llm.chat(_build_rulepack_messages(services, description))
    content = (result.content or "").strip()
    if not content:
        return ForgeResult(False, "", "", "", "empty_response")

    # Step (c): derive the slug BEFORE full validation, from the pack's declared `names:` (falling
    # back to the caller's own description when the model omitted any). A parse failure here is
    # reported as "invalid", not "bad_id" -- the id can't be trusted to have been derived from
    # anything meaningful when the YAML itself doesn't parse.
    try:
        probe = rulepacks.parse_rulepack_text(_PROBE_ID, content)
    except Exception as exc:
        return ForgeResult(False, "", "", "", f"invalid_rulepack: {exc}")

    name_source = probe.names[0] if probe.names else description
    pack_id = _slugify(name_source)
    if not pack_id:
        # Internal diagnostic (see `ForgeResult.error`'s docstring) -- localized by
        # `agent.kp_tools_forge` via `agent.forge.rulepack_bad_id`, never shown raw.
        return ForgeResult(False, "", "", "", "bad_id: could not derive a valid id from the generated names/description")  # i18n-exempt
    if pack_id in rulepacks.built_in_rulepack_ids():
        return ForgeResult(False, "", "", "", f"bad_id: '{pack_id}' collides with a built-in rulepack")  # i18n-exempt

    # Step (d): the AUTHORITATIVE validation, re-parsed with the real id. Nothing is written to
    # disk before this succeeds.
    try:
        parsed = rulepacks.parse_rulepack_text(pack_id, content)
    except Exception as exc:
        return ForgeResult(False, "", "", "", f"invalid_rulepack: {exc}")

    # Also refuse a pack that DECLARES a built-in's name/alias (not just a colliding id): the
    # built-in wins resolution anyway, so such a claim would be a dead alias -- reject it explicitly
    # rather than silently write a pack that half-shadows coc7/dnd5e. Nothing is written yet.
    if rulepacks.claims_built_in_alias((*parsed.names, *parsed.set_keys)):
        return ForgeResult(False, "", "", "", "bad_id: the generated pack claims a name/alias reserved by a built-in system")  # i18n-exempt

    # Non-destructive install: if a user rulepack of this id already exists, uniquify (base-2, ...)
    # rather than silently overwriting someone's existing custom pack.
    pack_id = _unique_user_rulepack_id(user_dir, pack_id)

    # Step (e): write, confined to the user rulepack directory.
    try:
        target = _confined_file_target(user_dir, pack_id, f"{pack_id}.yaml")
    except ValueError as exc:
        return ForgeResult(False, "", "", "", f"path_escape: {exc}")

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        # A filesystem-level failure (permissions, name-too-long, disk) is reported through the same
        # ForgeResult contract as every other failure instead of escaping as an unhandled OSError.
        return ForgeResult(False, "", "", "", f"write_failed: {exc}")  # i18n-exempt

    # Step (f): make it discoverable immediately.
    rulepacks.reload_rulepacks()

    display_name = parsed.names[0] if parsed.names else pack_id
    return ForgeResult(True, pack_id, display_name, str(target), "")


# ---------------------------------------------------------------------------
# Layer B.3b -- the module generator: a "skill that creates modules," installed PER-ROOM via the
# existing module-ingestion pipeline (not a global discovery registry like skills/rulepacks).
# ---------------------------------------------------------------------------

_MODULE_TITLE_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def _extract_module_title(content: str) -> str:
    """Best-effort title extraction: the first level-1 Markdown heading (`# Title`) in the
    generated document, or `""` if it has none -- callers fall back to the keeper's own
    description in that case, same as the skill/rulepack generators falling back from an omitted
    frontmatter `name`/`names`.
    """
    match = _MODULE_TITLE_RE.search(content)
    return match.group(1).strip() if match else ""


def _unique_user_module_id(user_dir: Path, base: str) -> str:
    """Module analogue of `_unique_user_id`/`_unique_user_rulepack_id`: a generated module installs
    as a flat `<id>.md` file. Unlike skills/rulepacks there is no built-in-id namespace to protect
    here -- a module is per-room content ingested through the normal document pipeline, not a
    discovery registry with built-ins -- so only existing files in the shared user module
    directory are avoided.
    """
    candidate = base
    counter = 2
    while (user_dir / f"{candidate}.md").exists():
        candidate = f"{base}-{counter}"
        counter += 1
        if counter > 999:  # pathological guard; effectively unreachable
            return candidate
    return candidate


def _build_module_messages(services: Services, description: str) -> list[dict]:
    """The two-message prompt sent to `services.llm.chat` for module authoring: the localized
    framing text (`agent.forge.module_system_prompt`) as the system message, and the keeper's raw
    scenario `description` as the user message -- mirrors `_build_messages`/`_build_rulepack_messages`.
    """
    return [
        {"role": "system", "content": services.i18n.t("agent.forge.module_system_prompt")},
        {"role": "user", "content": description},
    ]


async def generate_and_install_module(services: Services, ctx: AgentCtx, description: str) -> ForgeResult:
    """Ask `services.llm` to author a module/scenario document for `description`, then install it
    into THIS ROOM's (`ctx.chat_key`) knowledge pool via the EXISTING module pipeline -- never a
    new bespoke one.

    Unlike the skill/rulepack generators (a global, discovery-based data-dir), a module is per-room
    content: the generated Markdown is written to a confined file under `_USER_MODULE_DIR`
    (path-confined + id-sanitized exactly like the other two generators), then handed to
    `agent.kp_tools_knowledge.DocumentTools.upload_document(ctx, ..., doc_type="module")` -- the
    SAME ingestion + full-text-analysis path the `.module` command / a manual upload uses -- so the
    resulting keeper/player knowledge pools land under `ctx.chat_key`, not some new store shape.
    `ForgeResult.detail` carries `upload_document`'s own localized confirmation (chunk count,
    module-init status, etc.) -- the room-install summary. `ok=True` reflects that a valid module
    document was authored and written to disk; if the room-install step itself couldn't complete
    (e.g. no filesystem adapter on this `ctx`, or the vector DB disabled), `detail` carries THAT
    explanation instead of a success confirmation -- callers should surface `detail` to the keeper
    either way rather than only checking `ok`.
    """
    user_dir = _USER_MODULE_DIR
    if user_dir is None:
        return ForgeResult(False, "", "", "", "no_data_dir")

    result = await services.llm.chat(_build_module_messages(services, description))
    content = (result.content or "").strip()
    if not content:
        return ForgeResult(False, "", "", "", "empty_response")

    title = _extract_module_title(content) or description
    module_id = _slugify(title)
    if not module_id:
        # Internal diagnostic (see `ForgeResult.error`'s docstring) -- localized by
        # `agent.kp_tools_forge` via `agent.forge.module_bad_id`, never shown raw.
        return ForgeResult(False, "", "", "", "bad_id: could not derive a valid id from the generated title/description")  # i18n-exempt

    # Non-destructive install: if a generated module of this id already exists on disk, uniquify
    # (base-2, ...) rather than silently overwriting an earlier generation.
    module_id = _unique_user_module_id(user_dir, module_id)

    # Write, confined to the user module directory. Nothing downstream (the room install) runs
    # before this succeeds.
    try:
        target = _confined_file_target(user_dir, module_id, f"{module_id}.md")
    except ValueError as exc:
        return ForgeResult(False, "", "", "", f"path_escape: {exc}")

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        # A filesystem-level failure (permissions, name-too-long, disk) is reported through the same
        # ForgeResult contract as every other failure instead of escaping as an unhandled OSError.
        return ForgeResult(False, "", "", "", f"write_failed: {exc}")  # i18n-exempt

    # Reuse the EXISTING module-ingestion pipeline verbatim (docs/plugins.md, this module's own
    # docstring): chunk + embed into the vector store, and (since doc_type="module") auto-trigger
    # `services.module_init.initialize` -- so `ctx.chat_key`'s keeper/player knowledge pools are
    # built by the exact same code a manual `.module` upload runs, not a parallel bespoke path.
    doc_tools = DocumentTools(services)
    install_note = await doc_tools.upload_document(ctx, file_path=str(target), doc_type="module")

    return ForgeResult(True, module_id, title, str(target), "", detail=install_note)
