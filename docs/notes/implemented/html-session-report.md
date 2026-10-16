# Implemented: the HTML session report (`.report html`, `.report html reveal`) — protocol 2.4

- **Problem:** the session report ("团报") existed only as Markdown — a chat reply or a
  file on the SERVER's disk. Over the network a player had no way to keep it, and the
  table had no way to look behind the screen once the campaign was over.
- **Decision:** two editions of ONE self-contained HTML page (`core/report_html.py`,
  stylesheet `assets/session_report.css` inlined; no scripts, fonts, images or links;
  light/dark/print; phone width). Zero model calls.
  - **Player edition** (`.report html`, any member): exactly the data the Markdown
    report already uses — the scoreboard over `_visible_rolls` (hidden `.rh` rolls are
    neither shown nor counted), the dice log, and the transcript from `load_chain`, cut
    by the same `transcript_window` the Markdown report now shares. It reads no document
    at all.
  - **Reveal edition** (`.report html reveal`, keeper-key connection only): the player
    edition plus a separate "behind the screen" surface — hidden rolls, the chronicle's
    keeper margins, module truths/threats/unfound clues/NPC secrets, keeper-only
    variables and unexposed MVU leaves. Every document is read through
    `core.documents.project(…, KEEPER_VIEWER)`, and "what was hidden" is decided by
    diffing the keeper projection against the player projection of the same document —
    never by reading a secrecy flag off a raw document. A world-card room has no module
    pool; that part is omitted, not an error.
- **Why the reveal edition goes ONLY to the keeper's connection.** It is a keeper-grade
  view delivered privately, exactly like `.chronicle`: gated on the authenticated keeper
  role, answered to the issuing connection alone. Iron rule #3 therefore needs no
  exception — nothing keeper-only crosses a player-grade projection; the keeper simply
  reads their own material. What the keeper does with the file afterwards (share it at
  the wrap-up) is the keeper's call, as it is with everything they already know.
- **Why the blobs are hidden from every listing.** The page travels as a room media blob
  (`data_dir/media/<room>/<sha256>` + `media_index`) so it can use the existing byte
  channel, but `media_index` gained an `audience` column: `room` (ordinary media),
  `members` (player edition), `keeper` (reveal). Unlisted blobs are never broadcast as
  `media`, never written to the media history a join replays, never exported. Every
  lookup that names no audience sees listed media only, so avatar binding, `ui` image
  reachability and upload dedupe cannot touch them; the media GET passes the
  connection's authenticated role, and a `keeper` blob fetched by a player is
  `media_not_found` through the same path as an unknown hash — no oracle. `text/html`
  is not an upload type, and the store refuses to index HTML under the `room` audience.
  The delivery notice is a new `report` frame attached as a private command event, so
  it reaches the issuer only.
- **Why clients must not render it inline.** The page is untrusted table text (player
  input, imported card prose, NPC names). The server escapes everything and emits no
  script, but a client UI is not the sandbox the page was written for; a browser opening
  a local file is. So the protocol says: save the file, optionally hand it to the system
  browser, never draw it in your own UI. The terminal client saves it to
  `~/Downloads/loreweaver` (when a Downloads folder exists) or `~/.loreweaver/reports`
  and prints the path.
- **Lifecycle.** Report blobs are part of the `room_media` facet: they die at
  `.reset all` and on room delete, count against the image quota, and a room export
  carries listed media only, so a load drops them with the other extras. A
  story-scope disposal was considered and left out — the media table is a
  whole-storage wipe exactly one facet may claim, and a reset hook must name its
  storage (`tests/architecture/test_room_facets.py`), so it would have needed a change
  to the facet rules.
- **Local CLI:** no byte channel — the page is written to the shared reports path and
  the reply names it.
- **Rule home:** `gateway/report_export.py` and `core/report_html.py` module docstrings;
  `docs/protocol.md` (`report` frame, media transfer item 4).
- **Date:** 2026-10-16.
