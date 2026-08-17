# Pending: how far TUI play should chase Studio

- **Problem:** Both clients speak protocol 2.1. The 2026-08-17 review sat the *protocol* (TuiServer keeper+player, isolation green) and the TUI unit suite (296 pass), not the OpenTUI/Tauri pixels. Code + tests already show a lasting split: Studio has pregen claim in `StatePanel`, tier-2 iframes, rich performance blocks, media/audio decks, keeper `.var set/add` on the desk. TUI has `.pc claim` as a command only, tier-2 fallback text, performance blocks as lines, no claim button. That is coherent with “terminal-first, rich client for instruments,” but a player on TUI and a player on Studio at the same table do not have the same *table*.
- **Options:**
  1. Freeze the split. TUI is the readable table (log, dice, sheets, fallbacks). Studio is the instrument table (tier-2, claim UI, decks). Document it as the product, not a gap.
  2. Bring TUI up to protocol-complete *discovery* only: a pregen claim row in the party panel, clearer “rich client” fallback copy. No iframe in a terminal.
  3. Treat Studio Play as the primary player client and let TUI stay operator/dev.
- **Recommendation:** (2). Claim-without-a-command is the one player verb the protocol already ships (`state.pregens`) that TUI still hides. Tier-2 iframes in a terminal are not worth it. Do not pick (3) unless you want to stop telling new players to run `loreweaver`.
- **Impact:** `clients/tui` PartyRoster / a small Pregen panel; i18n; Studio unchanged. No protocol bump.
- **Date:** 2026-08-17 (three-persona review).
