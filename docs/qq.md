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

1. A OneBot 11 implementation — [NapCat](https://github.com/NapNeko/NapCatQQ) or
   [Lagrange](https://github.com/LagrangeDev/Lagrange.Core) are the ones this
   was written against. LLOneBot speaks the same wire.
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
and `ws_url` to a `ws://` or `wss://` URL. When `access_token` is set, the
bridge sends `Authorization: Bearer <token>`.

**Reverse**: the implementation connects in. Set `listen_host` / `listen_port` /
`path` (default `/onebot/v11/ws`). A client that sends `X-Client-Role` must use
`Universal`. Keep the listener on loopback unless you have secured the
surrounding network; a non-loopback reverse listener **requires**
`access_token`.

NapCat / Lagrange: enable the OneBot 11 websocket, paste the same token, and
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

## Signals

`SIGINT` / `SIGTERM` close every Iroh link (including the control links used
only to mint and delete keys), close the OneBot socket or reverse listener, and
flush the state files.
