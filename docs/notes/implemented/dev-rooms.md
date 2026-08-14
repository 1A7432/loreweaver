# Implemented: dev rooms — mount a pack source dir, reload on save

- **Problem:** an author's iteration loop was edit → `--pack` → `--install` →
  re-import, a minute of ceremony per change (the H2 plan's Bomb-1 "Author DX" item,
  needed for dogfooding the flagship module). Worse, a re-import could not even land
  an edit: `core.worldbook.add` dedupes by entry id, so re-importing an edited
  lorebook silently kept every stale text.
- **Decision:** `.dev mount <path>` (keeper command, `gateway/dev_room.py`) mounts a
  pack SOURCE tree into the room. A per-room asyncio watcher polls mtimes
  (no new dependency) and on change re-syncs: remove the lore this mount wrote last
  time (by document provenance — `import_entries` now stamps `meta.source`, the
  one-line gap this feature exposed), re-import world-detected cards through the real
  `.import … world` path and lorebooks through the real `.lore import` path, clear the
  skill/rulepack discovery caches, push `ui_manifest` + state. Live values survive by
  the existing contracts (InitVar merge, modvar redefinition, pregen replace-keeping-
  claims). Discovery integration is three registries: a virtual pack home in
  `gateway.panels` (dev home wins over an installed pack of the same id; source
  manifests get their asset digests stamped on the fly so panel integrity holds) and
  extra scan dirs in `core.skills` / `core.rulepacks` (built-ins still win).
- **Confinement (networked-admin posture):** mounts resolve only under
  `TRPG_DEV__SOURCE_ROOT`; unset = the whole surface is off. A server-path read never
  ships open by default.
- **Lock discipline (defensive-patterns #1):** the `.dev` command paths are already
  inside the transport choke points' turn lock and never re-acquire; the watcher is
  the ONE out-of-band caller and takes `hub.turn_lock` itself before mutating.
- **Ground truth is the persisted record** (`room_state["dev_mount"]`, facet
  `reset_scope="all"`): the watcher re-checks it every cycle, so a `.reset all`, room
  import or restore that cleared it stops the sync instead of re-seeding a fresh
  room; room deletion cancels the watcher via the facet's `on_delete`. After a server
  restart any `.dev` command re-arms the watcher (deliberate v1 — the studio's
  host-local flow issues one anyway).
- **Deliberate limits:** unmount stops the sync but keeps imported content (the room
  keeps playing what it has); dev homes skip build-only caps (panel code size), so
  `--pack` remains the release gate; character-half cards are not auto-imported
  (players claim them, as in real play).
- **Rule home:** `gateway/dev_room.py` module docstring; `docs/authoring.md` §8 (the
  author-facing loop); AGENTS.md "How to extend" pointer.
- **Date:** 2026-08-15.
