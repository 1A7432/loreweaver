*English · [中文](qq.zh.md)*

# Play in a QQ group

The terminal client can sit in a QQ group as an ordinary **protocol client** —
`loreweaver bridge --config <file>`. It dials the same Iroh ticket any other
client would, joins as room members, and renders the table to text. It is **not**
an engine adapter: `adapters/` stays the local CLI, and the five chat-platform
adapters stay retired.

The bot **is** the Keeper (the AI). The person listed as an admin holds a
keeper-role key: they configure the table and they are also a player at it.

## What you run

On the host machine, two processes:

1. A OneBot 11 implementation — [NapCat](https://github.com/NapNeko/NapCatQQ) is
   the one this was written and probed against; [LLOneBot](https://github.com/LLOneBot/LLOneBot)
   speaks the same wire. Lagrange's main branch now ships the Milky protocol, not
   OneBot 11 (its OneBot 11 build lives only on the sunset `v1` branch), so do not
   point this bridge at a current Lagrange.
2. The terminal client in bridge mode:

```bash
loreweaver bridge --config bridge.json
```

If `bridge.json` has no `ticket`, the bridge calls the same one-click host as
the TUI ("Host locally & play") and takes the ticket and keeper key it returns.
Studio and TUI users can still join that room with ordinary invites — the bridge
is one more member set, not a different room.

## Config

One JSON file per bridge process. Timeouts are **seconds** (the old OneBot
adapter's unit); the client converts them to milliseconds internally.

```json
{
  "ticket": "endpoint…",
  "keeper_key": "…",
  "locale": "zh",
  "onebot": {
    "mode": "forward",
    "ws_url": "ws://127.0.0.1:3001",
    "access_token": "replace-with-a-long-random-token",
    "request_timeout": 10,
    "reconnect_delay": 1
  },
  "groups": [
    {
      "group_id": 123456789,
      "room_keeper_key": "…",
      "admins": [11111111],
      "mode": "mention"
    }
  ],
  "busy_notice": true,
  "idle_close_minutes": 30,
  "state_dir": "~/.loreweaver/bridge"
}
```

Omit `ticket` (and `keeper_key`) to host locally. One group maps to one room; a
keeper key is room-bound, so each group names its room's key. Two groups must
not share a `room_keeper_key` (or the top-level `keeper_key`). The top-level
`keeper_key` is the default for a single-group setup. `locale` is optional: when
unset, the bridge follows the room's `welcome.locale`. `idle_close_minutes: 0`
disables idle-close of player links (the observer and control links never idle-close).

State files (`<group>.keyring.json`, `<group>.posted.json`,
`<group>.settings.json`) are written mode 0600 under `state_dir`.

## Forward vs reverse

OneBot uses one universal WebSocket for events and actions. Pick exactly one
mode.

**Forward** (typical for NapCat on the same machine): the bridge connects out to
the implementation and reconnects after a drop. Set `onebot.mode` to `forward`
and `ws_url` to a `ws://` or `wss://` URL.

`access_token` is **required in both modes** and is sent as
`Authorization: Bearer <token>`. NapCat instances left with an empty token were
mass-exploited in 2026 and the QQ accounts behind them banned; use a long random
token and paste the same value into the implementation's `token` field. In
forward mode the bridge calls `get_login_info` at startup and logs the QQ id it
is logged in as; a wrong token fails startup with a clear error, because NapCat
and LLOneBot reject the token *after* the WebSocket upgrade and an open socket
alone proves nothing. The same check runs again after every reconnect.

**Reverse**: the implementation connects in. Set `listen_host` / `listen_port` /
`path` (default `/onebot/v11/ws`). A client that sends `X-Client-Role` must use
`Universal`. Keep the listener on loopback unless you have secured the
surrounding network. The bridge reads the token only from the
`Authorization: Bearer` header, which is what NapCat and LLOneBot send from their
`token` field — a token pasted into the URL as `?access_token=` is refused. A
refused handshake answers with an `onebot.reverse.rejected.*` code in the body
and one log line: `token_in_query` (move the token into the implementation's
token field), `missing_authorization`, `wrong_token`, `path`, or `role`. The
implementation's own log only ever says "Expected 101 status code". In reverse
mode startup succeeds as soon as the listener is up, before any implementation
has dialed in; the `get_login_info` check runs on each accepted connection, and
a wrong token on the implementation's side shows up only as that refused
handshake.

NapCat / LLOneBot: enable the OneBot 11 websocket, paste the same token, and
point the URL (forward) or the reverse host/port (reverse) at this process.

## Admins

Admins are QQ ids in the group's `admins` list. They can also be added and
removed at runtime with `.bridge admin add|remove <qq>` (admin-only, handled by
the bridge, never forwarded to the engine).

Every keeper-gated engine command already works over a keeper-role link: import,
`.skill`, `.panels`, `.pack install`, `.model`, `.save`, `.reset`, `.module`,
`.rule`, `.preset`, `.phase`, `.var expose`, `.dev mount`, `.language`,
`.chronicle`, `.lore`, `.imagegen`, `.forge`. **Admin replies always arrive in
private chat**, even when the command was typed in the group — including
acknowledgements. That is fail-closed on purpose. The bot must be a **friend**
of that admin: if a private send fails, the group is told only to add the bot
as a friend; the content is never posted in the group.

Secret-reading commands (`.lore`, `.var`, anything that would show keeper-only
material) should be sent as a **private message** to the bot. The admin doc is
the same instruction: private chat is where those answers go, and it is also
where you should ask.

A player-addressed `system` / `error` (`.st show`, "your input is queued") is
answered on the channel that command was typed on: private stays private even
if the same person then types in the group. `.imagegen` and `.forge` are
ordinary engine commands in this release; the bridge needs nothing extra for
them.

Bridge-level commands (admin-only): `.bridge status`, `.bridge members`,
`.bridge kick <qq>`, `.bridge admin add|remove <qq>`, `.bridge mode all|mention`,
`.bridge notice on|off`.

Group default is `mention` mode: recognized commands (`.`, `/`, `r `, the zh
dialect) always forward; story prose forwards only when the bot is @-mentioned,
unless the table sets `.bridge mode all`.

## The one gap

**Tier-2 HTML panels cannot render in a chat group.** That is the one
structural gap. `.panel <id>` prints the text form, which is what the group
gets. Meters, badges, choices, letters, clippings and the rest of the `ui`
blocks degrade to lines of text. Audio is a title line only.

## Turns take a few minutes

A player turn is not a chat reply. The Keeper may roll, read sheets, write
trackers, speak as NPCs, and wait on companion sub-turns. Worst case that is
on the order of **five minutes**, not five seconds. When `busy_notice` is on
(the default), the group gets one "the Keeper is thinking" line at the start
of a turn. That is the heartbeat. Do not assume the bot is stuck because the
group is quiet.

## What the log tells you

- `OneBot is up: logged in as QQ …` — the token was accepted and this is the
  account that answered; printed at startup and again after every reconnect.
- `OneBot connection dropped; reconnecting.` / `OneBot connection is offline.` —
  the socket dropped; at most one line per kind per minute during a redial storm.
- The token / self-check error lines can also appear after startup: a reconnect
  or a reverse-mode accept whose `get_login_info` fails prints the same message
  startup would have, once per minute.
- `Attachment … was not forwarded (reason)` — a player's image could not be
  fetched (no direct URL, an expired signed link, size, an unsafe address, or the
  room's media policy). The text still went through. The reason is a machine
  code; the URL is never logged because NapCat's links carry a signed key.

## Signals

`SIGINT` / `SIGTERM` close every Iroh link (including the control links used
only to mint and delete keys), close the OneBot socket or reverse listener, and
flush the state files.
