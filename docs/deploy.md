*English · [中文](deploy.zh.md)*

# Deploying Loreweaver

Most tables are hosted **peer-to-peer from a laptop** — just `python -m app --serve`, or one-click
**Host locally** from the connect screen (see the [README](../README.md)). This page is for running
an **always-on server** (a 24/7 public game with a stable ticket). Loreweaver connects over **Iroh**
— p2p QUIC, dialed by a ticket, with **no domain, TLS, port-forward, or reverse proxy**. Players
join with deployer-issued keys; there is no account system. (There is no Docker image or
WebSocket **player-client** serve path — the old TUI WebSocket remains only for offline tests.
The experimental OneBot adapter separately uses its protocol's universal WebSocket.)

## Run it (bare metal)

Requires Python ≥ 3.11 and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
cp .env.example .env          # then set TRPG_LLM__* (or leave blank for the offline demo)
uv sync                       # env + deps (Iroh is a default dep)
uv run python -m app --serve --keys ./data/keys.toml
```

On first run the server **auto-mints a keeper key** and prints a shareable **Iroh ticket** — both
are also written next to the keystore as `keeper-key.txt` / `iroh-ticket.txt`. Share the ticket +
the keeper key; connect with them, then mint more keys / create rooms right in the client's *Rooms
& invites* screen — no server access needed. State (SQLite + keys) lives next to `--keys`.

> Behind a SOCKS proxy for a non-China LLM? `uv pip install socksio`. A China-direct provider
> (e.g. DeepSeek) needs no proxy — run with a clean env.

## Keep it running (systemd)

```ini
# /etc/systemd/system/loreweaver.service  — replace YOU with your username
[Unit]
Description=Loreweaver Iroh server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOU
WorkingDirectory=/home/YOU/loreweaver                 # .env is loaded from here
ExecStart=/home/YOU/.local/bin/uv run python -m app --serve --keys /home/YOU/loreweaver-data/keys.toml
Restart=on-failure
RestartSec=10
TimeoutStartSec=120                                   # Iroh's relay handshake takes a moment

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now loreweaver
journalctl -u loreweaver -f       # follow logs — the ticket + keeper key print at startup
```

## Updating

Update by hand from the box:

```bash
cd ~/loreweaver && git pull && uv sync && sudo systemctl restart loreweaver
```

Or let a keeper trigger it from the client's **Rooms & invites** page. This is **off by
default** — set `TRPG_TUI__UPDATE_COMMAND` to the command YOU want the server to run:

```bash
# in ~/loreweaver/.env
TRPG_TUI__UPDATE_COMMAND=git pull && uv sync
```

With it set, a keeper (only) sees the server-vs-client version and an **Update server**
button whenever the client is newer. Pressing it runs exactly that command on the server,
then the process **re-execs itself into the new code** (same PID, so the Iroh ticket is
unchanged and no `systemctl restart` is needed — it works with the `Restart=on-failure`
unit above). Clients briefly disconnect and reconnect.

`loreweaver update` does the same server update by default after reinstalling the client
(using your saved keeper connection), so one command keeps both in step —
`loreweaver update --client-only` skips the server.

Security: the command is yours, from server-side config — a client can only ask the server
to run *its own* configured command, never supply one. Leave `TRPG_TUI__UPDATE_COMMAND`
blank to hide the feature entirely. Don't point it at anything you wouldn't run yourself;
the keeper key is the trust boundary, exactly as for `.model`/key management.

## Configuration

All settings use the `TRPG_` env prefix with `__` for nesting (see
`.env.example` / `infra/config.py`), loaded from `.env` in the working directory unless
`TRPG_ENV_FILE` points at a different file. The TUI's one-click local host path sets
`TRPG_ENV_FILE=<local server folder>/.env` automatically.

| Variable | Purpose | Default |
|---|---|---|
| `TRPG_LLM__PROVIDER` | `openai` (+ presets: `deepseek`, `groq`, `openrouter`, `together`, `ollama`, `lmstudio`, …), dual-mode `chatgpt` / `gpt-subscription`, subscription `supergrok`, or native `anthropic` / `gemini` | `openai` |
| `TRPG_LLM__API_KEY` | provider/proxy API key — not used by a subscription OAuth path; **blank = offline demo Keeper** for normal API-key providers | *(empty)* |
| `TRPG_LLM__BASE_URL` | OpenAI-compatible base URL; an explicit value selects the proxy path for `chatgpt` / `gpt-subscription`, while blank selects subscription OAuth | provider preset |
| `TRPG_LLM__CHAT_MODEL` | chat model id | `gpt-4o` |
| `TRPG_LLM__EMBEDDING_MODEL` / `TRPG_LLM__EMBEDDING_DIM` | retrieval embeddings | `text-embedding-3-small` / `1536` |
| `TRPG_LOCALE` | UI language `en` / `zh` | `en` |
| `TRPG_ENV_FILE` | explicit `.env` file to load before starting the server | `.env` in the working directory |
| `TRPG_DATA_DIR` | campaign/runtime data directory (db → `<data_dir>/loreweaver.db`) | `./data` |
| `TRPG_TUI_KEYS` | keystore file path (also overridable with `--keys`; independent of `TRPG_DATA_DIR`) | `./keys.toml` |
| `TRPG_LOCAL_SERVER_HOME` | TUI one-click local hosting root: server binary/source cache, `.env`, data, keys, and ticket sidecars | `TRPG_HOME`, else `<user home>/.loreweaver` |
| `TRPG_RELEASE_TAG` | Pin the installer/client and one-click server downloads to a versioned GitHub Release such as `release-0.5.1.dev29+g0cf542b` | latest release |
| `TRPG_SERVER_RELEASE_TAG` | Pin only the one-click server binary/source download tag; the installer writes this automatically for release builds | `TRPG_RELEASE_TAG`, else latest release |
| `TRPG_ENABLE_VECTOR_DB` | worldbook / document retrieval | `true` |
| `TRPG_TUI__JOIN_TIMEOUT` | seconds an unauthenticated connection has to send `join` before being closed | `10` |
| `TRPG_CENSOR__WORDLIST_PATH` | Content-moderation wordlist: a JSON file `{"word": level, ...}` (level `1`-`5`, see `gateway.ops.CensorLevel`). See [Content moderation](#content-moderation) | *(empty = moderation OFF)* |
| `TRPG_CENSOR__WORDLIST` | Content-moderation wordlist, inline: `word[:level],word2[:level2],...` — an alternative to a file, handy for one env var. Combines with `WORDLIST_PATH` if both are set | *(empty = moderation OFF)* |

Discord, official QQ, Telegram, Feishu, and OneBot 11 all have mock-tested adapters and can share
a RoomHub with the Iroh TUI. Every network adapter remains **Experimental** until its real-platform
checklist passes; OpenTUI remains the primary client. Install only the SDK extras you need (QQ and
OneBot use core dependencies), check the resolved configuration, then name any configured subset:

```bash
uv sync --extra discord --extra telegram --extra feishu
uv run python -m app --doctor
uv run python -m app --serve --keys ./data/keys.toml --platforms discord,qq,telegram,feishu,onebot
```

Combined mode keeps the Iroh server running alongside the selected adapters and gives every
transport the same data directory, keystore, and logical rooms. See [Chat platform adapters](chat-platforms.md)
for platform permissions, capability fallbacks, OneBot connection modes, and the required smoke tests.

ChatGPT subscriptions are not API keys. For the direct subscription path, start
the server, run `.model login chatgpt` from a private/local Keeper chat, complete
the device-code flow, then run `.model set chatgpt [model]`. Leave
`TRPG_LLM__BASE_URL` blank for this path; Loreweaver uses the saved OAuth grant,
not browser cookies or web-session automation. `.model login supergrok` followed
by `.model set supergrok [model]` selects the SuperGrok subscription path and can
also supply its image-generation bearer.

Existing compatible gateways remain supported: set provider to `chatgpt` or
`gpt-subscription`, explicitly set `TRPG_LLM__BASE_URL=<gateway /v1 endpoint>`,
and provide the gateway API key. An explicit `base_url` always selects this
classic proxy path rather than subscription OAuth.

Release builds publish an adjacent `.sha256` for every client and server archive. The
installer verifies the client digest before extraction; one-click hosting verifies the
selected server archive. If an older binary release has no sidecar, or its checksum metadata is
unreachable or malformed, one-click hosting falls back to the selected source path. A valid
checksum that does not match the downloaded archive is fatal. Untagged `main` builds and numeric
stable `v*` tags become GitHub's Latest release; explicitly tagged prereleases remain
pre-releases. The HTTP mirror keeps a flat compatibility copy for its one-line installer and an
immutable copy at `releases/<tag>/` for every published build. A released or pinned installer
uses the tag-specific mirror copy, so a later development publish cannot replace its fallback
archive. An embedded digest is accepted only when the selected tag matches the installer's
embedded tag; other selections fetch the selected archive's sidecar. Checksum mismatches are
fatal and never trigger extraction or a fallback to a different payload.
The installer uses `https://registry.npmjs.org` by default; set `TRPG_REGISTRY` only when you
intentionally choose another registry.

## Encryption

Iroh player connections are **end-to-end encrypted by construction** (QUIC/TLS, each peer
authenticated by its public key), with no certificate to manage. This protects traffic between
an OpenTUI player and the Loreweaver server; it does not say what the server sends to a configured
model provider or chat platform.

The experimental OneBot adapter is a separate boundary. Forward mode uses the `ws://` or `wss://`
URL you configure; the reverse listener is plain WebSocket and defaults to loopback. Its Bearer
token authenticates the peer but does not encrypt traffic. Keep reverse mode on the same host or
a trusted private network, or put a secure tunnel/terminating proxy in front of it before exposing
it beyond that boundary. A non-loopback reverse listener is rejected unless `ACCESS_TOKEN` is set.

## Data flow and trust boundaries

- The deterministic rules engine, SQLite campaign state, media, room keys, and backups stay on
  the server you operate. The Iroh relay, when one is needed, carries encrypted traffic and does
  not terminate the application session.
- An enabled hosted chat platform necessarily processes its users' platform IDs, inbound message
  bodies/attachments, and the replies sent through its bot API. Its retention and operator policy
  are outside Loreweaver's trust boundary. A self-hosted OneBot implementation instead belongs to
  the network boundary you operate.
- A **remote** LLM endpoint is a separate data processor. It receives module text for analysis,
  the Keeper system prompt (which currently contains near-full Keeper-only lore), relevant
  conversation history, and the current player input. The standard app uses a local hash
  embedder; if an embedding backend is explicitly replaced with a remote implementation, document
  chunks also go to that endpoint. Select a local endpoint such as Ollama or LM Studio when this
  material must remain on infrastructure you control.
- The player knowledge pool and each NPC/companion actor are structurally scoped: a sub-actor is
  built only from its own record and sheet. The main Keeper is intentionally different — it sees
  secrets in order to run the mystery. Prompt instructions and the nightly live-model red-line
  eval reduce and measure its leak risk; they are not a proof that every model will behave.
- Player keys are room-scoped. Keeper keys can read Keeper-only state and manage keys only for
  their own room, but provider/model configuration is deployment-wide. Issue Keeper keys only to
  fully trusted co-administrators. A caller-supplied custom provider URL is never paired with an
  older saved API key unless the caller supplies that key for the new endpoint.
- Provider API keys and subscription OAuth grants are stored unencrypted in the local SQLite
  database so hot configuration survives restart. They are sent as authorization only to the
  chosen provider endpoint, not to players. Treat the host account and its backups as part of the
  trusted computing base.

## Content moderation

`gateway.ops.Censor` is a real, bypass-resistant word matcher (NFKC + casefold
normalization, de-obfuscation for spaced/punctuated/fullwidth spellings,
whole-word boundaries, offset-preserving masking) — but **it ships with no
wordlist and is OFF by default.** Loreweaver deliberately does not bundle a
profanity/slur list: maintaining one, and getting multilingual coverage
right, is a policy choice each deployer should own, not something baked into
the engine. With no wordlist configured, `Censor` takes an explicit no-op
path on every call — it is not silently filtering anything.

To turn it on, set **one** of `TRPG_CENSOR__WORDLIST_PATH` (a JSON file) or
`TRPG_CENSOR__WORDLIST` (an inline list) — see the
[Configuration](#configuration) table above. Example file:

```json
{ "some-slur": 5, "some-mild-word": 2 }
```

Levels are `1` (`NOTICE`) through `5` (`FORBIDDEN`); a hit at `DANGER` (`4`)
or above blocks the message (the reply is replaced), below that it is masked
in place. Word matching is locale-agnostic — list whatever words/scripts you
need moderated.

**Current scope — read before relying on this:**

- It only screens the **AI Keeper's own narration** (`agent.loop.run_kp_turn`'s
  `output_review`, wired in `gateway.runner.GatewayRunner` and
  `net.tui_server.TuiServer`). **Player input is not screened.** A player can
  type anything; only what the Keeper says back is checked.
- It is a wordlist matcher, not a semantic classifier — it catches listed
  words (and simple obfuscations of them), nothing it wasn't told about.

Do not treat this as a moderation solution out of the box — it is a
configurable building block that does nothing until you supply a wordlist.

## Keys & persistence

- **Keys** bind an opaque token to a `room` (the shared `chat_key`) and a role.
  Mint with `--tui-key add`; unknown keys are rejected on join. The keystore is
  a TOML file (`keys.toml`) — never commit it.
- **Persistence** is a single SQLite file (`loreweaver.db`) holding all
  campaign state, scoped by `room`. Keep the `/data` volume to keep progress.
- **Provider credentials** entered at runtime, including subscription OAuth
  access/refresh grants, are stored unencrypted in that local SQLite file so
  they survive restart. Protect the database like `.env` or `keys.toml`.
- **Room backups** created from the keeper admin UI are server-side JSON
  snapshots confined to `<data_dir>/room_backups/`; an optional path is treated as a
  filename inside that directory. They include raw access keys, room state, vector data,
  and self-contained media blobs, so protect them like
  `keys.toml`.
- **Local permissions** are tightened on new secret-bearing files (`0600`) and dedicated data /
  backup directories (`0700`) where the filesystem implements POSIX modes. On Windows or filesystems
  without POSIX permissions this is best-effort, not an ACL manager.
- **Secrets** (`.env`, `keys.toml`, `keeper-key.txt`, `*.db`, backups) are git-ignored; only
  `*.example.*` files are tracked. Never commit them.

## Connecting clients

Clients speak the versioned protocol in [`docs/protocol.md`](protocol.md) over Iroh. Point the
terminal client at the server's **ticket** (printed at startup) with a minted key:

```bash
cd clients/tui && bun install
bun run dev -- connect --host <ticket> --key <key> --name <name>
# or just `loreweaver` (installed client) and paste the ticket + key in the connect screen
```

The connection is end-to-end encrypted; the server is key-gated, but treat keys as secrets.
