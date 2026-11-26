# Loreweaver clients

- `protocol/` — `loreweaver-protocol`: the wire types. `loreweaver-protocol/v3` is protocol 3.0: the
  frames, the built-in views, the decoder and the client `Session` (no I/O).
- `tui/` — the terminal client (OpenTUI + React, Bun). It speaks protocol 3.0 over iroh (ALPN
  `loreweaver/3`): one bidirectional stream, newline-delimited JSON.

## Install and test

The workspace root is the repository root:

```sh
bun install            # at the repository root
cd clients/protocol && bun run test
cd clients/tui && bun test && bun run build
```

## Play

### On this machine

```sh
cd clients/tui
bun run dev
```

Choose **Host locally & play** on the connect screen. In a checkout this starts
`bun server/src/cli/main.ts serve --local` from the repository root (so the root `.env` configures
the model — `TRPG_LLM__*`), with its data in `~/.loreweaver/data` (the "Local server folder" field
changes it). A fresh data directory hands out its admin key once; the client keeps it in
`~/.loreweaver/tui-connect.json` (owner-only) and reuses it. Outside a checkout the client runs the
binary named by `TRPG_LOCAL_SERVER_BIN`, or `~/.loreweaver/server-bin/loreweaver`; nothing is
downloaded. The client stops the server when it exits.

You can also start the server yourself and paste what it prints:

```sh
bun server/src/cli/main.ts serve --local   # at the repository root; prints {"ok":true,"ticket":…,"first_key":{…}}
```

### A remote table

The room's admin runs `bun server/src/cli/main.ts serve` (public relays) and mints you a key with
`bun server/src/cli/main.ts key <room> player <name>`. Then:

```sh
cd clients/tui
bun run dev -- connect --host <ticket> --key <key> --name <you>
```

`connect` only prefills the connect screen; press Enter to join.

## In the game

Type speech, or a text command (`.r 3d6`, `.ra Spot Hidden`, `.st STR=60`, `.help`). A command's
answer is shown to you alone. Every admin operation is a command too (`.undo`, `.reset`, `.var`,
`.lore`, `.npc`, `.rule system coc7`). **F7** (or *Commands* in the menu) lists every command with its
usage and whether you may use it. `?` shows the keys; PgUp at the top of the log loads older
history; Ctrl+S saves the log to `~/.loreweaver/transcripts`.
