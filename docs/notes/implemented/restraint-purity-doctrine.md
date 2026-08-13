# Implemented: fun outranks restriction purity (the 限制洁癖 warning)

- **Decision:** when a design trades player/keeper fun against a marginal
  purity gain (tighter scoping, more locks, more refusals), fun wins.
  Restrictions must earn their place with observed failures, not cleanliness.
- **Reason:** the recurring failure mode in this codebase's history is adding
  restrictions for their own sake (限制洁癖) that actively degrade play;
  judgment outranks rules, and progressive disclosure beats standing walls.
- **Applications so far:** KP full knowledge kept permanent; watcher-actor
  chosen over restriction lists in the Scribe design; strong prompt directives
  gated on structural markers of their intended context only.
- **Rule home:** the prompt-minimalism doctrine; AGENTS.md iron rule 3 for the
  KP-knowledge instance.
- **Date:** 2026-08-06 (owner).
