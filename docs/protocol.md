# trpg_kp networked TUI — WebSocket protocol v1

This is the open, versioned wire protocol between a trpg_kp server
(`net.tui_server.TuiServer`, started via `python -m app --serve`) and any
client — the bundled OpenTUI terminal client, or a community-built
React/Vue/web client. The engine itself (deterministic core + AI Keeper)
is unaffected by transport; this document is the language-agnostic seam.

Transport: WebSocket, JSON text frames, one JSON object per frame, every
frame shaped `{"type": ...}`. Endpoint: `ws://host:port/`. Protocol
version: `"1.1"`.

Versioning is additive: `"1.1"` only ADDS the keeper-gated `admin_*` frames
(see "Admin frames" below). A client that only understands `"1"` keeps working
unchanged — it never sends `admin_*` frames, and it should treat the `welcome`
`protocol` field as an opaque string (accept any `"1.x"`).

The first frame a client sends MUST be `join`. The server replies with
either `welcome` or `error`, closing the connection on error.

## Client → Server

- `join` — authenticate and bind the connection to a room:
  `{type:"join", key:string, name?:string, client?:{name,version}}`
- `input` — a command line or player utterance, exactly what the player typed:
  `{type:"input", text:string}`
- `ping`: `{type:"ping", t:number}`

## Server → Client

- `welcome` — sent once, on a successful `join`:
  `{type:"welcome", protocol:"1.1", room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string}`
- `error` — a localized failure notice; `bad_key` closes the connection (it
  only ever happens during the `join` handshake), the others do not:
  `{type:"error", code:"bad_key"|"bad_frame"|"rate_limited"|"server_error", message:string}`
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
  `{type:"state", character?:{name,system,hp,hpmax,mp,mpmax,san,sanmax,attributes:{},status_effects:[]}, party:[{name,online:boolean,active:boolean,initiative?:int}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int}`
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

A deployer/keeper can manage the server from a browser (the web client's admin
panel, opened with `?admin=1`) over the SAME connection, using a **keeper-role
key**: the keystore role stamped on the connection at `join` is the admin gate —
there is no separate auth. The server answers these ONLY for a `keeper`
connection; any other connection gets `admin_error{code:"forbidden"}` and nothing
is read or mutated. Implemented in `net/admin.py`.

Client → server:

- `admin_get_config` — `{type:"admin_get_config"}`
- `admin_set_model` — switch the live LLM provider/model:
  `{type:"admin_set_model", provider:string, chat_model?:string}`
- `admin_list_keys` — `{type:"admin_list_keys"}`
- `admin_mint_key` — mint a room access key:
  `{type:"admin_mint_key", room:string, name?:string, role?:"player"|"keeper"}`

Server → client:

- `admin_config` — the live, display-safe LLM config (api_key masked) plus the
  provider catalog and whether a runtime override is active:
  `{type:"admin_config", provider:string, chat_model:string, base_url:string, api_key_masked:string, providers:string[], override_active:boolean}`
- `admin_keys` — the room-key roster; every entry's key value is masked. A
  `mint` request additionally returns the freshly minted key ONCE in cleartext
  under `minted` (so the keeper can copy it):
  `{type:"admin_keys", keys:[{key_masked:string, room:string, name:string, role:"player"|"keeper"}], minted?:{key:string, room:string, name:string, role:"player"|"keeper"}}`
- `admin_error` — a localized failure notice (does not close the connection):
  `{type:"admin_error", code:"forbidden"|"unknown_provider"|"bad_request", message?:string}`

`admin_set_model` validates `provider` against the known providers
(`infra.providers.is_known_provider`), persists the override via
`services.runtime_config`, and hot-reconfigures the shared `MutableLLM` — the
same path as the `.model set` chat command — then replies a fresh
`admin_config`. A key minted here is written back to the server's keys file, so
it survives a restart.

## Additive v1 NPC frames

`docs/specs/M5.md` adds AI-played, knowledge-scoped NPC sub-actors
(`agent/npc.py`, `agent/npc_actor.py`, `agent/kp_tools_npc.py`). The server
surfaces each `speak_as_npc` tool result as an additional
`narrative{speaker:"npc", name:<npc>, format:"markdown"}` frame before the
KP's own narration. This is v1-compatible and additive: existing
`speaker:"kp"|"player"|"system"` frames and clients that ignore unknown
speaker values are unaffected.
