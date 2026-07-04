"""Layer B.3a — the KP skill-generation engine ("a skill that creates skills").

See ``docs/plugins.md`` "Layer B". `generate_and_install_skill` asks the room's LLM to author a
complete ``SKILL.md`` for a natural-language play-style description, validates the result through
the SAME frontmatter+body parser real skill discovery uses (`core.skills.parse_skill_text`) --
writing NOTHING until that succeeds -- then installs it under the user skill data-dir
(`core.skills._USER_SKILL_DIR`) and reloads discovery so it is live immediately.

Trust boundary (``docs/plugins.md`` "The trust boundary"): this is still a **declarative skill**
even though the model wrote it -- no code ever runs. Nothing here `eval`/`exec`s anything; the
produced text is plain Markdown+YAML, parsed with `yaml.safe_load` exactly like a hand-authored
skill. The one privileged operation is a scoped filesystem write, confined to `_USER_SKILL_DIR` by
construction (`_confined_target` asserts the resolved path never escapes it) and gated behind the
`generate_skill` tool (`agent.kp_tools_forge`), which is itself gated (Layer B.2) and invisible
until the `skill-forge` skill unlocks it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import core.skills as skills
from agent.services import Services

# A placeholder id used only to probe the generated frontmatter for a `name` field before the
# real skill id is known (see step (c) in `generate_and_install_skill`) -- never written to disk,
# never shown to a user; chosen unlikely to collide with a real generated name.
_PROBE_ID = "_forge_probe"

_SLUG_OK_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# Cap the derived id so a pathologically long generated `name:` can't slugify into a directory
# component longer than the filesystem allows (NAME_MAX) — which would raise OSError at write time.
_MAX_SLUG_LEN = 64


@dataclass(frozen=True)
class ForgeResult:
    """Outcome of `generate_and_install_skill`.

    `error` is an internal (English, untranslated) diagnostic -- `agent.kp_tools_forge.ForgeTools`
    maps it to a localized string for the model/player. `"no_data_dir"` and a `"bad_id: ..."` /
    `"invalid_skill: ..."` / `"path_escape: ..."` prefix are the recognized shapes; callers that
    only care about success/failure should just check `ok`.
    """

    ok: bool
    skill_id: str
    name: str
    path: str
    error: str


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
