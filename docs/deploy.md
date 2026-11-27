*English · [中文](deploy.zh.md)*

# Deploying Loreweaver

Most tables are hosted **peer-to-peer from a laptop** — one-click **Host locally & play** on the
terminal client's connect screen, or `bun server/src/cli/main.ts serve` (see the
[README](../README.md)). This page is for running an **always-on server** (a 24/7 game with a stable
ticket). Loreweaver connects over **Iroh** — p2p QUIC, dialed by a ticket, with **no domain, TLS,
port-forward, or reverse proxy**. Players join with keys the room's admin hands out; there is no
account system. There is no Docker image, and 3.0 has no WebSocket transport.

3.0 has no published release yet: you run the server from a checkout, with [Bun](https://bun.sh).

## Run it (bare metal)

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
bun install
cp .env.example .env          # then set TRPG_LLM__* (the server starts without; the Keeper cannot answer until set)
bun server/src/cli/main.ts serve
```

When it is ready the server prints one JSON line and keeps running until it is interrupted:

```json
{"ok":true,"version":"3.0.0","ticket":"endpoint…","notes":["recall_off"],"first_key":{"room":"main","key":"…"}}
```

On a fresh data directory it mints an **admin key** for the room `main` and prints it here, once —
`first_key` is never shown again. Connect with the ticket and that key, then mint more keys right in
the client's **Access keys** screen (or with `.key mint`) — no server access needed. `notes` are
start-up remarks as codes: `model_not_configured`, `context_window_unknown`, `recall_off`. A setting
the server cannot use stops it before anything is opened:
`{"ok":false,"code":"bad_settings","problems":[…]}` names every variable at once.

The other commands, from the shell. Each prints one JSON object, so a script can read it:

```bash
bun server/src/cli/main.ts key <room> <admin|player|observer> <name>   # a new key; its value is printed once
bun server/src/cli/main.ts import-world <room> <card-file>             # a SillyTavern card as the room's world
bun server/src/cli/main.ts packs                                       # the installed packs
bun server/src/cli/main.ts install <path|https-url|gh:owner/repo[@tag]> [--yes]
bun server/src/cli/main.ts uninstall <id>
bun server/src/cli/main.ts selftest                                    # can this build run a turn end to end
bun server/src/cli/main.ts --version
```

Run `key` and `import-world` while the server is **stopped**: a running server keeps its own copy of
the key file and of the rooms. A pack installed or uninstalled from the shell is seen by a running
server when it next starts. A key names its room; a key for a room that does not exist yet starts
that room.

### One file instead of a checkout

`cd server && bun run build` compiles the server into one executable, `server/dist/loreweaver`, and
runs its self-test. It takes the same commands (`loreweaver serve`, `loreweaver key …`) and needs no
Bun on the machine it runs on. Give it its settings as environment variables, or in a `.env` file
in the folder you start it in.

The terminal client compiles the same way (`cd clients/tui && bun run compile` →
`clients/tui/dist/loreweaver-tui`). Outside a checkout, its *Host locally & play* runs the
`loreweaver` kept in the same folder as itself, else the one named by `TRPG_LOCAL_SERVER_BIN`,
else `<local server folder>/server-bin/loreweaver`. A release is these two files per platform,
with installers that put them together — [releasing.md](releasing.md).

### One server per data directory

A running server holds `server.lock` in its data directory. A second `serve` over the same
directory is refused (`data_dir_in_use`) before it opens anything, and `key` and `import-world`
are refused while a server runs there (`server_running`): they write the key file and the
database directly. A lock left behind by a server that was killed names a process that no
longer exists, and the next start takes it over.

### Hosting it from another program

A program that starts the server as a child (a client's "host locally") adds
`--until-stdin-closes` and keeps the child's standard input open as a pipe. When the parent
goes away — a crash and a kill included — the pipe ends and the server stops as on SIGTERM,
instead of running on with nobody to stop it. `serve` answers with ONE JSON object either way:
the ready line (`ok: true`, the ticket, the notes, the first admin key of a fresh directory),
or a refusal with a `code` (`bad_settings`, `data_dir_in_use`, `startup_failed` with a
`detail`).

### A ticket that survives restarts

The server's identity is `transport.key` in its data directory: the same key, the same ticket, after
every restart. Keep it (a copy of the data directory covers it); deleting it gives the server a new
ticket, and every player needs the new one.

## Keep it running (systemd)

```ini
# /etc/systemd/system/loreweaver.service  — replace YOU with your username
[Unit]
Description=Loreweaver server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOU
WorkingDirectory=/home/YOU/loreweaver
EnvironmentFile=/home/YOU/loreweaver/.env
Environment=TRPG_DATA_DIR=/home/YOU/loreweaver-data
ExecStart=/home/YOU/.bun/bin/bun server/src/cli/main.ts serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now loreweaver
journalctl -u loreweaver -f       # follow logs — the ready line (ticket, first key) prints at startup
```

The server stops cleanly on `SIGTERM` and `SIGINT`: it closes every connection and the database
before it exits.

## Updating

3.0 has no self-update. Update by hand:

```bash
cd ~/loreweaver && git pull && bun install && sudo systemctl restart loreweaver
```

The ticket stays the same. A client must share the server's protocol major version: one that is too
old or too new is refused, with a message saying which side is behind — so update the clients from
the same checkout.

## Configuration

All settings are `TRPG_*` environment variables, with `__` between levels
(`server/src/infra/config.ts` is the one place that reads them; [`.env.example`](../.env.example)
lists every one). Started with `bun`, the server also reads `.env` from the directory it starts in.

| Variable | Purpose | Default |
|---|---|---|
| `TRPG_LOCALE` | the language of rooms until a room sets its own: `en` / `zh` | `en` |
| `TRPG_DATA_DIR` | the data directory: database, key file, server identity, media, installed packs | `./data` |
| `TRPG_LLM__PROVIDER` | a preset — `openai`, `anthropic`, `deepseek`, `openrouter`, `moonshot` — or any name of yours together with `TRPG_LLM__BASE_URL` | *(none)* |
| `TRPG_LLM__BASE_URL` | the endpoint's address; wins over the preset's | the preset's |
| `TRPG_LLM__API_KEY` | the provider's API key | *(none: no model)* |
| `TRPG_LLM__CHAT_MODEL` | the model id | *(none: no model)* |
| `TRPG_LLM__WIRE` | `openai-compatible`, `anthropic` or `openai-responses` | the preset's, else `openai-compatible` |
| `TRPG_LLM__REASONING_EFFORT` | `low`, `medium`, `high`, `xhigh` or `max` | the provider's |
| `TRPG_LLM__CONTEXT_WINDOW` | the model's context window in tokens; the chronicle fold measures against it | known models' own; else 32000 is assumed |
| `TRPG_LLM__MAX_OUTPUT_TOKENS` | a cap on one reply | the provider's |
| `TRPG_LLM__TIMEOUT_MS` | how long one model call may take | the SDK's |
| `TRPG_LLM__PROMPT_CACHE_KEY` | `false` stops the OpenAI wires from sending `prompt_cache_key` | `true` |
| `TRPG_NPC__*`, `TRPG_SCRIBE__*`, `TRPG_DIRECTOR__*`, `TRPG_MEMORY__*` | the same ten fields for one lane; a model or effort alone keeps the Keeper's endpoint and key, a provider or base URL makes a separate endpoint with its own key | the Keeper's client |
| `TRPG_TURN__MAX_ROUNDS` | tool rounds the Keeper may take in one turn | `12` |
| `TRPG_SCRIBE__ENABLED` | the Scribe | `true` |
| `TRPG_DIRECTOR__ENABLED` | the Stage Director | `true` |
| `TRPG_DIRECTOR__IMAGES` | `false`: the Director shows a pack's pictures but never generates one | `true` |
| `TRPG_DIRECTOR__MAX_IMAGES` | pictures one story may generate | `24` |
| `TRPG_DIRECTOR__PREGEN_PER_BEAT` | likely-next subjects one beat may prepare | `2` |
| `TRPG_CHRONICLE__ENABLED` | the chronicle fold | `true` |
| `TRPG_CHRONICLE__FOLD_TRIGGER` / `__FOLD_FLOOR` / `__FOLD_EMERGENCY` | fractions of the context window (floor < trigger ≤ emergency) | `0.60` / `0.40` / `0.85` |
| `TRPG_CHRONICLE__LAG_TURNS` | recent turns never folded | `4` |
| `TRPG_CHRONICLE__SUMMARY_MAX_CHARS` | the campaign summary's length cap | `4000` |
| `TRPG_IMAGEGEN__BASE_URL`, `__API_KEY`, `__MODEL` | image generation; all three, or none | *(off)* |
| `TRPG_IMAGEGEN__SIZE` | `WIDTHxHEIGHT` or `auto` | `1024x1024` |
| `TRPG_IMAGEGEN__DIALECT` | `openai` or `xai` | `openai` |
| `TRPG_EMBEDDINGS__API_KEY`, `__MODEL`, `__DIMENSIONS` | recall by meaning (an OpenAI-compatible embeddings endpoint); without it lore activates by keyword only | *(off)* |
| `TRPG_EMBEDDINGS__BASE_URL` | that endpoint's address | OpenAI's |
| `TRPG_CENSOR__WORDLIST` / `TRPG_CENSOR__WORDLIST_PATH` | the word filter: see [Content moderation](#content-moderation) | *(off)* |
| `TRPG_STORE__UNDO_DEPTH` | how many turns back `.undo` may reach | `4` |
| `TRPG_MODULES__CALL_TIMEOUT_MS` | how long one call into a room's module worker may take before the worker is ended | `5000` |
| `TRPG_TUI__AUDIO_MAX_FILE_BYTES` | one sound, in bytes | 128 MiB |
| `TRPG_TUI__AUDIO_ROOM_QUOTA_BYTES` | all of a room's sounds together, in bytes | 2 GiB |

A room admin can change the model lanes and image generation at run time (`.model`, `.imagegen`, or
the **Model** screen); those changes are stored in the database and win over the variables until
`.model reset`.

## Encryption

Iroh player connections are **end-to-end encrypted, with nothing to configure** (QUIC/TLS, each peer
authenticated by its public key), with no certificate to manage. This protects traffic between a
client and the Loreweaver server; it does not say what the server sends to a configured model
provider.

## Data flow and trust boundaries

- The deterministic rules engine, the SQLite campaign state, media, room keys and backups stay on
  the server you operate. The Iroh relay, when one is needed, carries encrypted traffic and does
  not terminate the application session.
- A **remote** LLM endpoint is a separate data processor. It receives the Keeper's prompt (which by
  design carries the world's keeper-only lore), relevant conversation history, and the current player
  input; a character made from a description or a card sends that text as well. Recall by meaning
  is off unless configured; an embedding endpoint you configure receives lore entries and chronicle
  lines. Select a local endpoint such as Ollama or LM Studio when this material must remain on
  infrastructure you control.
- Players and every NPC are kept apart from keeper material by the code itself: an NPC actor is
  built only from its own record and sheet, and the Stage Director only from what the table has
  already seen. The main Keeper is intentionally different — it sees secrets in order to run the
  mystery. Prompt instructions and live-model play-tests reduce and measure its leak risk; they are
  not a proof that every model will behave.
- A module is real code, run in the room's worker thread with no security sandbox: installing a pack
  is a decision to run its code on this machine. The trust card says so before anything is written.
  Packs are installed by whoever runs the server, or by a room admin from the table (`.pack install`).
- Keys are room-scoped. Admin keys can read keeper-only state and manage keys only for their own
  room, but model configuration and pack installation are server-wide. Issue admin keys only to
  fully trusted co-administrators.
- API keys set at run time are stored unencrypted in the local SQLite database so they survive a
  restart. They are sent as authorization only to the chosen provider endpoint, never to players.
  Treat the host account and its backups as part of the trusted computing base.

## Content moderation

The word filter (`server/src/gateway/review.ts`) is a real, bypass-resistant word matcher — NFKC and
case folding, letters of a word may be separated by spaces, dots, asterisks, hyphens, middle dots or
zero-width characters, whole-word matching, masks placed on the original characters — but **it ships
with no word list and is OFF by default.** Loreweaver deliberately does not bundle a profanity/slur
list: maintaining one, and getting multilingual coverage right, is a policy choice each operator
should own, not something baked into the engine. With no list configured the filter is an explicit
no-op — it is not silently filtering anything.

To turn it on, set `TRPG_CENSOR__WORDLIST` (inline: `word[:level],word2[:level2],…`) or
`TRPG_CENSOR__WORDLIST_PATH` (a text file, one `word[:level]` per line), or both — they combine. A
list file that cannot be read stops the server from starting: an operator who asked for a filter
does not get an unfiltered server.

```
some-slur:5
some-mild-word:2
```

Levels run from `1` (notice) to `5` (forbidden); a word without one is `1`. Every hit is masked; a
hit at `4` (danger) or above blocks the Keeper's reply — it is not published, and the turn ends with
a notice instead. Word matching is locale-agnostic — list whatever words and scripts you need.

**Current scope — read before relying on this:**

- It screens what the engine itself puts in front of the table: the Keeper's narration, a module's
  table facts, and the text a model wrote for a new character (`.genchar`, a character card import).
  **Player input is not screened.**
- A room whose admin enabled a mature-content skill is not filtered at all.
- It is a word matcher, not a semantic classifier — it catches listed words (and simple obfuscations
  of them), nothing it wasn't told about.

Do not treat this as a moderation solution out of the box — it is a configurable building block that
does nothing until you supply a word list.

## Keys & persistence

- **Keys** bind a random secret to one room and one role (`player`, `admin` or `observer`). They
  live in `keys.json` in the data directory. Mint them from the client's **Access keys** screen or
  with `.key mint`; with the server stopped, also with `loreweaver key`. A key's value is shown once,
  when it is minted; listings show it masked. Revoking a key ends its holder's connections at once.
  The room's last admin key cannot be revoked or demoted.
- **Persistence** is one SQLite file, `loreweaver.db`, holding every room's state. Keep the data
  directory to keep progress.
- **Run-time credentials** (API keys set with `.model` or `.imagegen`) are stored unencrypted in that
  file so they survive a restart. Protect the database like `.env` or `keys.json`.
- **Room bundles** exported with `.save` hold every secret of the room; protect them like the
  database.
- **Local permissions:** the data directory is created `0700`, and the database, the key file and
  the server identity `0600`, where the filesystem implements POSIX modes. On Windows or filesystems
  without POSIX permissions this is best-effort, not an ACL manager.
- **Secrets** (`.env`, the `data/` directory) are git-ignored. Never commit them.

## Connecting clients

Clients speak the versioned protocol in [`docs/protocol.md`](protocol.md) over Iroh. Point the
terminal client at the server's **ticket** with a key:

```bash
cd clients/tui && bun run dev connect --host <ticket> --key <key> --name <name>
# or just `bun run dev` and paste the ticket and key on the connect screen
```

The connection is end-to-end encrypted; the server is key-gated, but treat keys as secrets.
