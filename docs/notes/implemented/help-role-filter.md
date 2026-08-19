# Implemented: `.help` is two layers (player verbs, then keeper)

- **Problem:** `cmd_help` dumped every registered spec. A networked player
  saw `.dev`, `.var`, `.model`, `.reset` next to `.roll` / `.check` / `.pc`.
  Each is gated and denies cleanly, but the list taught the wrong map of the
  table and advertised operator surfaces.
- **Decision:** two-layer help. Players get play verbs plus a one-line hint
  that the keeper has more. Keepers get that list plus a second `Keeper:`
  line. `CommandSpec.keeper_help` (and `required_level > 0`) marks the
  operator line. `.help` itself is `private_reply` so a keeper's second line
  is not broadcast.
- **Reason:** players should be able to play from `.help` without seeing
  `.dev`. Keepers still need the full wall. Owner picked option 3 in the
  2026-08-17 three-persona review.
- **Rule home:** `gateway/commands/` (`types.CommandSpec.keeper_help`, `router.cmd_help`).
- **Date:** 2026-08-17.
