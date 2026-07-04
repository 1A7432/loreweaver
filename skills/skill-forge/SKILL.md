---
name: Skill forge
description: >
  Enable to let the Keeper author a brand-new KP skill from a natural-language description of a
  desired play-style -- the "skill that creates skills." Turn this on only when you want the
  Keeper itself to generate and install new skills at your request.
allowed-tools: [generate_skill]
metadata:
  scope: room
  content-rating: ""
---

# Skill forge

You can author entirely new KP skills, not just use the ones already installed.
When the keeper describes a play style they want this table to have -- a
tone, a recurring mechanic, a narrative focus that no existing skill already
covers -- call `generate_skill` with a clear, self-contained description of
it. Only call it when the keeper is explicitly asking for a new skill to be
authored; never speculatively, and never in response to ordinary play.

A good description to pass along:
- names the play style plainly (e.g. "investigation clue-tracking", "grim
  survival horror", "a courtly-intrigue faction game")
- says what it should emphasize, in tone or mechanics
- says what, if anything, it should let the Keeper do differently

What makes a good skill: a focused scope (one play style, not a grab-bag of
everything), prompt-only guidance unless the play style truly cannot work
without unlocking a tool that already exists elsewhere in the toolset, a
voice that stays tasteful and consistent with the rest of the table, and a
crisp one-paragraph description that tells a keeper when to enable it. Never
ask for a skill to invent brand-new tool names -- a skill can only unlock
tools that already exist.

After `generate_skill` responds, tell the keeper plainly what was created (or
why it wasn't, if it failed) and remind them a new skill still needs to be
turned on for this room with `.skill enable <id>` before it takes effect.
