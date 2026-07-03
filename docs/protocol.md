*English · [中文](protocol.zh.md)*

# loreweaver networked TUI — wire protocol v1

This is the open, versioned wire protocol between a loreweaver server (started via
`python -m app --serve`) and the OpenTUI terminal client. The engine itself
(deterministic core + AI Keeper) is unaffected by transport; the transport-neutral
session logic is `net.session.SessionCore`, and this document is the language-agnostic seam.

Frames are JSON objects, each shaped `{"type": ...}`. Protocol version: `"1.1"`. The same
frames + `join` handshake ride the transport; only the carrier + its framing differ:

- **Iroh** (the transport `--serve` starts) — peer-to-peer QUIC. The server
  (`net.iroh_server`) binds an endpoint on the custom ALPN `loreweaver/tui/1` and prints a
  shareable **ticket**; a client dials the ticket (no domain/TLS/port-forward). A QUIC
  bidirectional stream is a raw byte stream, so frames are **newline-delimited** JSON — one
  compact `{...}\n` per frame — over one long-lived `open_bi`/`accept_bi` stream. Rich media
  (images/audio, roadmap) will ride this transport (via iroh-blobs).
- **WebSocket** (`net.tui_server`, endpoint `ws://host:port/`, one JSON object per message) —
  kept ONLY as the offline test / loopback carrier; the offline test suite drives the
  transport-neutral logic through it. It is not a `--serve` option.

Both carriers drive the same `SessionCore`/`RoomHub`.

Versioning is additive: `"1.1"` only ADDS the keeper-gated `admin_*` frames
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
- `ping`: `{type:"ping", t:number}`

## Server → Client

- `welcome` — sent once, on a successful `join`:
  `{type:"welcome", protocol:"1.1", room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string}`
- `error` — a localized failure notice; `bad_key`, `join_timeout` and
  `too_many_connections` close the connection (they only ever happen during
  or before the `join` handshake), the others do not:
  `{type:"error", code:"bad_key"|"bad_frame"|"rate_limited"|"server_error"|"join_timeout"|"too_many_connections", message:string}`
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
  `{type:"state", character?:{name,system,hp,hpmax,mp,mpmax,san,sanmax,attributes:{},status_effects:[]}, party:[{name,online:boolean,active:boolean,initiative?:int,hp?:int,hpMax?:int,san?:int,sanMax?:int,mp?:int,mpMax?:int,ai?:boolean}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int}`
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
