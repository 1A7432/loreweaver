# Pending: `--cli --script` shares the networked rate limiter

- **Problem:** The documented author smoke path (`docs/authoring.md` §8: `--pack` → `--install` → `--cli --script`) rate-limits like a networked player. A realistic wiring script (`.panels enable`, `.skill enable`, `.import … world`, `.pc list`, `.var list`, `.phase`, one roll) dies mid-file with “Too many messages too quickly.” The tutorial already says “keep run files short or split them,” so this is intentional — and it makes the tutorial’s own end-to-end script unreliable.
- **Options:**
  1. Leave it. Authors split scripts. The warning stays in the tutorial.
  2. Exempt `platform=cli` from `RateLimiter` (local operator is already `_AUTO_MASTER`).
  3. Exempt only `--script` / `--exec` (interactive CLI still limited, if that ever matters).
- **Recommendation:** (3). A file the operator handed the process is not a flood; the limiter’s job is the network. Interactive CLI can stay limited if you want the same muscle memory as a table.
- **Impact:** `gateway/ops.py` RateLimiter call sites / `adapters/cli`; one regression test; a one-line note in `docs/authoring.md` §8.
- **Date:** 2026-08-17 (three-persona review).
