# Rejected: chat-platform adapters (Discord/QQ/Telegram/Feishu/OneBot)

- **Problem:** five platform adapters shipped, each demanding its own
  hardening backlog forever.
- **Verdict:** all five removed outright (8ea12b5); never re-add one.
- **Reason:** the UI direction is protocol clients with a deeply customizable
  UI extension layer (`ui` frames, panels), which text-chat platforms
  structurally cannot render. Build against `docs/protocol.md` instead.
- **Rule home:** AGENTS.md architecture section (`adapters/`).
- **Date:** 2026-07-30 (owner).
- **Clarification (2026-09-14):** a protocol-client bridge (the terminal client's OneBot 11 mode) is not an adapter. It lives under `clients/`, speaks `docs/protocol.md`, and does not re-enter `adapters/`.
