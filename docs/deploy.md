# Deploying Loreweaver

Self-host the networked Keeper (the WebSocket server that terminal / web / SSH
clients connect to). One command brings it up; players join with deployer-issued
keys — there is no account system.

## TL;DR

```bash
# Docker (recommended) — build + start the server, detached, on :8787
./scripts/deploy.sh

# No Docker — venv + pip install + run in the foreground
./scripts/deploy.sh --bare-metal
```

`deploy.sh` creates `.env` from `.env.example` on first run, then either
`docker compose up -d --build` or sets up a `.venv`. Re-running is safe.

## Option A — Docker (recommended)

```bash
cp .env.example .env          # then set TRPG_LLM__* (or leave blank for the offline demo)
docker compose up -d --build  # build the image + start the server on :8787
docker compose logs -f        # follow logs
docker compose down           # stop
```

- The image is `python:3.12-slim`, runs as a non-root user, and starts
  `python -m app --serve --host 0.0.0.0 --port 8787`.
- Config is read from `.env` (see [Configuration](#configuration)). The file is
  optional — with no API key the bundled **offline demo Keeper** runs.
- State lives in the named volume `loreweaver-data` mounted at `/data`
  (`/data/loreweaver.db` + `/data/keys.toml`), so campaigns and issued keys
  survive restarts and rebuilds. To bind a host directory instead, swap the
  volume line in `docker-compose.yml` for `./data:/data`.

### Mint an access key (Docker)

The image's `ENTRYPOINT` is `python -m app`, so pass only the app arguments:

```bash
docker compose run --rm loreweaver --tui-key add --room table --name Keeper --role keeper
docker compose run --rm loreweaver --tui-key add --room table --name Alice
```

Each command prints a fresh key and appends it to `/data/keys.toml` (the same
volume the server uses), so the running server honors it on the next client
join — no restart needed. Give everyone the **same `--room`** to seat them at
one shared table; `--role keeper` grants Keeper-only powers (default is
`player`).

## Option B — Bare metal (no Docker)

Requires Python >= 3.11.

```bash
./scripts/deploy.sh --bare-metal
```

This creates `.venv`, installs the package (`pip install -e ".[anthropic,gemini]"`),
ensures `.env`, mints a starter keeper key for room `table` on first run, prints
the connect line, and starts the server in the foreground (Ctrl-C to stop).

Manual equivalent:

```bash
uv sync --extra anthropic --extra gemini   # env + deps; drop --extra ... for OpenAI-compatible-only
export TRPG_DATA_DIR=./data TRPG_TUI_KEYS=./data/keys.toml
uv run python -m app --tui-key add --room table --name Keeper --role keeper   # mint a key
uv run python -m app --serve --host 0.0.0.0 --port 8787                       # run the server
# No uv? pip works: python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[anthropic,gemini]"
```

## Configuration

All settings use the `TRPG_` env prefix with `__` for nesting (see
`.env.example` / `infra/config.py`). Docker Compose injects them from `.env`.

| Variable | Purpose | Default |
|---|---|---|
| `TRPG_LLM__PROVIDER` | `openai` (+ presets: `deepseek`, `groq`, `openrouter`, `together`, `ollama`, `lmstudio`, …), or native `anthropic` / `gemini` | `openai` |
| `TRPG_LLM__API_KEY` | provider API key — **blank = offline demo Keeper** | *(empty)* |
| `TRPG_LLM__BASE_URL` | OpenAI-compatible base URL | provider preset |
| `TRPG_LLM__CHAT_MODEL` | chat model id | `gpt-4o` |
| `TRPG_LLM__EMBEDDING_MODEL` / `TRPG_LLM__EMBEDDING_DIM` | retrieval embeddings | `text-embedding-3-small` / `1536` |
| `TRPG_LOCALE` | UI language `en` / `zh` | `en` |
| `TRPG_DATA_DIR` | store + keys directory (db → `<data_dir>/loreweaver.db`) | `/data` (image) |
| `TRPG_TUI_KEYS` | keystore file path | `/data/keys.toml` (image) |
| `TRPG_ENABLE_VECTOR_DB` | worldbook / document retrieval | `true` |

Platform bots (optional): `TRPG_DISCORD__TOKEN`, `TRPG_TELEGRAM__TOKEN`,
`TRPG_QQ__APP_ID` / `TRPG_QQ__SECRET`, `TRPG_FEISHU__APP_ID` /
`TRPG_FEISHU__APP_SECRET`. To run the chat bots alongside the WS server, append
`--platforms discord,telegram` to the serve command (combined mode) — override
the container command, e.g. `docker compose run ... loreweaver --serve --host
0.0.0.0 --port 8787 --platforms discord`.

## Keys & persistence

- **Keys** bind an opaque token to a `room` (the shared `chat_key`) and a role.
  Mint with `--tui-key add`; unknown keys are rejected on join. The keystore is
  a TOML file (`keys.toml`) — never commit it.
- **Persistence** is a single SQLite file (`loreweaver.db`) holding all
  campaign state, scoped by `room`. Keep the `/data` volume to keep progress.
- **Secrets** (`.env`, `keys.toml`, `*.db`) are git-ignored; only `*.example.*`
  are tracked. Don't bake them into the image (the `.dockerignore` excludes them).

## Connecting clients

Clients speak the versioned WebSocket protocol in
[`docs/protocol.md`](protocol.md). Point any client at `ws://<host>:8787/` with
a minted key:

```bash
# Terminal (OpenTUI)
cd clients/tui && bun install
bun run dev -- connect --host ws://localhost:8787/ --key <key> --name <name>

# Browser (React)
cd clients/web && bun install && bun run dev

# SSH (zero-install full TUI) — see clients/ssh/README.md
```

For a real deployment, expose port 8787 (or reverse-proxy it, e.g. TLS
`wss://` via nginx/Caddy). The server is key-gated, but treat keys as secrets.
