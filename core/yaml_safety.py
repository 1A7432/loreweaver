"""Shared YAML-loading safety net against alias-bomb ("billion laughs"-style) documents.

PyYAML's ``SafeLoader`` supports YAML anchors/aliases (``&anchor`` / ``*alias``): an alias reuses
the SAME already-constructed Python object its anchor built. That is fine for one level, but
NESTED anchors (``&a [*b, *b]`` referencing ``&b [*c, *c]`` referencing ..., N levels deep) let a
tiny document expand into an EXPONENTIAL structure the moment anything walks or stringifies it
(``str()``, string concatenation, recursive serialization) — a few hundred bytes of frontmatter can
turn into tens of millions of characters and seconds of CPU, on the shared event loop, before a
single byte is ever written to disk. `core.skills` and `core.rulepacks` both call `str(...)` on
raw `yaml.safe_load` output (frontmatter `name`, `alias:`/`set_keys:` entries) and are both
LLM-authored-content parse targets (`agent.forge`), so both need the same rejection.

This module is the ONE place that rejects aliases, so every caller (`core.skills`,
`core.rulepacks`, `agent.forge`) gets identical behavior instead of each maintaining its own
loader subclass. Nothing here ever ``eval``/``exec``s anything: `NoAliasSafeLoader` is a plain
`yaml.SafeLoader` that additionally refuses `&anchor`/`*alias` nodes outright, at the point an
alias is FIRST composed — before any expansion happens, not after the tree is already built.
"""

from __future__ import annotations

from typing import Any

import yaml


class NoAliasSafeLoader(yaml.SafeLoader):
    """A `yaml.SafeLoader` that raises on any YAML alias node (`*name`).

    Overrides `compose_node` (the Composer step that turns the next parse event into a node) to
    check for an `AliasEvent` FIRST and raise before delegating to the real implementation —
    `yaml.SafeLoader` never even attempts to resolve/reuse the anchored object, so nested aliases
    can never expand in the first place. An ordinary document with no anchors/aliases at all
    parses byte-identically to plain `yaml.safe_load`.
    """

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.events.AliasEvent):
            event = self.peek_event()
            # Internal diagnostic only (mirrors the analogous ValueError diagnostics in
            # `core.skills`/`core.rulepacks`, both allowlisted in `scripts/i18n_allowlist.txt`
            # for the same reason): never shown raw to a player, only ever folded into an
            # already-localized `agent.forge.*` template (see `agent/forge.py`'s `ForgeResult`).
            raise yaml.YAMLError(f"yaml aliases are not allowed (line {event.start_mark.line + 1})")  # i18n-exempt
        return super().compose_node(parent, index)


def safe_load_no_aliases(text: str) -> Any:
    """`yaml.safe_load(text)`, but reject any document that uses an anchor/alias (`&`/`*`).

    Drop-in replacement for every `yaml.safe_load` call in this codebase that parses
    LLM-authored or otherwise untrusted YAML/frontmatter (`core.skills`, `core.rulepacks`,
    `agent.forge`): identical output to `yaml.safe_load` for any document that doesn't use
    anchors/aliases, and raises `yaml.YAMLError` for one that does — closing off the alias-bomb
    class of attack (see `NoAliasSafeLoader`) at parse time, before the result is ever handed to
    calling code.
    """
    return yaml.load(text, Loader=NoAliasSafeLoader)
