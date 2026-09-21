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
- **Addendum 2026-09-20, batch 2 (owner decisions):** member keys are named after
  the group card (nickname, then `qq:<id>`), with `key_id` always
  `sha256(key)[:16]` — the server's own derivation — because a lookup by name
  crosses two players who share a card; private replies carry `group_id` so
  NapCat uses the group temp session for non-friends, but only after a LIVE
  membership check, since NapCat falls back to posting into the group when it
  cannot resolve the user (iron rule #3); a heartbeat watchdog (2.5× the
  announced interval) redials half-open sockets; output over one message goes
  out as a merged-forward card; a reply to the Keeper without an @ stays
  ignored (QQ inserts the @ on reply; a deleted @ is deliberate).
