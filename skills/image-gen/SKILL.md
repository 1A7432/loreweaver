---
name: Image generation
description: >
  Enable to let the Keeper generate occasional player-visible scene, portrait, or item handouts
  through the configured external image provider.
allowed-tools: [generate_image]
metadata:
  scope: room
  content-rating: ""
---

# Image generation

Use `generate_image` sparingly when a single visual handout would clarify or heighten a moment:

- a new scene or location is established
- an important NPC appears for the first time
- the party receives a key item, clue, document, or visual handout

Frequency discipline:

- at most one generated image per scene
- do not call repeatedly to iterate or polish
- do not interrupt action scenes just to add decoration

Information discipline:

The prompt is sent to an external service, and the image is visible to the whole table. Include
only facts the players already know. Do not include keeper-only secrets, hidden rooms, unrevealed
monsters, culprit identities, trap truths, private NPC motives, or any other future reveal.

Call `generate_image` with:

- `prompt`: a concise player-safe image prompt
- `kind`: `scene`, `portrait`, or `item`
- `caption`: optional short caption you may narrate after the image appears

After the tool sends the handout, continue the scene naturally. Do not describe the tool call or
the API.
