# Implemented: presentation kit v2 — the promised template allowlist and palette

- **Problem:** the M19 spec promised the kit carries an "allowed template list +
  palette"; the landed v1 schema never did (UPSTREAM_TODO item 12 tracked the gap),
  so the studio's kit wizard had no 模板配色 surface to build against and an author
  could not narrow which performance shapes their module's Stage Director stages.
- **Decision (owner, 2026-08-15): extend the schema, no backward compatibility.**
  `KIT_VERSION` is 2 and v1 files are rejected outright — one clean break under the
  standing no-backcompat sanction, no dual-schema reader. `templates:` is an
  allowlist over the five Director-performable shapes
  (`image`/`title_card`/`letter`/`clipping`/`text`); omitted/empty = all allowed
  (preserves v1 behavior). It binds three places: the bullets the Director is
  offered, the parsed output (a disallowed block is dropped), and the
  imagegen/pregen lanes (`image` excluded = no generation, budget untouched).
  `style.palette:` is a list of hex-or-color-word strings spliced into the
  Director's brief and every generated image's prompt.
- **Merge policy across packs in one room:** `templates` INTERSECT — a second pack's
  allowlist can only narrow, never widen a stricter author's choice back open (the
  same direction as the `generates` AND / 宁缺毋滥); `palette` unions in declaration
  order (like `style` lines). `RoomKit.templates` distinguishes None (no pack
  restricts) from an honestly-empty intersection.
- **Cross-repo:** the studio's kit wizard, `buildPresentationYaml`, and the
  round-trip fixture must move to v2 and may then add the template/palette UI —
  recorded in the studio's `UPSTREAM_TODO.md` closure notes.
- **Rule home:** `core/presentation.py` (schema authority);
  `gateway/presentation.py` `RoomKit` (merge policy); `docs/plugins.md` Layer D.
- **Date:** 2026-08-15.
