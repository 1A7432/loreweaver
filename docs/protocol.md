*English · [中文](protocol.zh.md)*

# loreweaver networked TUI — wire protocol v1

This is the open, versioned wire protocol between a loreweaver server (started via
`python -m app --serve`) and the OpenTUI terminal client. The engine itself
(deterministic core + AI Keeper) is unaffected by transport; the transport-neutral
session logic is `net.session.SessionCore`, and this document is the language-agnostic seam.

Frames are JSON objects, each shaped `{"type": ...}`. Protocol version: `"1.3"`. The same
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

Versioning is additive: `"1.3"` adds room audio library/control frames; `"1.2"` adds media metadata frames and byte channels; `"1.1"` added the keeper-gated `admin_*` frames
(see "Admin frames" below). A client that only understands `"1"` keeps working
unchanged — it never sends `admin_*` frames, and it should treat the `welcome`
`protocol` field as an opaque string (accept any `"1.x"`).

The first frame a client sends MUST be `join`. The server replies with
either `welcome` or `error`, closing the connection on error. If it doesn't
arrive within the server's join-handshake timeout (`TRPG_TUI__JOIN_TIMEOUT`,
default 10s), the server closes the connection with `error join_timeout`
rather than waiting forever. A connection accepted over the server's
concurrent-connection cap (`TRPG_TUI__MAX_CONNECTIONS`) is refused before
`join` is even read: `error too_many_connections`, then closed.

## Client → Server

- `join` — authenticate and bind the connection to a room:
  `{type:"join", key:string, name?:string, client?:{name,version}}`
- `input` — a command line or player utterance, exactly what the player typed:
  `{type:"input", text:string}`
- `media_offer` — request to upload image/audio metadata before opening the byte channel:
  `{type:"media_offer", name:string, mime:string, size:int, sha256:string}`
- `media_set_enabled` — keeper-only room switch for player uploads:
  `{type:"media_set_enabled", enabled:boolean}`
- `ping`: `{type:"ping", t:number}`

## Server → Client

- `welcome` — sent once, on a successful `join`:
  `{type:"welcome", protocol:"1.3", features:["media","audio"], room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string}`
- `error` — a localized failure notice; `bad_key`, `join_timeout` and
  `too_many_connections` close the connection (they only ever happen during
  or before the `join` handshake), the others do not:
  `{type:"error", code:"bad_key"|"bad_frame"|"rate_limited"|"server_error"|"join_timeout"|"too_many_connections"|media error codes, message:string}`
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
- `narrative` — one line of story/chat text:
  `{type:"narrative", id:string, speaker:"kp"|"player"|"system"|"npc", name?:string, text:string, format:"markdown"|"plain", stream?:boolean, done?:boolean}`
  For `speaker:"npc"`, `name` carries the NPC name.
  Streaming is multiple frames sharing the same `id` with `stream:true`,
  terminated by a frame with `done:true`; a non-streaming reply is simply a
  single frame with neither field set.
- `dice` — one dice roll/check, rendered client-side and color-coded by
  `rank` (`-2`..`+4`); NEVER carries keeper secrets:
  `{type:"dice", actor:string, kind:"roll"|"check"|"sanity"|"opposed"|"init", expr:string, rolls:number[], total:number, target?:number, rank?:int, level?:string, success?:boolean}`
- `state` — a panel snapshot, sent on `join` and after every turn:
  `{type:"state", character?:{name,system,hp,hpmax,mp,mpmax,san,sanmax,attributes:{},status_effects:[],avatar?:{hash,mime,size,name?}}, party:[{name,online:boolean,active:boolean,initiative?:int,hp?:int,hpMax?:int,san?:int,sanMax?:int,mp?:int,mpMax?:int,ai?:boolean,avatar?:{hash,mime,size,name?}}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int, usage?:{context_tokens:int,context_window:int,input_tokens:int,output_tokens:int,cache_hit_tokens:int,cache_miss_tokens:int}}`
  `usage` is a rolling per-room LLM token/cache aggregate (additive/optional — omitted
  until the room's first completed AI-KP turn, and never sent by a pre-1.1 server):
  `context_tokens`/`context_window` describe the MOST RECENT turn's context fullness;
  `input_tokens`/`output_tokens`/`cache_hit_tokens`/`cache_miss_tokens` are summed across
  every turn in the room's session so far.
- `presence` — the connected-player roster, sent on join/leave:
  `{type:"presence", players:[{id,name,online}], online:int}`
- `system` — an out-of-band notice: `{type:"system", level:"info"|"warn", text:string}`
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
   Otherwise, `run_kp_turn(ctx, services, toolset, text,
   output_review=censor)` drives the AI Keeper and returns a
   `KPTurnResult`.
5. For each `tool_trace` entry that is a dice/check tool (`roll_dice`,
   `skill_check`, `sanity_check`, `opposed_check`, `initiative_tracker`),
   broadcasts a `dice` frame parsed from its result.
6. For each `tool_trace` entry named `speak_as_npc`, broadcasts
   `narrative{speaker:"npc", name, text, format:"markdown"}` before the final
   KP reply. `name` is the tool call's `npc` argument and `text` is the
   player-safe tool result.
7. Broadcasts the reply as `narrative{text: reply}` — `speaker:"system"` for
   a command reply, `speaker:"kp", format:"markdown"` for an AI Keeper
   reply. The reply is already censored; keeper-only tool outputs never
   reach this frame (the loop guarantees that — see `agent/loop.py`).
8. Rebuilds and broadcasts a `state` frame (`net.state.build_room_state`).

Multiple clients whose keys map to the same room share one AI-KP session;
every frame described above as "broadcast" goes to every member currently
connected to that room.

## Media transfer (v1.2+) and audio (v1.3)

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

## Admin frames (v1.1, keeper-gated)

A deployer/keeper can manage the server from the client's keeper screens (Rooms &
invites, Model) over the SAME connection, using a **keeper-role
key**: the keystore role stamped on the connection at `join` is the admin gate —
there is no separate auth. The server answers these ONLY for a `keeper`
connection; any other connection gets `admin_error{code:"forbidden"}` and nothing
is read or mutated. Implemented in `net/admin.py`.

Client → server:

- `admin_get_config` — `{type:"admin_get_config"}`
- `admin_set_model` — switch the live LLM provider/model, and optionally set this
  provider's key/base_url (blank = keep the saved one). The server remembers the
  credential per provider, so a later switch back to it needs no key:
  `{type:"admin_set_model", provider:string, chat_model?:string, api_key?:string, base_url?:string}`
- `admin_list_models` — fetch a provider's live model catalog (OpenAI-compatible
  `GET /models`). All fields optional: omit to list the current provider; pass
  `provider` (+ optional `api_key`/`base_url`) to preview another before switching:
  `{type:"admin_list_models", provider?:string, api_key?:string, base_url?:string}`
- `admin_list_keys` — `{type:"admin_list_keys"}`
- `admin_mint_key` — mint a room access key:
  `{type:"admin_mint_key", room:string, name?:string, role?:"player"|"keeper"}`
- `admin_update_key` — update one key by its stable non-secret id:
  `{type:"admin_update_key", id:string, room?:string, name?:string, role?:"player"|"keeper"}`
- `admin_delete_key` — delete one key by id:
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
- `admin_list_skills` — list every discoverable KP skill (Layer B.1), marked
  `enabled` per the CALLER's own room: `{type:"admin_list_skills"}`
- `admin_enable_skill` — enable/disable one skill for the caller's room; replies
  a fresh `admin_skills`: `{type:"admin_enable_skill", id:string, on:boolean}`
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
  provider catalog, the providers that already have a saved key (`saved_providers`),
  and whether a runtime override is active:
  `{type:"admin_config", provider:string, chat_model:string, base_url:string, api_key_masked:string, providers:string[], saved_providers:string[], override_active:boolean}`
- `admin_models` — a provider's live model catalog (empty when the provider is a
  native SDK, the key is missing/invalid, or `/models` is unreachable — the client
  falls back to a free-text model field):
  `{type:"admin_models", provider:string, models:string[]}`
- `admin_keys` — the room-key roster; every entry's key value is masked. A
  `mint` request additionally returns the freshly minted key ONCE in cleartext
  under `minted` (so the keeper can copy it):
  `{type:"admin_keys", keys:[{id:string, key_masked:string, room:string, name:string, role:"player"|"keeper"}], minted?:{key:string, room:string, name:string, role:"player"|"keeper"}}`
- `admin_room_op` — result for export/import/full-delete room operations:
  `{type:"admin_room_op", action:"export"|"import"|"delete", room:string, path?:string, keys:number, store_rows:number, vector_points:number}`
- `admin_error` — a localized failure notice (does not close the connection):
  `{type:"admin_error", code:"forbidden"|"unknown_provider"|"bad_request"|"set_failed"|"not_found"|"op_failed", message?:string}`
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

`admin_set_model` validates `provider` against the known providers
(`infra.providers.is_known_provider`), persists the override via
`services.runtime_config`, and hot-reconfigures the shared `MutableLLM` — the
same path as the `.model set` chat command — then replies a fresh
`admin_config`. A key set here is also saved to a per-provider credential book
(`infra.runtime_config.CredentialBook`), so switching providers never re-asks for
a key you've already entered; `admin_list_models` reuses that saved credential
when no explicit `api_key` is supplied. A key minted here is written back to the
server's keys file, so it survives a restart.

The provider catalog is additive. `chatgpt` / `gpt-subscription` are accepted as
OpenAI-compatible proxy aliases only; they require `TRPG_LLM__BASE_URL` to point
at a gateway controlled by the deployment. They do not represent direct
ChatGPT web-subscription login/session access.

Room backup snapshots contain the room's raw access keys as well as campaign
state and vector points. Treat exported JSON like `keys.toml` or the SQLite
database: it is sensitive server-side data and should not be shared publicly.

## Additive v1 NPC frames

This adds AI-played, knowledge-scoped NPC sub-actors
(`agent/npc.py`, `agent/npc_actor.py`, `agent/kp_tools_npc.py`). The server
surfaces each `speak_as_npc` tool result as an additional
`narrative{speaker:"npc", name:<npc>, format:"markdown"}` frame before the
KP's own narration. This is v1-compatible and additive: existing
`speaker:"kp"|"player"|"system"` frames and clients that ignore unknown
speaker values are unaffected.
