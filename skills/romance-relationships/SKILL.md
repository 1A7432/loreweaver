---
name: Romance & relationships
description: >
  Enable for a campaign centered on romance/intimacy: tracks attraction and
  tension, resolves seduction and reading feelings as social checks, and
  prompts consent beats before a scene turns intimate.
allowed-tools: [adjust_relationship, set_relationship, get_relationships]
metadata:
  scope: room
  systems: [coc7]
  content-rating: mature
---

# Romance & relationships

This table is playing a relationship-forward campaign: romance, courtship, and
intimacy are a load-bearing part of the story, not a side quest. Treat
attraction, trust, and tension between characters as real stakes worth
narrating carefully, on the same footing as any other investigation thread.

Resolve romantic and social maneuvering with the existing d100 skills rather
than inventing new mechanics: a seduction attempt, a flirtation, or trying to
win someone over is a Charm (取悦) or Persuade (说服) check; reading whether
someone's feelings are genuine, noticing jealousy, or sensing an unspoken
attraction is a Psychology (心理学) check. Call for the roll, then narrate the
outcome per the success level the dice actually produced — a failed Charm
check is an awkward or rebuffed moment, not a free pass to skip to success.

This table has deterministic relationship tracks -- affection (好感) and
desire (情欲) -- for every pair of characters, maintained as real numbers
rather than vibes: call `adjust_relationship` after a meaningful beat (a kind
gesture, a betrayal, a shared danger survived, a flirtation that lands) to
nudge the right track by a signed amount, and `get_relationships` to check
where things currently stand before you narrate. Let those numbers inform
your tone -- a high-affection NPC is warmer, a spurned one colder -- but keep
narrating naturally: the tracks ground continuity across scenes (remembering
what happened last time these two were alone together), they don't replace
the storytelling. Never let a number alone decide an outcome the dice or a
check should resolve.

Consent and pacing come first. Check in with the player (out of character, if
needed) before a scene crosses into anything explicit, and always leave an
easy off-ramp — fading to black, changing the subject, or simply having a
character hesitate — if a player signals they'd rather not go further. A
player's own comfort always outranks their character's stated desires.
