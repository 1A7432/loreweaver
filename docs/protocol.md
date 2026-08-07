*English · [中文](protocol.zh.md)*

# loreweaver networked TUI — wire protocol 2.1

This is the open, versioned wire protocol between a loreweaver server (started via
`python -m app --serve`) and the OpenTUI terminal client. The engine itself
(deterministic core + AI Keeper) is unaffected by transport; the transport-neutral
session logic is `net.session.SessionCore`, and this document is the language-agnostic seam.

Frames are JSON objects, each shaped `{"type": ...}`. Protocol version: `"2.1"`. The same
frames + `join` handshake ride the transport; only the carrier + its framing differ:

- **Iroh** (the transport `--serve` starts) — peer-to-peer QUIC. The server
  (`net.iroh_server`) binds an endpoint on the custom ALPN `loreweaver/tui/1` and prints a
  shareable **ticket**; a client dials the ticket (no domain/TLS/port-forward). A QUIC
  bidirectional stream is a raw byte stream, so control frames are **newline-delimited** JSON — one
  compact `{...}\n` per frame — over one long-lived `open_bi`/`accept_bi` stream. Media bytes use
  additional bidirectional streams on the same connection; see "Media transfer" below.
- **WebSocket** (`net.tui_server`, endpoint `ws://host:port/`, one JSON object per message) —
  kept ONLY as the offline test / loopback carrier; JSON control frames are text messages, and
  media bytes are binary messages; see "Media transfer" below. It is not a `--serve` option.

Both carriers drive the same `SessionCore`/`RoomHub`.

**Versioning.** The major version is the compatibility contract: a client and server
must agree on the major (`2`), and a client should refuse (or clearly warn on) a
`welcome.protocol` with a different major. Minor versions within a major are additive;
a client ignores frame types and fields it does not recognize.

**2.1 (additive, M19)** adds the presentation surface: the `image` block kind and the
four performance templates (`letter`, `clipping`, `map_pin`, `title_card`) in the `ui`
vocabulary and in panel templates; `visible_when` on panel template blocks; and
`state` `Resource.label` resolved to the viewer's own locale. A 2.0 client ignores an
unknown block kind and an unknown template field, so it degrades to exactly what it
rendered before.

`"2.0"` was a BREAKING consolidation of the 1.x line. What it broke, and the wart each
break settles:

- `dice` frames are redesigned around the engine's neutral check-outcome contract: the
  1.x CoC-shaped `rank:int(-2..4)` / `level:string` fields are gone; a graded check
  carries `outcome:{id,label,success,critical,fumble,tier,margin?}` and clients color
  by the semantic flags instead of embedding one system's rank ladder. The 1.x
  `kind:"sanity"` becomes the generic `kind:"subsystem"` + a `subsystem` id, and
  system-shaped extras (bonus/penalty tens dice, SAN loss, luck spend, advantage
  candidates) ride an opaque `detail` object.
- Streaming is two frame types with one rule: `narrative_delta` frames carry text
  deltas for a draft bubble; the ONE closing `narrative` frame with the same `id`
  carries the FULL final text and REPLACES the draft. The 1.x tail-suffix `done`
  frame, the `stream`/`done` booleans, and the "a plain narrative supersedes an open
  draft" rule are gone — post-generation corrections simply land in the final text.
- `state.character` / `state.party[]` vitals ride one generic
  `resources:[{id,label,value,max}]` list; the 1.x per-system field names (`hp`,
  `hpmax`, `san`, …) and the `hpmax`-vs-`hpMax` casing split are gone.
- Dice frames come ONLY from structured tool payloads; the 1.x server fallback that
  re-parsed a tool's localized text to guess a rank no longer exists.

The first frame a client sends MUST be `join`. The server replies with
either `welcome` or `error`, closing the connection on error. If it doesn't
arrive within the server's join-handshake timeout (`TRPG_TUI__JOIN_TIMEOUT`,
default 10s), the server closes the connection with `error join_timeout`
rather than waiting forever. The offline WebSocket test carrier also supports a
concurrent-connection cap (`TRPG_TUI__MAX_CONNECTIONS`): excess test-carrier
connections receive `error too_many_connections` before `join` is read.

## Client → Server

- `join` — authenticate and bind the connection to a room:
  `{type:"join", key:string, name?:string, client?:{name,version}}`
- `input` — a command line or player utterance, exactly what the player typed:
  `{type:"input", text:string}`
- `media_offer` — request to upload image/audio metadata before opening the byte channel:
  `{type:"media_offer", name:string, mime:string, size:int, sha256:string}`
- `media_set_enabled` — keeper-only room switch for player uploads:
  `{type:"media_set_enabled", enabled:boolean}`
- `avatar_set` — bind one already-uploaded image in this room to the caller's
  own active character. The server rejects frames that try to name another
  character/user:
  `{type:"avatar_set", hash:string}`
- `panel_intent` — a module-panel interaction. The server first checks
  the named panel is in THIS member's own manifest (else `error forbidden`), then routes
  the value exactly as if the member typed it — the panel privilege model in one move:
  `choice` and `input` submit `value` verbatim through the normal input choke (rate
  limits, turn lock, command privilege gates all apply); `roll` runs a public
  `.r <value>` as that player, so the real dice engine validates the expression.
  `value` is capped at 2000 chars (`error input_too_long`):
  `{type:"panel_intent", panel:string, kind:"choice"|"input"|"roll", value:string}`
- `ping`: `{type:"ping", t:number}`

## Server → Client

- `welcome` — sent once, on a successful `join`:
  `{type:"welcome", protocol:"2.1", features:["media","audio", "imagegen"?, "demo"?, "update"?], room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string, version?:string}`
  `version` is the server's own release version (compare it to the client's to detect a mismatch). The `"update"` feature appears only for a keeper on a server whose operator configured a self-update command, and gates the `admin_update_server` control.
  `demo` means the server is using its offline sample Keeper, vector support is
  enabled, and this specific Keeper room was empty when the server checked it.
  The server rechecks under the room turn lock before setup, so a stale flag cannot
  overwrite campaign state. An `admin_config{using_demo:false}` refresh (for example,
  after saving on the model screen) removes it immediately; otherwise reconnecting
  recalculates it, and a stale action is rejected server-side.
- `error` — a localized failure notice; `bad_key`, `join_timeout` and
  `too_many_connections` close the connection (they only ever happen during
  or before the `join` handshake), the others do not:
  `{type:"error", code:"bad_key"|"bad_frame"|"input_too_long"|"rate_limited"|"server_error"|"join_timeout"|"too_many_connections"|"demo_unavailable"|media error codes, message:string}`
- `media_accept` — upload accepted; if `existing` is true, no PUT is needed:
  `{type:"media_accept", upload_id:string, existing?:boolean, media?:MediaFrame, audio?:AudioLibraryItem}`
- `media` — media metadata broadcast and history replay entry; bytes are fetched on demand:
  `{type:"media", id:string, hash:string, mime:string, size:int, name:string, from:string, ts:number}`
- `media_enabled` — reply to a keeper upload-switch request:
  `{type:"media_enabled", enabled:boolean}`
- `audio_library_item` — a room audio-library entry created from an uploaded audio blob:
  `{type:"audio_library_item", id:string, hash:string, mime:string, size:int, name:string, from:string, ts:number, title?:string, license?:string, source?:string, tags?:string[]}`
- `audio_control` — playback intent for local clients:
  `{type:"audio_control", id:string, action:"play"|"stop"|"pause"|"resume"|"volume", layer:"bgm"|"ambience"|"sfx", hash?:string, mime?:string, name?:string, title?:string, loop?:boolean, volume?:number, fade_ms?:int, position_ms?:int, server_ts?:number}`
- `audio_state` — best-effort persisted BGM/ambience state, replayed on join:
  `{type:"audio_state", layers:[{layer:"bgm"|"ambience"|"sfx", hash?:string, mime?:string, name?:string, title?:string, playing:boolean, volume?:number, loop?:boolean, started_at?:number}]}`
- `narrative` — one COMPLETE line of story/chat text:
  `{type:"narrative", id:string, speaker:"kp"|"player"|"system"|"npc", name?:string, text:string, format:"markdown"|"plain"}`
  For `speaker:"npc"`, `name` carries the NPC name. A `narrative` frame always
  carries the full, final text. When its `id` matches a draft bubble the client
  accumulated from `narrative_delta` frames, the final text REPLACES that
  draft (post-generation corrections are already folded in); otherwise it is a
  plain one-shot line.
- `narrative_delta` — one streaming text delta for a draft bubble:
  `{type:"narrative_delta", id:string, speaker:"kp", name?:string, text:string}`
  Clients concatenate deltas sharing an `id` into a draft bubble (render as
  markdown). The stream ends when the `narrative` frame with the SAME `id`
  arrives; servers guarantee that closing frame (even on a failed turn, which
  closes with the text streamed so far). Servers stream the AI-KP's reply as it
  generates, sanitized fail-closed (machinery/MVU blocks never stream).
- `dice` — one dice roll/check, rendered client-side; NEVER carries keeper secrets:
  `{type:"dice", actor:string, kind:"roll"|"check"|"subsystem"|"opposed"|"init", expr:string, rolls:number[], total:number, target?:number, effective_target?:number, subsystem?:string, outcome?:Outcome, detail?:object}`
  `Outcome = {id:string, label:string, success:boolean, critical:boolean, fumble:boolean, tier:number, margin?:number}`
  `outcome` is present on graded checks: `id` is the rule system's own rank
  vocabulary (presentation only — never branch on it), `label` is the
  already-localized display label, and clients color by the semantic flags
  (`critical`/`fumble`/`success`) and may shade by `tier` (the ladder ordinal;
  higher is better). `kind:"subsystem"` marks a rule-subsystem check
  (`subsystem` names it, e.g. a sanity check); `kind:"opposed"` carries
  `detail.left`/`detail.right` (`{name,total,target?,outcome?}`) and
  `detail.winner:"left"|"right"|"tie"`. `detail` is otherwise system-declared
  roll data (bonus/penalty dice, loss/remaining, advantage candidates, …) a
  client may surface verbatim but never needs to understand.
- `ui` — declarative module UI emitted by the room's event hooks
  (`emitUI(blocks, opts?)` in a skill's / card's `hooks.js` — see `docs/plugins.md`),
  broadcast right after the KP `narrative` it annotates and before the `state`
  snapshot. Blocks are whitelisted, validated and size-capped server-side
  (`core.hooks`), so clients may render them as-is. The content is PLAYER-VISIBLE
  authorial output on the same trust stance as narration: hooks must never emit
  keeper-only secrets into it, and the engine never routes keeper tool results into
  this frame. Not replayed on join — a hook that wants a persistent panel simply
  re-emits it each turn:
  `{type:"ui", blocks:[UiBlock], panel:"inline"|"sidebar", id?:string, replace?:boolean}`
  `UiBlock = {kind:"meter", label:string, value:number, min:number, max:number}`
  `| {kind:"stat", label:string, value:number|string|boolean}`
  `| {kind:"badge", label:string, tone?:"info"|"warn"|"danger"}`
  `| {kind:"text", text:string, style?:"quote"|"warning"}`
  `| {kind:"divider"}`
  `| {kind:"choices", prompt?:string, options:[{id:string,label:string,input:string}]}`
  `| {kind:"image", hash:string, mime?:string, size?:int, caption?:string, alt?:string}`
  `| {kind:"letter", body:string, from?:string, to?:string, date?:string}`
  `| {kind:"clipping", headline:string, body:string, source?:string, date?:string}`
  `| {kind:"map_pin", hash:string, mime?:string, size?:int, label:string, x:number, y:number, note?:string}`
  `| {kind:"title_card", title:string, subtitle?:string, act?:string}`
  The last four are the M19 PERFORMANCE templates: declarative, not markup. A rich
  client styles a `letter` as stationery and a `title_card` as a full-bleed act card;
  a text-first client prints the same fields as lines. `map_pin`'s `x`/`y` are
  FRACTIONS of the map image's own box (0..1), so a client scales the marker to
  whatever size it draws the map at. They are emitted by the room's Stage Director
  (`agent.stage_director`) on story beats and are equally available to hooks and
  pack panels.
  An `image` block names a picture by CONTENT HASH — the same address the media byte
  channel answers (`{op:"get", hash}`). The server only ever emits a hash reachable
  from THIS room (its own media, or an asset of a pack enabled in it) and stamps the
  authoritative `mime`, so a client may fetch and cache it exactly like any other
  media; an unreachable hash is dropped server-side before the frame is built.
  Text-first clients degrade to the `caption`/`alt` line plus their usual media
  affordance.
  `panel:"inline"` renders into the narrative stream; `"sidebar"` into a persistent
  panel region. `id` names a UI region: a later sidebar frame with the same `id`
  replaces that region's content, and an inline frame with `replace:true` MAY update
  the prior inline frame with the same `id` in place (a client without in-place
  updates simply appends). Picking a `choices` option sends that option's `input`
  back verbatim as a NORMAL `input` frame — no new client→server frame type exists.
- `ui_manifest` — this VIEWER's complete module-panel list, sent on
  `join` right after the initial `state` frame and pushed to every connected member
  after a keeper's `.panels enable|disable`. FULL-REPLACE semantics: the frame carries
  the whole list (empty = no panels, which also clears stale panels on reconnect). The
  pack's `audience` declarations are resolved server-side per the viewer's keystore
  role BEFORE this frame is built — a keeper-only panel structurally never appears in
  a player's manifest, and `audience` itself never rides the wire. See "Module UI
  panels" below for the panel/template shapes:
  `{type:"ui_manifest", panels:[UiManifestPanel]}`
- `panel_event` — an opaque JSON payload a room hook emitted via
  `emitPanel(panelId, payload)` (see `docs/plugins.md`), for the named panel's own
  code (tier-2). Delivered — right after the turn's `ui` frames — ONLY to members
  whose manifest contains that panel; ≤ 20 per turn (excess dropped + logged) and
  ≤ 32 KB serialized per payload. Clients that do not run panel code (the TUI)
  simply ignore it:
  `{type:"panel_event", panel:string, payload:any}`
- `state` — a panel snapshot, sent on `join` and after every turn:
  `{type:"state", character?:{name,system,resources:[Resource],attributes:{},status_effects:[],avatar?:{hash,mime,size,name?}}, party:[{name,online:boolean,active:boolean,initiative?:int,resources?:[Resource],ai?:boolean,avatar?:{hash,mime,size,name?}}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int, usage?:{context_tokens:int,context_window:int,input_tokens:int,output_tokens:int,cache_hit_tokens:int,cache_miss_tokens:int}, variables?:[{id:string,label:string,kind:"number"|"bool"|"text"|"enum",value:number|boolean|string,min?:int,max?:int,hidden?:boolean}], pregens?:[{name:string,claimed_by:string}], reset?:boolean}`
  `Resource = {id:string, label:string, value:number, max?:number}` — the rule
  system's vital meters (HP, sanity, mana, …) as generic data: a client renders
  the list as meters without knowing any system's field names. Entries arrive in
  render order. `label` is already resolved to THIS viewer's locale: a rulepack may
  declare `sheet.resources[].label` as a locale map, so one pack's bars read
  correctly at an `en` and a `zh` connection of the SAME room.
  `variables[].hidden` marks a keeper-connection-only row the keeper has not `.var expose`d yet — players never receive hidden rows at all. `pregens` is the module's claimable cast (`.pc list`/`.pc claim`); `claimed_by` is the claiming member id, `""` while unclaimed; omitted when no roster exists.
  `variables` (optional — omitted when the room has none) is the room's
  deterministic module variables, PLAYER-VISIBLE subset only: keeper-only variables are
  filtered inside the engine (`core.modvars.player_entries`) and never reach any transport.
  Entries arrive in definition order (render as-is, don't sort); `label` is already localized
  to the room's locale; `min`/`max` appear only on bounded `number` variables (clients may
  render those as a meter). Imported SillyTavern MVU card variables ride the same list with
  `id` prefixed `mvu.` and the dotted path as `label` (scalar leaves only, server-capped) —
  no separate frame type, no client change required. MVU leaves are KEEPER-CURATED
  (fail-closed): a player frame carries only the paths the keeper exposed (`.var expose`);
  a keeper connection's own frames additionally carry the unexposed remainder, each entry
  flagged `hidden:true` (additive/optional — clients that ignore it simply render the
  entry; ones that understand it may dim or lock-mark it).
  `reset:true` marks the snapshot the server pushes right after a campaign wipe (`.reset` / `admin_reset_room`): the panel data is already fresh (empty) and the client should ALSO clear its locally-accumulated chat scrollback.
  `usage` is a rolling per-room LLM token/cache aggregate (additive/optional — omitted
  until the room's first completed AI-KP turn, and never sent by a pre-1.1 server):
  `context_tokens`/`context_window` describe the MOST RECENT turn's context fullness;
  `input_tokens`/`output_tokens`/`cache_hit_tokens`/`cache_miss_tokens` are summed across
  every turn in the room's session so far.
- `presence` — the connected-player roster, sent on join/leave:
  `{type:"presence", players:[{id,name,online}], online:int}`
- `system` — an out-of-band notice: `{type:"system", level:"info"|"warn", text:string, spinner?:boolean}`
- `turn_status` — ephemeral room-wide AI-KP activity. `busy` names the actor whose
  action is being resolved; `idle` clears the activity. Clients should animate their
  busy indicator and apply a safety timeout in case an end frame is lost:
  `{type:"turn_status", status:"busy", actor:string}` or
  `{type:"turn_status", status:"idle"}`
- `pong`: `{type:"pong", t:number}`

## Turn flow

On an `input` frame from a client in room `R`, the server:

1. Builds an `AgentCtx` from the room's `SessionSource` (`chat_key =
   "tui:group:{room}"`, `user_id` = the client's key-derived id, `locale`).
2. Pre-layer: `RateLimiter.allow(user)` + `allow(room)`; if blocked, sends
   `error rate_limited` to that client only (the turn stops there).
3. Broadcasts `narrative{speaker:"player", name, text}` to the whole room
   (everyone sees the action, including the sender).
4. If `CommandRouter.dispatch(ctx, text)` returns non-`None`, that string is
   the reply (a `.`/`/` command or a SealDice-style inline roll).
   Otherwise, the server broadcasts `turn_status{status:"busy", actor:name}`, then
   `run_kp_turn(ctx, services, toolset, text,
   output_review=censor)` drives the AI Keeper and returns a
   `KPTurnResult`.
5. For each `tool_trace` entry that is a dice/check tool (`roll_dice`,
   `skill_check`, `sanity_check`, `opposed_check`, `initiative_tracker`),
   broadcasts one `dice` frame per structured payload the tool bound during
   dispatch (a tool that emitted no payload emits no dice frame — frames are
   never reconstructed from tool text).
6. For each `tool_trace` entry named `speak_as_npc`, broadcasts
   `narrative{speaker:"npc", name, text, format:"markdown"}` before the final
   KP reply. `name` is the tool call's `npc` argument and `text` is the
   player-safe tool result.
7. Broadcasts the reply as `narrative{text: reply}` — `speaker:"system"` for
   a command reply, `speaker:"kp", format:"markdown"` for an AI Keeper
   reply. The reply is already passed through the configured output wordlist.
   Raw keeper-only tool results are never copied directly into this frame, but
   the main Keeper model has seen them and could restate them; that behavioral
   risk is measured separately by the live-model red-line eval.
8. Broadcasts one `ui` frame per emission the turn's event hooks buffered via
   `emitUI` — already validated and capped server-side; rooms
   with no hooks never see this frame.
9. Delivers one `panel_event` frame per emission the turn's hooks buffered via
   `emitPanel` — NOT a broadcast: each event reaches only members
   whose own manifest contains the target panel.
10. After the AI-KP branch (including error cleanup), broadcasts
    `turn_status{status:"idle"}`. Command replies do not emit turn status.
11. Rebuilds and broadcasts a `state` frame (`net.state.build_room_state`).

Multiple clients whose keys map to the same room share one AI-KP session;
every frame described above as "broadcast" goes to every member currently
connected to that room.

## Module UI panels

A `.lwpack` may ship named UI panels (`contents.panels` + `ui/panels.yaml` — authoring
guide in `docs/plugins.md`); a keeper admits an installed pack's panels to a room with
`.panels enable <packId>` (install ≠ enable, exactly like skills). The room manifest is
resolved per viewer and delivered via `ui_manifest` (above). The privilege model is one
sentence: **a panel acts as the player viewing it** — inbound it receives only that
viewer's filtered data, outbound (`panel_intent`) it can send only what that player
could type.

`UiManifestPanel` (audience never appears — it was resolved server-side):

```jsonc
{"id": "<packId>/<panelId>", "title": {"en": "...", "zh": "..."}, "slot": "sidebar|tray|modal",
 "tier": 1, "blocks": [/* template blocks */]}
// or tier 2:
{"id": "...", "title": {...}, "slot": "modal", "tier": 2,
 "entry": {"hash": "<sha256>", "size": 1234},
 "assets": [{"path": "app.js", "hash": "<sha256>", "size": 999, "mime": "text/javascript"}],
 "fallback": [/* template blocks */] /* or null */}
```

**Tier-1 template blocks** are the `ui` frame's `UiBlock` vocabulary with two additions the
CLIENT resolves against its OWN `state.variables` (ids exactly as they appear there —
modvar ids, `mvu.`-prefixed leaves):

- any scalar field may be `{"$var": "<variable id>"}`; the variable being absent/hidden
  for this viewer omits the WHOLE block (fail-closed — a panel can never widen
  visibility; the `state` wire filter remains the single choke point);
- `{"repeat": {"prefix": "<id prefix>", "block": <TemplateBlock>}}` renders one
  instance per visible variable whose id starts with the prefix (≤ 32 instances);
  inside, `{"$leaf": "id"|"label"|"value"}` substitutes the matched variable's field.

`image` and `map_pin` are the template blocks the server rewrites rather than passes
through: the author writes a pack-relative `src` path, and the manifest carries the
resolved `{hash, mime, size}` alongside the block's own (localized) fields —
addressing is decided by the pack build, so a panel can only point at a picture its
own pack ships. Fetch it over the media byte channel like a tier-2 asset. Every other
performance template is ordinary localized text; `map_pin`'s `x`/`y` may bind to
`{$var}` so a marker moves with the story.

**`visible_when` (2.1)** — any template block may carry `visible_when: "<condition>"`,
evaluated CLIENT-side against that viewer's own `state.variables`. `$var`'s
absent-means-hide cannot express a VALUE gate ("show once day >= 46"), and values move
at runtime, so a server-side per-viewer filter is impossible. The grammar is a
deliberately small, portable subset (the server refuses anything else at pack build, so
a condition that reaches you is always in it):

- comparisons `=== !== == != >= <= > <`; logic `&& || !` (word forms `and`/`or`/`not`);
- literals: numbers, `'strings'`, `"strings"`, `true`/`false`/`null`/`undefined`;
- references: bare dotted paths (CJK included), each looked up as a variable **id** in
  `state.variables`; an absent one is `null`.
- NOT in the subset: arithmetic, function calls (including `getvar`), bracket segments.

Semantics follow the reference implementation, not JavaScript's own operators: `==`/`!=`
coerce numeric strings, `===`/`!==` are strict (a bool is never strictly equal to a
number), and an unorderable comparison (`"abc" > 5`, `null > 5`) is an ERROR. **A
condition that errors, or that a client cannot evaluate, HIDES its block** — fail-closed,
the same rule as an unresolved `$var`. Hidden variables are dropped before evaluation,
so a condition can never surface what the wire filter withheld.
`tests/fixtures/visible_when_vectors.json` is the shared conformance table every
implementation runs.

Localized strings are `{en,zh}` maps; the client picks its locale (fallback `en`).
Picking a tier-1 `choices` option sends `panel_intent{kind:"choice", value: <option
input>}`. Text-first clients (the TUI) render tier-1 blocks with the existing block
renderer, fold `tray`/`modal` into sidebar sections, render a tier-2 panel's
`fallback` blocks, and show one localized "available in the rich client" line for an
explicit `fallback: null`.

**Tier-2 assets** are content-addressed: fetch each manifest hash over the EXISTING
media byte channel (`{op:"get", hash}` — see "Media transfer"); wire `path`s are
relative to the entry document's directory (each panel is a self-contained static
root). Verify the sha256 before caching (immutable, keyed by hash).

## Media transfer and audio

All media is server-stored and server-forwarded. The JSON control stream carries only metadata;
raw bytes never appear in JSON and are never base64-encoded. Supported upload MIME types are
`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml`, `audio/mpeg`, `audio/ogg`, `audio/wav`,
`audio/flac`, `audio/mp4`, and `audio/aac`. The default image limits are 8 MiB per file and
512 MiB per room; the default audio limits are 128 MiB per file and 2 GiB per room. Both share
the default 10 uploads per member per minute rate limit. The server treats media bytes as opaque
blobs; decoding and playback happen only in clients.

SVG is the exception to fully opaque storage: the server accepts only a safe, static subset
(`svg`, `g`, `rect`, `line`, `polyline`, `text`, `tspan`, `title`, `desc`) and rejects scripts,
foreignObject, event handlers, external links, data URLs, and CSS/url execution surfaces with
`error media_bad_svg`. TUI SVG previews parse that same static drawing information into terminal
text; they never execute SVG as browser content.

Upload flow:

1. Client sends `media_offer{name,mime,size,sha256}` on the control stream.
2. Server validates MIME, size, room quota, rate limit, and room upload switch, then sends
   `media_accept{upload_id}` or `error`. If the room already has the same hash, it may send
   `media_accept{upload_id:"", existing:true, media|audio}` and broadcast the metadata without a PUT.
3. Client sends PUT on the MediaChannel: header `{op:"put", upload_id}` plus raw bytes.
4. Server verifies exact size and sha256, stores `data_dir/media/<room>/<sha256>`, records
   `media_index(hash, room, mime, size, name, uploader, created_at)`, and broadcasts `media` for
   images or `audio_library_item` for audio.

Download flow:

1. Client sends GET on the MediaChannel: header `{op:"get", hash}`.
2. Server checks the hash belongs to the caller's room, then replies with `{op:"get",hash,size,mime,name}`
   plus raw bytes. The client should verify sha256 and may cache under
   `~/.loreweaver/cache/media/<hash>`.
3. A hash that is not room media additionally resolves against installed-pack
   assets of packs ENABLED in the caller's room — the panel asset path. Same reply
   shape; the server re-verifies the bytes against their manifest digest before
   serving. A hash from a pack the room has not enabled stays `media_not_found`
   (no arbitrary blob oracle).

MediaChannel wire formats:

- Iroh: open a new bidirectional stream on the existing connection. The stream begins with one
  newline-terminated compact JSON header. For PUT, the client then writes the raw body in chunks
  of up to 64 KiB; the server answers with one newline-terminated `{op:"put_ok", hash}` line once
  the blob is stored (or a `{type:"error", code, message}` line on rejection). For GET, the server
  writes one newline-terminated `{op:"get",hash,size,mime,name}` response header, then the raw
  body in chunks of up to 64 KiB; an error reply is a `{type:"error", ...}` line with no body.
- WebSocket: one binary message is `uint32_be header_length` + UTF-8 JSON header + raw bytes.
  PUT sends `{op:"put", upload_id}` plus the body; success is observed via the room's `media` /
  `audio_library_item` broadcast, and rejections arrive as standard `error` text frames. GET
  sends `{op:"get", hash}` with no body; the server replies with `{op:"get",hash,size,mime,name}`
  plus the body.

Audio control is intentionally separate from byte transfer. Uploading an audio file only creates
or updates the room's audio library. Keeper/admin commands such as `.bgm play <audio>`,
`.ambience stop`, and `.sfx <audio>` broadcast `audio_control` frames; TUI clients fetch the bytes
with the same GET flow and play them locally. The server never plays audio itself.

## Auth / keystore

There is no registration. A deployer runs an offline admin command to mint
a key bound to a room:

```
python -m app --tui-key add --room R --name N [--role player|keeper]
```

Keys live in a TOML file (default `keys.toml`, overridable with `--keys
FILE` or the `TRPG_TUI_KEYS` environment variable), one table per key:

```toml
["<opaque-key>"]
room = "R"
name = "N"
role = "player"  # or "keeper"; defaults to "player"
```

On `join`, the server looks up `key`; an unknown key is rejected with
`error bad_key` and the connection is closed. A recognized key binds the
connection to `SessionSource(platform="tui", chat_type="group",
chat_id=room, user_id="tui:" + sha1(key)[:8], user_name=name)` — see
`net/keystore.py` and the shipped `keys.example.toml`.

## Admin frames (keeper-gated)

A deployer/keeper can manage the server from the client's keeper screens (Rooms &
invites, Model) over the SAME connection, using a **keeper-role
key**: the keystore role stamped on the connection at `join` is the admin gate —
there is no separate auth. The server answers these ONLY for a `keeper`
connection; any other connection gets `admin_error{code:"forbidden"}` and nothing
is read or mutated. Implemented in `net/admin.py`.

Client → server:

- `admin_get_config` — `{type:"admin_get_config"}`
- `admin_set_model` — switch the live LLM provider/model, and optionally set this
  provider's key/base_url. Omitted fields reuse the provider's saved credential
  only while the endpoint is unchanged; an explicit empty value clears that
  field. Supplying a different `base_url` without a new `api_key` clears the old
  key, so it is never sent to the new endpoint. The server remembers credentials
  per provider, so a later switch back to an unchanged endpoint needs no key:
  `{type:"admin_set_model", provider:string, chat_model?:string, api_key?:string, base_url?:string}`
- `admin_set_imagegen` — configure the OpenAI-compatible image-generation
  endpoint. It follows the same endpoint/key isolation rule as `admin_set_model`:
  an omitted key is reusable only for the same endpoint, while changing
  `base_url` without a new key clears the old key:
  `{type:"admin_set_imagegen", provider:string, base_url?:string, model:string, api_key?:string, size?:string}`
- `admin_list_models` — fetch a provider's live model catalog (OpenAI-compatible
  `GET /models`). All fields optional: omit to list the current provider; pass
  `provider` (+ optional `api_key`/`base_url`) to preview another before switching:
  `{type:"admin_list_models", provider?:string, api_key?:string, base_url?:string}`.
  Previewing a different `base_url` never reuses a saved/current key unless that
  key is supplied on the same request. The reply also includes the current
  `imagegen` status.
- `admin_list_keys` — list access keys for the caller's bound room only:
  `{type:"admin_list_keys"}`
- `admin_mint_key` — mint an access key for the caller's bound room only; a
  different `room` is forbidden (the field may be omitted to select the caller's room):
  `{type:"admin_mint_key", room?:string, name?:string, role?:"player"|"keeper"}`
- `admin_update_key` — update one key by its stable non-secret id. Demoting the
  room's LAST keeper join key is refused with `admin_error{code:"last_keeper"}`
  (anti-lockout — mint a second keeper key first):
  `{type:"admin_update_key", id:string, room?:string, name?:string, role?:"player"|"keeper"}`
- `admin_delete_key` — delete one key by id; deleting the room's last keeper
  join key is refused the same way (`last_keeper`):
  `{type:"admin_delete_key", id:string}`
- `admin_delete_room` — delete every access key bound to a room; room data is
  left untouched:
  `{type:"admin_delete_room", room:string}`
- `admin_export_room` — write a room backup JSON file on the server. If `path`
  is omitted, the server writes under `<data_dir>/room_backups/`:
  `{type:"admin_export_room", room:string, path?:string}`
- `admin_import_room` — restore a server-side backup JSON. If `room` is
  supplied, the snapshot is remapped to that room before restoring:
  `{type:"admin_import_room", path:string, room?:string}`
- `admin_delete_room_data` — delete a room's access keys, room-scoped KV state,
  document vectors, and worldbook vectors. `backup` defaults to `true`; with
  backup enabled, deletion only proceeds after the backup write succeeds:
  `{type:"admin_delete_room_data", room:string, backup?:boolean, path?:string}`
- `admin_reset_room` — restart a campaign in place, keeping the keystore keys,
  channel/keeper bindings, live connections and room settings (language, house
  rules, enabled skills), so the table can start over without re-provisioning.
  No backup is taken and no members are evicted (contrast
  `admin_delete_room_data`). `scope` chooses how much to wipe: `"story"`
  (default) clears the story/progress only (keeps characters, module, lore,
  media); `"chars"` also rolls new characters (keeps the module); `"all"` erases
  everything (characters, module, lore, media). Keeper-gated and confined to the
  caller's own room:
  `{type:"admin_reset_room", room:string, scope?:"story"|"chars"|"all"}`
- `admin_list_skills` — list every discoverable KP skill (Layer B.1), marked
  `enabled` per the CALLER's own room. The optional `locale` (`"en"`/`"zh"`,
  additive) asks for skill display names/descriptions localized to the CLIENT's
  own UI language (for skills shipping `name-zh`/`description-zh` frontmatter),
  independent of the server locale; absent means the server locale applies:
  `{type:"admin_list_skills", locale?:string}`
- `admin_enable_skill` — enable/disable one skill for the caller's room; replies
  a fresh `admin_skills` (same optional `locale` hint):
  `{type:"admin_enable_skill", id:string, on:boolean, locale?:string}`
- `admin_list_rules` — list every discoverable rule system (Layer A):
  `{type:"admin_list_rules"}`
- `admin_generate` — author + install a brand-new skill/rule system/module from a
  natural-language description via the matching `agent.forge` self-extension
  engine (Layer B.3); a `kind:"module"` generation installs into the CALLER's own
  room. This is a slow LLM call answered as a normal request/reply — the client
  shows a spinner while it awaits `admin_generated`:
  `{type:"admin_generate", kind:"skill"|"rule"|"module", description:string}`

Server → client:

- `admin_config` — the live, display-safe LLM config (api_key masked), the
  provider catalog, the providers that already have a saved credential (`saved_providers`),
  whether a runtime override is active, and the display-safe image-generation
  status:
  `{type:"admin_config", provider:string, chat_model:string, base_url:string, api_key_masked:string, providers:string[], saved_providers:string[], override_active:boolean, imagegen?:ImageGenStatus, using_demo?:boolean, subscription_status?:""|"logged_in"|"logged_out"}`
  `using_demo` tracks the live offline fallback so a client can immediately remove
  a stale sample-adventure affordance. A true value alone does not authorize setup;
  only the room-scoped `welcome.features` check may add it.
  `subscription_status` is `"logged_in"` or `"logged_out"` when the current
  provider is on a ChatGPT / SuperGrok OAuth path. Empty or absent means the
  classic API-key path (including a `chatgpt` / `gpt-subscription` provider with
  an explicit proxy `base_url`). Login remains a private chat command
  (`.model login`); the TUI model page only displays the status.
- `admin_models` — a provider's live model catalog (empty when the provider is a
  native SDK, the key is missing/invalid, or `/models` is unreachable — the client
  falls back to a free-text model field):
  `{type:"admin_models", provider:string, models:string[], imagegen?:ImageGenStatus}`
- `ImageGenStatus` — `{provider:string, base_url:string, model:string, size:string, api_key_masked:string, has_key:boolean, configured:boolean, saved_providers?:string[]}`.
  The API key is never returned in cleartext.
- `admin_keys` — the caller's own room-key roster; every entry's key value is masked. A
  `mint` request additionally returns the freshly minted key ONCE in cleartext
  under `minted` (so the keeper can copy it):
  `{type:"admin_keys", keys:[{id:string, key_masked:string, room:string, name:string, role:"player"|"keeper"}], minted?:{key:string, room:string, name:string, role:"player"|"keeper"}}`
- `admin_room_op` — result for export/import/full-delete room operations:
  `{type:"admin_room_op", action:"export"|"import"|"delete"|"reset", room:string, path?:string, keys:number, store_rows:number, vector_points:number, media_files?:number, scope?:"story"|"chars"|"all"}`
  (`scope` is present on a `reset` op, echoing which reset scope was applied.)
- `admin_error` — a localized failure notice (does not close the connection):
  `{type:"admin_error", code:"forbidden"|"unknown_provider"|"bad_request"|"set_failed"|"not_found"|"op_failed"|"not_configured"|"last_keeper", message?:string}`
- `admin_skills` — every discoverable skill, `enabled` reflecting the caller's room:
  `{type:"admin_skills", skills:[{id:string, name:string, description:string, content_rating:string, enabled:boolean}]}`
- `admin_rules` — every discoverable rule system, `built_in` marking a shipped
  system (`coc7`/`dnd5e`) vs a generated/user-installed one:
  `{type:"admin_rules", systems:[{id:string, built_in:boolean}]}`
- `admin_generated` — the forge engine's outcome; `id`/`name` are empty and
  `error` carries an (untranslated) diagnostic when `ok` is `false`, and nothing
  was installed:
  `detail` carries the per-room install outcome — for `kind:"module"` it is the only signal of
  whether the module actually landed in the room (`ok` merely means a valid document was authored
  and written); it is empty for `skill`/`rule` (no per-room install step):
  `{type:"admin_generated", kind:"skill"|"rule"|"module", ok:boolean, id:string, name:string, error:string, detail:string}`
- `admin_update_server` — a keeper asks the server to update itself in place. No parameters: the
  server runs its OWN operator-configured command (`TRPG_TUI__UPDATE_COMMAND`, e.g.
  `git pull && uv sync`), never anything the client supplies, and requires the `"update"` feature
  (advertised in `welcome`). On success it re-execs into the new code, so the client should expect
  a brief disconnect + reconnect:
  `{type:"admin_update_server"}`
- `admin_update` — the reply to `admin_update_server`. `"restarting"`: the command succeeded and
  the server is re-execing. `"failed"`: the command exited non-zero; `output` is the tail of its
  combined stdout/stderr. (A missing command yields `admin_error{code:"not_configured"}`.):
  `{type:"admin_update", status:"restarting"|"failed", output?:string}`

`admin_set_model` validates `provider` against the known providers
(`infra.providers.is_known_provider`), persists the override via
`services.runtime_config`, and hot-reconfigures the shared `MutableLLM` — the
same path as the `.model set` chat command — then replies a fresh
`admin_config`. A key set here is also saved to a per-provider credential book
(`infra.runtime_config.CredentialBook`), so switching providers never re-asks for
a key you've already entered; `admin_list_models` reuses that saved credential
when no explicit `api_key` is supplied and the endpoint is unchanged. A newly
supplied endpoint is never paired with an older key: the caller must supply the
matching key on that request or the server uses/persists an empty key.
Subscription OAuth grants are stored in
the same local credential book under their canonical provider name.

The provider catalog is additive. `chatgpt` / `gpt-subscription` are dual-mode:
without a `base_url`, they use the ChatGPT subscription OAuth grant obtained by
`.model login chatgpt`; with an explicit `base_url`, they retain the classic
OpenAI-compatible proxy path and its API key. `supergrok` always uses the
SuperGrok subscription OAuth path (`.model login supergrok`) and can share that
grant with SuperGrok image generation.

Room backup snapshots contain the room's raw access keys as well as campaign
state and vector points. Treat exported JSON like `keys.toml` or the SQLite
database: it is sensitive server-side data and should not be shared publicly.

## NPC frames

AI-played, knowledge-scoped NPC sub-actors (`agent/npc.py`, `agent/npc_actor.py`,
`agent/kp_tools_npc.py`) surface as additional
`narrative{speaker:"npc", name:<npc>, format:"markdown"}` frames before the
KP's own narration. Clients that ignore unknown speaker values render them as
ordinary narrative lines.
