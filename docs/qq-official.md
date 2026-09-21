*English · [中文](qq-official.zh.md)*

# Play in a QQ group — official Bot API

The terminal client can sit in a QQ group as an ordinary **protocol client** —
`loreweaver bridge --config <file>` with `platform: "qqbot"`. It dials the same
Iroh ticket any other client would, joins as room members, and renders the table
to text. It is **not** an engine adapter: `adapters/` stays the local CLI, and
the five chat-platform adapters stay retired.

This is the **primary** QQ route. You run the bridge only. There is no NapCat,
no LLOneBot, and no personal QQ account. The secondary OneBot route (a personal
account behind NapCat / LLOneBot) is documented in [qq.md](qq.md).

The bot **is** the Keeper (the AI). The person who claims admin holds a
keeper-role key: they configure the table and they are also a player at it.

## What you run

On the host machine, **one** process:

```bash
loreweaver bridge --config bridge.json
```

If `bridge.json` has no `ticket`, the bridge calls the same one-click host as
the TUI ("Host locally & play") and takes the ticket and keeper key it returns.
Studio and TUI users can still join that room with ordinary invites — the bridge
is one more member set, not a different room.

## Console steps (q.qq.com)

1. Create a bot application at [q.qq.com](https://q.qq.com).
2. Apply for the `GROUP_AND_C2C_EVENT` intent (`1 << 25`). Without it the
   gateway will refuse Identify (Invalid Session) and the bridge will not stay
   up.
3. Copy `AppID` (`app_id`) and `AppSecret` (`client_secret`) into the config.
   The secret is never printed in an error or a log line.
4. Optionally enable **接收所有消息** if you want `@`-free commands
   (`.ra 侦查`, `r 3d6`). The documented default is off: every line the bot
   hears was an `@`. Prose still requires an `@` even when this is on —
   `groups[].mode: "all"` only applies to `@` events (`GROUP_AT_MESSAGE_CREATE`);
   a plain `GROUP_MESSAGE_CREATE` that is not a command is ignored and does not
   mint a seat.
5. If you need URLs in messages, add the hosts under the console's **消息URL配置**
   and list the same hosts in `qqbot.url_whitelist`. The config grants nothing
   the console has not already allowed; a URL that is not on both lists is
   replaced by `[链接]` / `[link]`.
6. **§10.7 — chunked upload.** Confirm in the console that unverified bots may
   call `upload_prepare` / `upload_part_finish` (this is how stills leave the
   room with no public URL). Archive one real `upload_prepare` response on first
   run.
7. **§10.9 — markdown.** Native markdown (`msg_type: 2`) needs no extra
   application in the console.

Webhook transport is not built. The bridge speaks the official WebSocket
gateway only.

## Unverified tier

Unverified bots are the documented target: **admin-owned groups only** (the
console wording is along the lines of 「仅管理员使用，可添加到管理员作为群主的群内」).
Personal verification is for public tables (a 500-group cap) and is not
required to run a private table. Who may add the bot to a group, and whether
that add is reviewed, is a console fact — re-check it there.

## Config

One JSON file per bridge process. Timeouts are **seconds**.

```json
{
  "platform": "qqbot",
  "ticket": "endpoint…",
  "keeper_key": "…",
  "locale": "zh",
  "qqbot": {
    "app_id": "102xxxxxx",
    "client_secret": "…",
    "transport": "websocket",
    "receive_all": false,
    "max_chunk_chars": 2800,
    "url_whitelist": [],
    "media_public_base_url": null,
    "bot_qpm": 30,
    "send_timeout": 5,
    "request_timeout": 10
  },
  "groups": [
    { "group_openid": "…", "room_keeper_key": "…", "mode": "mention", "admins": [] }
  ],
  "busy_notice": true,
  "idle_close_minutes": 30,
  "state_dir": "~/.loreweaver/bridge"
}
```

`platform` defaults to `"onebot"` when omitted, so every existing OneBot config
keeps working. The `onebot` and `qqbot` blocks are mutually exclusive.

Omit `ticket` (and `keeper_key`) to host locally. One group maps to one room;
two groups must not share a `room_keeper_key`. `group_openid` is learned from
the first-run chain below — it is not a QQ group number. Internally it is the
same `group_id` the OneBot route uses for state files and the duplicate check.

`admins` is an optional seed of `member_openid`s (copied from `.bridge members`
or a previous run) for when you do not want the claim flow. Seeded admins can
run `.bridge` commands in the group; keeper-private replies still need the
claim binding so the bridge knows which C2C identity to send them to.

`groups[].mode` is `mention` (default) or `all`. On this route it only changes
what happens **after an `@`**: `all` forwards `@`'d prose as well as commands;
`mention` already forwards `@`'d prose because every `@` is a mention. With
`receive_all`, a plain group message that looks like a command (`.ra`, `r 3d6`)
is still heard; prose without an `@` is never forwarded and never mints a seat.

`qqbot.send_timeout` (default 5 s) is the deliverer's per-send race.
`qqbot.request_timeout` (default 10 s) is the transport ready-gate and REST
timeout — do not shrink it to 5 s or Identify + Ready will fail on a slow
console.

State files (`<group>.keyring.json`, `<group>.posted.json`,
`<group>.settings.json`, `<group>.identity.json`, `<group>.anchors.json`,
`<group>.deferred.json`) are written mode 0600 under `state_dir`.

## First-run chain (in this order)

Nothing in the official world is a QQ number, so a config cannot be written up
front the way the OneBot one is.

1. **Add the bot to the group.** Until the group is in the config, the bridge
   logs `qqbot.group.unknown <openid>` and ignores it. No auto-adoption.
2. **Read `group_openid` from that log line.** Put it in `groups[].group_openid`.
3. **Restart the bridge.**
4. **Claim, private first.** The console prints a one-time claim code per group
   (8 characters, 30 minutes). In a **private chat** with the bot, send
   `.bridge claim <code>`. The bot answers in that same private chat with a
   second one-time **link code** (6 characters, 5 minutes) and the instruction
   to type it in the group immediately.
5. **Link in the group:** `@bot .bridge claim <link>`. That binds your
   `member_openid` to the C2C identity and mints the keeper-role key. This is
   the one `.bridge` command whose group reply stays in the group.

A claim code typed in the group by mistake is burned and never accepted as a
private credential. Codes can be re-issued: restart the bridge, or the next
startup prints a fresh one. When both the private and group events carry the
same non-empty `union_openid`, the link step is skipped.

An unbound private sender is accepted only for `.bridge claim <code>`;
everything else is ignored — no seat, no reply.

## The group owner's 「机器人主动在群聊内发言」 switch

This switch is the **group owner's**, on the bot's profile page in that group.
It is not the room admin's.

- **On (the intended way to run a table).** The Keeper talks as output arrives,
  in 5-second windows, as active messages under the group's rate limit (20/min
  per group, 1,000/day per group, 30/min per unverified bot). Passive replies
  are still used first while an open `@` has budget — they cost nothing against
  the quota — so a short dice answer stays a quoted reply.
- **Off.** Every line must ride a **passive reply** anchored to an inbound
  `@`: 5 replies, 5 minutes. A full turn is about that long, so late delivery
  ("上回合补发：") is the normal path. The group is told once per day how to
  turn the switch on. An unanchored send returns **40034105**.

## `.bridge name` before claiming a character

Seats are named from `author.username` when the event carries one, else
`玩家<last 4 hex>` / `Player <tail>`. `.bridge name <名字>` renames the seat
and is allowed **only while the seat has no claimed character**. After a
character claim it answers "use `.rename` for the character". Name yourself
first, then claim. Without this, every seat on this route would stay
`玩家a1b2` for the whole campaign. A seat's first `.bridge name` right after a
reconnect may need to be repeated — until a `state` frame arrives the bridge
treats the seat as locked so it cannot orphan a claimed sheet.

Bridge-level commands: `.bridge status`, `.bridge members`, `.bridge kick`,
`.bridge admin add|remove`, `.bridge mode`, `.bridge notice`, `.bridge claim`,
`.bridge name`, `.bridge deferred`. `claim` and `name` are the two verbs that
are not admin-gated; `claim` is also the one exception to "admin replies go
private".

Secret-reading commands (`.lore`, `.var`, anything that would show keeper-only
material) should be sent as a **private message** to the bot after you have
claimed. Those answers never go to a group anchor.

## What cannot work

In **off** mode the Keeper cannot speak first (no idle narration, no clock
beats). Companion sub-turns and Director stills ride the current `@` or the
deferred queue.

In **both** modes:

- No clickable choices (buttons are invite-only; choices stay numbered text).
- No recall after 2 minutes.
- Tier-2 HTML panels are the same gap as the OneBot route: `.panel <id>` prints
  the text form.
- URLs in content are refused unless the host is on the console whitelist
  **and** in `url_whitelist`.
- `member_openid` is per (bot, group). If the platform ever reissues it, the
  seat is reminted and a claimed character is orphaned.
- `media_public_base_url` is reserved, not wired in v1; uploads use the chunked
  session only.

## Turns take a few minutes

A player turn is not a chat reply. Worst case that is on the order of **five
minutes**, not five seconds — the same length as the passive window. When
`busy_notice` is on (the default), the first reply on an `@` is "the Keeper is
thinking". That is the heartbeat. Do not assume the bot is stuck because the
group is quiet. A second player's input during a turn is not forwarded as a
"queued" notice (that would burn a slot); it arrives late with the prefix.

## What the log tells you

- `QQ Bot is up: … (…)` — the access token was accepted and this is the bot
  identity from Ready.
- `Group <openid> claim code: <code> (30 minutes). …` — printed once per group
  at startup. Type it in a private chat.
- `qqbot.group.unknown <openid>` — the bot was added to a group that is not in
  the config; ignored.
- `QQ Bot connection dropped; reconnecting.` / `QQ Bot connection is offline.`
- `Attachment … was not forwarded (reason)` — a player's image could not be
  fetched (size, an unsafe address, or the room's media policy). The text still
  went through. The URL is never logged.
- Machine codes (`qqbot.claim.issued`, `qqbot.c2c.unbound`, `qqbot.active.off`,
  `qqbot.audit.pending`, …) stay in English; user-facing lines follow `locale`.

`client_secret` / `clientSecret` values never reach the log.

## Live-smoke checklist

Run this in a small group you own, with an unverified bot. Tick the expected
return. Do these **first**: (1) the same person sending two `@` in a row, then
an admin's group-typed secret question answered only in private; (2) a chunked
upload from an unverified bot, with the real `upload_prepare` response
archived; (3) the first Identify, with the start-failure code visible in the
log if it fails (`qqbot.start.failed …`).

| Check | Expected |
|---|---|
| `@bot .r 3d6` | one reply within the 5-minute window |
| a full turn | progressive messages and one still, all `2xx` without `audit_id` |
| a second player's `@` during a turn | their reply arrives late with the prefix (`上回合补发：` / `Late delivery:`) |
| five replies on one C2C anchor | the 5th returns **40034128** (settles 4 vs 5) |
| a chunked upload without any public URL | `file_info` |
| one raw event JSON archived | settles `username`, field shapes, `d.id` |
| the same person's `member_openid` after a restart the next day | settles stability (A1) |
| a horror-toned paragraph | passes, or shows the audit path (`audit_id` / 40034006) |
| admin claim in private → link in group → `.lore` | answered only in the private chat |
| `receive_all` on, if obtainable → `.ra` without `@` | heard |
| owner's 「机器人主动在群聊内发言」 **OFF** → an unanchored send | **40034105**, and the group gets the one-line hint |
| switch **ON** → `GROUP_MSG_RECEIVE` | a full turn goes out as active messages within a minute |
| the 21st message inside one minute (switch ON) | held by the bucket, not refused by the platform |

## Signals

`SIGINT` / `SIGTERM` close every Iroh link (including the control links used
only to mint and delete keys), close the QQ Bot gateway, close the deliverers
and identity stores, and flush the state files.
