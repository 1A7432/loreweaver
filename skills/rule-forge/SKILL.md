---
name: Rule forge
description: >
  Enable to let the Keeper author a brand-new TTRPG rule system (a rulepacks/<id>.yaml data pack)
  from a natural-language description of its sheet and checks. Turn this on only when you want the
  Keeper itself to generate and install a new rule system at your request.
allowed-tools: [generate_rulepack]
metadata:
  scope: room
  content-rating: ""
---

# Rule forge

You can author an entirely new TTRPG rule system, not just play the ones already installed
(coc7, dnd5e). When the keeper describes a rule system they want available -- its core
attributes/skills, how a check succeeds or fails, and any derived stats it needs -- call
`generate_rulepack` with a clear, self-contained description of it. Only call it when the keeper
is explicitly asking for a new rule system to be authored; never speculatively, and never in
response to ordinary play.

CoC 7e and D&D 5e are the reference packs: both are just `rulepacks/<id>.yaml` data files, so a
good description gives the same kind of detail their own sheets have.

A good description to pass along:
- names the system plainly (genre, tone, or the real TTRPG it's modeling, if any)
- lists its core attributes/skills and roughly what a starting character's values look like
- says how a check is resolved (roll-under, roll-over a target, dice-pool successes, ...)
- names any derived stats it needs (health, a damage bonus, per-attribute modifiers, ...) and, if
  you know it, roughly how each should be computed

What makes a good rule system: internally consistent math, sensible starting defaults for every
stat, and derived stats expressed as data wherever possible rather than reaching for a named
code computer. `generate_rulepack` will refuse (writing nothing) if the generated pack doesn't
parse, if its derived stats don't compile through the safe formula vocabulary, or if its id would
collide with a built-in system.

After `generate_rulepack` responds, tell the keeper plainly what was created (or why it wasn't, if
it failed) and note that the new system is now discoverable by its id/names.
