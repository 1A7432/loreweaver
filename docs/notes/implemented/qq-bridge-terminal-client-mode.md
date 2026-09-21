# Implemented: QQ bridge as the terminal client's protocol-client mode

- **Problem:** Chinese tables live in QQ groups; the five chat-platform adapters
  were removed because they could not render the UI direction, which left no
  way to play from QQ without bringing an adapter back into the engine.
- **Verdict:** QQ reach returns as a mode of the terminal client
  (`loreweaver bridge`), an ordinary protocol client under `clients/`, not an
  engine adapter. The bot is the Keeper; the human with a keeper-role key is
  the room admin and also a player.
- **Reason:** secrecy stays structural (observer vs player vs admin links);
  `adapters/` stays cli-only; no protocol change.
- **Rule home:** AGENTS.md architecture (`adapters/`); `docs/qq.md`;
  `clients/tui/src/bridge/`.
- **Date:** 2026-09-14.
- **Addendum 2026-09-20 (parity review vs NapCat / LLOneBot):** `access_token`
  is now required in BOTH bridge modes, loopback included (config error
  `token_required`; empty-token NapCat instances were the 2026 mass-ban
  vector), and forward-mode `connect()` is true only after `get_login_info`
  answers — NapCat and LLOneBot reject a wrong token in-band after the
  WebSocket upgrade, so an open socket proves nothing. The official QQ Bot
  API was set as the primary QQ route the same day; this bridge is the
  secondary, personal-account route. Record: `docs/specs/M24-qq-bridge.md`.
