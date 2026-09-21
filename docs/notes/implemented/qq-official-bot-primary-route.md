# Implemented: official QQ Bot API as the terminal client's primary QQ route

- **Problem:** The M24 OneBot bridge puts a personal QQ account behind NapCat /
  LLOneBot. That account is the ban surface, and the official Bot API (q.qq.com)
  is a different channel: anchored, budgeted, two modes per group, no QQ numbers.
- **Verdict:** `loreweaver bridge` gains `platform: "qqbot"`. The official Bot
  API is the primary QQ route; the M24 OneBot path stays as the secondary,
  personal-account route. Same process, same state-directory layout, new code
  under `clients/tui/src/bridge/qqbot/`. Not chosen: a separate package, an
  engine-side adapter (the 2026-07-30 rejection stands), webhook transport in v1.
- **Reason:** secrecy stays structural (observer vs player vs admin links, and
  keeper-grade frames never ride a group anchor); `adapters/` stays cli-only; no
  protocol change; `hasCharacter` is derived on the client from the `state`
  frames the engine already sends.
- **Rule home:** AGENTS.md architecture (`adapters/`); `docs/qq-official.md`;
  `clients/tui/src/bridge/qqbot/`.
- **Date:** 2026-09-21.
