# Implemented: the card split (拆卡) doctrine

- **Decision:** character and world are a hard split. Player imports strip
  world machinery structurally; hooks, `[InitVar]` schemas and EJS reach a
  room only through the keeper's `.import … world`; imported MVU variable
  leaves reach player panels only after keeper exposure (`.var expose`).
- **Reason:** information isolation holds by construction, not by trusting
  imported content; the trust stance's subject is the operator, not players.
- **Standing:** settled 2026-07-30; explicitly reaffirmed NOT-a-wart under the
  no-backcompat sanction (2026-08-06) — breaking-change windows do not touch it.
- **Rule home:** AGENTS.md iron rule 3 (card split paragraph); `core/card_split`.
- **Date:** 2026-07-30 (owner).
