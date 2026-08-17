# Agent Notes

Decision records for the humans and AI-agent lanes working this repo in
parallel (instituted by M23 WS4). Three states:

- `implemented/` — standing doctrine describing current reality, written in
  the present tense.
- `rejected/` — proposals the owner rejected. **Check here before proposing a
  mechanism in the same territory**; a rejection is binding until the owner
  reopens it.
- `pending/` — questions raised in review that are waiting for an owner
  verdict. Nothing here is doctrine. After you decide, move the note into
  `implemented/` or `rejected/` (or delete it) in the same change that
  follows through.

Format for `implemented/` and `rejected/`: five lines — problem / verdict /
reason / date, plus a "rule home" link when AGENTS.md or a module docstring
owns the operative rule (notes record the WHY and WHEN; they never duplicate
the rule text — one home per rule).

Format for `pending/`: problem / options / recommendation / impact / date.
A non-trivial change adds or updates a note in the same PR.
