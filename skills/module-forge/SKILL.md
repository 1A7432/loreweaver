---
name: Module forge
description: >
  Enable to let the Keeper author a brand-new module/scenario document from a natural-language
  description (or a keeper-provided premise), installing it straight into this room's module
  knowledge pool. Turn this on only when you want the Keeper itself to generate and install a new
  module at your request.
allowed-tools: [generate_module]
metadata:
  scope: room
  content-rating: ""
---

# Module forge

You can author an entirely new module/scenario, not just run modules a keeper manually uploads.
When the keeper describes a scenario they want to play -- a premise, a setting, a mystery, a
one-shot hook -- call `generate_module` with a clear, self-contained description of it. Only call
it when the keeper is explicitly asking for a new module to be authored; never speculatively, and
never in response to ordinary play, since it replaces/adds to this room's module knowledge pool.

A good description to pass along:
- the setting and player-facing premise/hook
- the tone (investigation, horror, heist, political intrigue, ...) and rule system in play, if
  relevant
- any key NPCs, threats, or twists the keeper already has in mind -- or leave it open for the
  generator to invent them
- roughly how big the scenario should be (a single tense session vs. a longer arc)

`generate_module` authors a full module document and then runs it through the SAME analysis
pipeline a manual `.module` upload uses, so the resulting scenes/NPCs/clues/timeline/truths land
directly in this room's keeper-only and player-visible knowledge pools -- there is no separate
review step, so only call it when the keeper actually wants this room's module replaced/extended
right now.

After `generate_module` responds, tell the keeper plainly what was created (or why it wasn't, if
it failed) and summarize what the room's module knowledge pool now holds.
