# Chat platform adapters (Experimental)

Discord, official QQ, Telegram, Feishu, and OneBot 11 can join the same logical rooms as the
Iroh terminal client. They use the same deterministic dice, commands, media store, permissions,
and Keeper core; an adapter only translates between a platform's native events and the shared
gateway contract.

All five network adapters are **mock-tested Experimental**. Offline tests cover event parsing,
API payloads, error paths, and owned lifecycle cleanup, but cannot prove real bot permissions,
rate limits, gateway quirks, or vendor SDK behavior. None should be called stable until its
real-platform checklist below passes. **OpenTUI remains the primary client.**

## Capability summary

| Platform | Transport | Covered surface | Intentional fallback / limit |
|---|---|---|---|
| Discord | Discord gateway | slash commands, components, panels, attachments, private interactions, voice | requires real-server acceptance and optional voice dependencies |
| Official QQ | official gateway + HTTP API | group @/full-message/C2C events, Markdown, Keyboard, rich media, passive-reply queue | rich capabilities fall back to plain text/numbered commands; 20 MiB per attachment |
| Telegram | `python-telegram-bot` polling | exact mentions, bot commands, topics, quoted replies, media, typing, edits, inline callbacks, DMs | malformed Markdown retries as plain text; private replies require an open bot DM |
| Feishu | `lark-oapi` long connection | exact mentions, threads, quoted replies, posts/media, native replies, private delivery | embeds/card content and controls become lossless plain text with numbered commands; **no native interactive card** |
| OneBot 11 | forward or reverse universal WebSocket | group/private events, CQ/array segments, replies, media, action/echo, Bearer auth | embeds and controls become numbered text; implementations vary; 20 MiB hard attachment ceiling, with possibly lower shared runtime limits |

## Install and start

Install only the SDK extras for the adapters you plan to run. Official QQ and OneBot use core
dependencies.

```bash
uv sync --extra discord --extra telegram --extra feishu
uv run python -m app --doctor
uv run python -m app --serve --platforms discord,qq,telegram,feishu,onebot
```

`--platforms` accepts any comma-separated subset. `--doctor` reports missing credentials,
missing Telegram/Feishu SDKs, and an incomplete OneBot endpoint before a long-running start.
Combined mode keeps the Iroh server running beside the selected adapters, with the same
`TRPG_DATA_DIR`, keystore, and RoomHub. A platform with missing required configuration is skipped.

In a group, ordinary prose must @-mention the bot; recognized prefix/slash commands can enter the
shared `CommandRouter` directly. Direct messages are enabled without a mention. Generated text
never deliberately creates an @-all mention, but platform permissions and privacy settings still
belong to the operator.

## Discord

```dotenv
TRPG_DISCORD__TOKEN=...
# Optional: sync commands immediately to one development server.
TRPG_DISCORD__GUILD_ID=...
# Optional; text and audio attachments still work when voice playback is unavailable.
TRPG_DISCORD__FFMPEG=ffmpeg
```

OAuth scopes: `bot`, `applications.commands`.

Bot permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History;
add Connect and Speak for voice playback. Enable Message Content Intent for typed room messages.
Generated text is sent with mentions disabled.

Native commands include `/roll`, `/check`, `/sheet`, `/character`, `/panel`, `/language`,
`/help`, `/room`, `/model`, and `/audio`. The shared room panel is one editable message per
channel. Personal character results and Keeper results use private Interaction responses.
Images and audio are normal Discord attachments;
`/audio join|leave|play|pause|resume|stop|volume` controls one player per logical room.

## Official QQ bot

```dotenv
TRPG_QQ__APP_ID=...
TRPG_QQ__SECRET=...
# Optional: the custom Markdown template must define a parameter named `content`.
TRPG_QQ__MARKDOWN_TEMPLATE_ID=...
# Optional preset keyboard attached to rich replies when no inline keyboard is sent.
TRPG_QQ__KEYBOARD_ID=...
# Enable inline keyboards generated from Loreweaver controls.
TRPG_QQ__KEYBOARD_ENABLED=true
```

Configure the official Gateway events for group @ messages, group messages if granted, and C2C
messages. Markdown replies require `MARKDOWN_TEMPLATE_ID`; the adapter sends rendered text in the
template's `content` parameter. Dynamic control buttons additionally require
`KEYBOARD_ENABLED=true`. `KEYBOARD_ID` selects a static preset keyboard; it is only sent with a
configured Markdown template and does not enable dynamic buttons by itself. The test bot must
also have the corresponding platform capabilities.

Missing or rejected rich capabilities fall back to plain text and numbered commands. Images and
audio use QQ's two-step rich-media upload when granted. One attachment is limited to 20 MiB
because the adapter does not implement QQ's large-file chunk protocol. QQ does not emulate a
Discord voice channel.

QQ group reply windows are limited by the platform. Loreweaver therefore stores a bounded,
room-scoped FIFO outbox and drains it on the next legal inbound reply. Narrative order is kept,
panel updates coalesce, and a failed API send stays queued instead of being marked delivered.

## Telegram

```dotenv
# Obtain this token from BotFather.
TRPG_TELEGRAM__TOKEN=...
```

The Telegram extra runs the PTB 22.8 polling lifecycle in a controlled order: initialize the
application, start it, start polling, then stop polling/application and shut down on exit. It
uses long polling, so no public webhook or listening port is required. Startup also resolves the
bot identity and registers the localized bot-command list.

The adapter distinguishes private chats, groups/supergroups, channels, and forum topics. A topic
ID is part of the logical channel key, replies stay in that topic, and quoted message text enters
the turn as a quote. Telegram's UTF-16 entity offsets are respected when detecting and removing
only this bot's mention; `/command@ThisBot` is normalized without swallowing another bot's
mention. Edited messages, channel posts, and inline callback queries are accepted.

Inbound photos, documents, audio, voice, video, animations, video notes, and stickers are exposed
to the shared attachment pipeline; downloads honor the configured shared media/audio byte limits.
Outbound media uses Telegram's native send methods; long
captions are sent once as text before the attachment. Typing state is refreshed while a turn is
running, panel-like messages can be edited, and shared components become inline-keyboard callback
commands. A Telegram `BadRequest` caused by Markdown retries once as plain text; network/auth
errors do not get disguised by that fallback.

With BotFather privacy mode enabled, Telegram normally delivers commands, replies, and mentions,
which matches Loreweaver's group mention gate. Disable privacy and re-add the bot only if your
deployment deliberately needs visibility into every group message. For a private result from a
group, the bot sends to that user's DM and drops the group reply/topic metadata; the user must
have opened the bot chat, sent `/start`, and not blocked it. If Telegram refuses that DM, the
sensitive result fails safely and is never retried in the group. Channel posts and anonymous-admin
`sender_chat` messages have no real user ID, so a private reply is rejected rather than guessed or
sent to the channel.

## Feishu / Lark

```dotenv
TRPG_FEISHU__APP_ID=...
TRPG_FEISHU__APP_SECRET=...
```

In the developer console, enable the bot capability, select **long connection** event delivery,
and subscribe to `im.message.receive_v1`. Grant the app permission to receive group/P2P messages,
read message content and resources, send/reply as the app, and upload images/files. Publish the
version as required by the tenant and add the bot to each target chat. The long connection needs
no public callback URL.

The Feishu extra intentionally pins `lark-oapi==1.5.5`. The stoppable supervisor is verified
against that release and must use part of its private WebSocket protocol surface because the SDK
does not expose a complete public lifecycle API. Do not relax or upgrade the pin without rerunning
the long-connection lifecycle tests.

Startup must successfully resolve the bot's `open_id` so only an exact self-mention opens the
group gate; verify this in the logs, because an identity lookup failure makes adapter startup fail
closed rather than accepting messages with a guessed identity. Other mentions remain in the
text. P2P chats map to DMs, Feishu `thread_id` scopes a thread, and `parent_id` is hydrated into
quoted text away from the SDK
callback. Text/post content and image/file/audio/video/sticker resources enter the common media
pipeline. Public responses use the native reply endpoint when possible; a private group result
targets the sender's `open_id` and is never accidentally sent to the group.

Inbound resources are downloaded lazily and must fit the shared gateway's requested byte limit;
a failed or oversized fetch keeps its resource mapping so a later valid retry can still succeed.

Outbound images are limited to 10 MiB and other files to 30 MiB before upload. Structured embeds,
card-like content, and controls are deliberately rendered as lossless plain text; each actionable
component keeps its label and command as a numbered line. This adapter does **not** claim native
Feishu interactive cards.

The controlled client runs on its own event thread/current loop and never reads or writes the
SDK's module-global loop, so two adapter instances stay isolated. Endpoint discovery is async,
cancellable, and timed; WebSocket connect/close/start/stop are bounded. The supervisor waits for
initial readiness, retries transient initial/runtime failures, watches the receive task, and
reports a permanent client error instead of claiming a connection. Shutdown rejects new events,
stops the source, drains accepted work for a bounded interval, cancels the remainder, closes the
transport, and joins its thread; a stopped source can be started again. This lifecycle is
mock-tested but still needs a real tenant/public-network restart test.

The synchronous SDK callback waits only for the main loop to accept an event, not for the Keeper
turn. That handoff is process memory, not a durable inbound queue: a process crash after acceptance
but before the turn finishes can still lose that in-flight work. The process-local 2,048-message
window suppresses timeout/reconnect redelivery while the process lives (and resets on restart);
the resource lookup cache is also bounded.

## OneBot 11

OneBot uses one universal WebSocket for both events and actions. Choose exactly one mode.

Forward mode: Loreweaver connects to the OneBot implementation and reconnects after a drop.

```dotenv
TRPG_ONEBOT__MODE=forward
TRPG_ONEBOT__WS_URL=ws://127.0.0.1:3001
TRPG_ONEBOT__ACCESS_TOKEN=replace-with-a-long-random-token
# Optional tuning:
TRPG_ONEBOT__REQUEST_TIMEOUT=10
TRPG_ONEBOT__RECONNECT_DELAY=1
```

Reverse mode: the OneBot implementation connects to Loreweaver.

```dotenv
TRPG_ONEBOT__MODE=reverse
TRPG_ONEBOT__LISTEN_HOST=127.0.0.1
TRPG_ONEBOT__LISTEN_PORT=6700
TRPG_ONEBOT__PATH=/onebot/v11/ws
TRPG_ONEBOT__ACCESS_TOKEN=replace-with-the-same-token-in-the-implementation
TRPG_ONEBOT__REQUEST_TIMEOUT=10
```

Forward mode accepts only a `ws://` or `wss://` URL. Reverse mode matches the configured path
exactly and supports the Universal WebSocket, not separate API/event sockets. When a token is
configured, forward mode sends `Authorization: Bearer <token>` and reverse mode rejects a missing
or incorrect Bearer header. A reverse client that sends `X-Client-Role` must use `Universal`.
Keep the listener on loopback unless you have intentionally secured the surrounding network.
When `LISTEN_HOST` is not loopback, configuration/startup requires `ACCESS_TOKEN`; an
unauthenticated non-loopback reverse socket is rejected.

The adapter accepts OneBot 11 `message` events for groups and private chats, filters its own sends,
and parses either array message segments or CQ-code strings. Text, exact @-self detection,
`image`/`record`/`video`/`file` metadata, reply segments, and private delivery are covered. HTTP(S)
attachments and inline base64 media have a 20 MiB OneBot hard ceiling, but first honor the shared
`TRPG_TUI__MEDIA_MAX_FILE_BYTES` or `TRPG_TUI__AUDIO_MAX_FILE_BYTES` limit, which may be lower.
Remote attachment downloads accept only credential-free public HTTP(S) targets: every DNS answer
and redirect hop is revalidated, while loopback, private, link-local, reserved, and metadata
addresses are rejected. The request timeout bounds the whole redirect/download chain.
Outbound images/audio/video use native segments; unsupported generic files, embeds, and controls
retain a readable name/URL or numbered plain-text command instead of pretending that every
implementation has a card API.

Actions carry unique `echo` values. Responses resolve only their matching request and are never
re-dispatched as player events, including late responses after a timeout. Forward mode reconnects;
reverse mode accepts the implementation's reconnect. A bounded
`(self_id, chat_type, chat_id, message_id)` window suppresses replayed turns without collapsing
distinct chats that reuse a message ID. OneBot implementations differ, so test both the event
shape and action responses of the exact implementation and version you deploy.

## Keeper binding

Mint a one-use `chat_bind` Keeper token from an authenticated terminal Keeper session. Send
`/bind <token>` to the bot in a direct conversation (Discord DM, QQ C2C, Telegram DM, Feishu P2P,
or OneBot private message). The token is consumed and binds that platform user to the token's
room. `/unbind` revokes it. A group command is elevated only when that user binding and the
group's current logical room match; merely messaging the bot privately grants nothing. On Discord
these two commands are typed in the bot DM rather than exposed in a server command tree.

A self-hosted process is one operator trust domain: every authenticated Keeper may change its
deployment-wide model and image-provider settings. Run separate instances for mutually untrusted
Keepers. Never paste provider keys, invite keys, module secrets, adapter tokens, or backup files
into a public channel.

## Real-platform release checklist

Run the common checks for every selected adapter:

- Run `--doctor`, start the configured subset, then stop and restart it twice; no adapter task,
  polling loop, SDK thread, socket, or pending request should survive shutdown.
- Bind and revoke a Keeper in a direct conversation; confirm an unbound user and a user/group
  linked to another room are denied.
- Link the adapter and at least one OpenTUI client to one room; confirm player actions, real dice,
  narration, per-user state, and private results reach only the intended recipients.
- Exercise a group mention, a prefix/slash command without prose, a direct message, a bot-authored
  event, and a redelivered event; confirm there is no bot loop or duplicate Keeper turn.
- Cover long narration, a quoted reply, supported inbound/outbound media, an oversized/rejected
  attachment, an API failure, and recovery without leaking credentials in replies or logs.
- Disconnect the network during an in-flight turn, restore it, and confirm the adapter reconnects
  without a duplicate turn; a failed send must be reported rather than silently marked delivered.
  Where a platform has an outbox, verify its ordering separately. Inspect public rooms and logs for
  provider keys, invite/bind tokens, adapter credentials, Keeper lore, and story bodies in health
  messages.

Then run the platform-specific checks:

- **Discord:** slash commands/components, private Interaction responses, panel recovery after
  restart, and the full join/leave/play/pause/resume/stop/volume voice path with and without ffmpeg.
- **Official QQ:** group @, granted full-message, and C2C events; Markdown/Keyboard success and
  plain-text fallback; rich-media upload; passive-window outbox ordering; heartbeat/resume and
  reconnect without duplicates.
- **Telegram:** BotFather privacy behavior, a forum topic isolated from the parent chat, quoted and
  edited messages, typing refresh, inline callback acknowledgement, media, DM-private results, and
  polling recovery without duplicate updates.
- **Feishu:** published app permissions, `im.message.receive_v1` over the long connection, exact
  self-vs-other mentions, thread and parent quote handling, P2P private results, media upload/read,
  explicit numbered-text card fallback, transient-start/receiver reconnect, permanent credential
  failure, two-instance isolation, redelivery deduplication, and clean stop/restart.
- **OneBot 11:** run forward and reverse universal WebSocket separately; reject a bad/missing Bearer
  token, correlate action/echo while events arrive, reconnect after a drop, reject duplicate/self
  events, and cover CQ/array segments, replies, media, private delivery, timeouts, shared runtime
  attachment limits, and the 20 MiB hard ceiling.
