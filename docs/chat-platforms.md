# Discord and QQ bots (Experimental)

Discord and official QQ bots share the same rooms, deterministic dice, commands, media store,
and Keeper core as the terminal client. Their platform code only translates native events and
controls; buttons and application commands still enter the existing `CommandRouter`.

They remain **Experimental** until a release passes the real-server checklist below with test
bots supplied by the operator. Telegram and Feishu remain basic text adapters.

## Start

Discord needs its voice extra; QQ uses the core `aiohttp`/`httpx` transport.

```bash
uv sync --extra discord
uv run python -m app --doctor
uv run python -m app --serve --platforms discord,qq
```

The same `TRPG_DATA_DIR`, keystore, and logical rooms are used by the TUI and both bots.

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
`/help`, `/room`, `/model`, and `/audio`.
The shared room panel is one editable message per channel. Personal character results and Keeper
results use private Interaction responses. Images and audio are normal Discord attachments;
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
messages. Markdown replies require `MARKDOWN_TEMPLATE_ID`; the adapter sends the rendered text in
that template's `content` parameter. Dynamic control buttons additionally require
`KEYBOARD_ENABLED=true`. `KEYBOARD_ID` selects a static preset keyboard; it is only sent with a
configured Markdown template and does not enable dynamic buttons by itself. These settings only
select payloads—the test bot must also have the corresponding platform capabilities. Missing or
rejected rich capabilities fall back to plain text and numbered commands. Images/audio use QQ's
two-step rich-media upload when granted; one attachment is limited to 20 MiB because the adapter
does not implement QQ's large-file chunk protocol. QQ does not emulate a Discord voice channel.

QQ group reply windows are limited by the platform. Loreweaver therefore stores a bounded,
room-scoped FIFO outbox and drains it on the next legal inbound reply. Narrative order is kept;
panel updates coalesce; a failed API send stays queued instead of being marked delivered.

## Keeper binding

Mint a one-use `chat_bind` Keeper token from an authenticated terminal Keeper session. Send
`/bind <token>` to the bot in DM/C2C. The token is consumed and binds that platform user to the
token's room. `/unbind` revokes it. A group command is elevated only when that user binding and
the group's current logical room match; merely messaging the bot privately grants nothing.
On Discord these two commands are typed in the bot DM rather than exposed in a server command tree.

A self-hosted process is one operator trust domain: every authenticated Keeper may change its
deployment-wide model and image-provider settings. Run separate instances for mutually untrusted Keepers.

Never paste provider keys, invite keys, module secrets, or backup files into a public channel.

## Real-platform release checklist

- Bind and revoke a Keeper in DM/C2C; confirm a different room and an unbound user are denied.
- Link Discord, QQ, and TUI to one room; confirm actions, real dice, narration, and per-user state.
- Exercise slash commands/components, QQ rich and plain fallbacks, long narration, and attachments.
- Restart the bot; confirm Discord panel recovery, QQ queued-order recovery, and room isolation.
- Disconnect the network; confirm QQ heartbeat/resume and reconnect without duplicate messages.
- Join/leave Discord voice and run play/pause/resume/stop/volume with and without ffmpeg.
- Inspect logs and public rooms: no provider key, invite token, Keeper lore, or story body in health logs.
