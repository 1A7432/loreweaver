# Implemented: TUI chases Studio to protocol-complete discovery, not riches

- **Problem:** both clients speak protocol 2.1, but Studio had a pregen claim
  button, tier-2 iframes and rich blocks while the TUI hid `state.pregens`
  behind a typed command — two players at one table had different tables.
- **Verdict:** owner picked option 2 (2026-08-17) — the TUI gets the discovery
  surfaces the protocol already ships (a pregen claim row in the party roster;
  clearer "needs Loreweaver Studio" fallback copy) and deliberately NOT the
  rich surfaces (no iframes in a terminal). The split above discovery is the
  product, not a gap.
- **Reason:** claim-without-a-command was the one player verb the protocol
  shipped that the TUI still hid; tier-2 in a terminal is not worth its cost.
- **Rule home:** `clients/tui/src/components/PartyRoster.tsx` (pregen section),
  `clients/tui/src/GameView.tsx` (focus wiring), i18n keys `party.pregens` /
  `party.pregenClaimed` / `panels.richOnly`.
- **Date:** 2026-08-17.
