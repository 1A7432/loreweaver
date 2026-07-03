# Loreweaver — one-click self-hosted AI Game Master / Keeper (WebSocket server).
#
#   docker build -t loreweaver .
#   docker run -p 8787:8787 -v loreweaver-data:/data --env-file .env loreweaver
#
# For the full stack prefer `docker compose up -d --build` or `scripts/deploy.sh`.
FROM python:3.12-slim

# Predictable, unbuffered Python + no pip cache bloat. Persist the SQLite store
# and minted access keys under /data (a volume) so campaigns survive restarts.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TRPG_DATA_DIR=/data \
    TRPG_TUI_KEYS=/data/keys.toml

# Non-root runtime user that owns both the app dir and the data mount-point, so a
# fresh named volume inherits writable ownership.
RUN useradd --create-home --uid 1000 app \
    && mkdir -p /app /data \
    && chown -R app:app /app /data

WORKDIR /app

# Copy the sources, then install from pyproject (the single source of truth).
# Editable install keeps the top-level `app` and `net` modules importable — they
# are run via `python -m app` from WORKDIR=/app, which is also on sys.path.
# Base deps cover any OpenAI-compatible provider; the extras add native
# Anthropic + Gemini support.
COPY --chown=app:app . /app
RUN pip install --upgrade pip \
    && pip install -e ".[anthropic,gemini]"

USER app

# WebSocket server port (see docs/protocol.md).
EXPOSE 8787

# Liveness: the WS server is accepting TCP on 8787.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8787), 3).close()"

# `python -m app` is the program. This containerized deployment is the reverse-proxied
# `wss://` path (it has a domain + TLS + serves the browser web client), so it runs the
# WebSocket listener and disables the p2p carrier: `--ws --no-iroh`. (Iroh is the DEFAULT for
# a bare `python -m app --serve` laptop host — no domain needed — but a public server with a
# domain doesn't need p2p, and the healthcheck below probes the WS port.) Override the ARGS
# (everything after the image name) to run other subcommands, e.g. mint a key:
#   docker run ... loreweaver --tui-key add --room <room> --name <name>
ENTRYPOINT ["python", "-m", "app"]
CMD ["--serve", "--ws", "--no-iroh", "--host", "0.0.0.0", "--port", "8787"]
