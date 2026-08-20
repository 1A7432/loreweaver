# Rejected: a shadowed-id gate on `.pack install` skill enabling

- **Problem:** `.pack install` enables every KP skill a pack ships. A pack may ship a
  skill directory named after a BUILT-IN id — `mature-mode`, the forge skills — and the
  2026-08-20 review proposed refusing (or asking before) enabling those, on the grounds
  that the pack's name choice, not the keeper's, then flips a built-in behaviour switch.
- **Verdict:** rejected by the owner the same day. Naming a built-in id enables it,
  exactly as naming any other id does; only the reply changes, gaining one line that
  names every shadowed id.
- **Reason:** the ST trust model applies here as everywhere — extensibility and author
  freedom outrank a gate on content the operator chose to install. Install IS enable on a
  remote table (2026-08-19, sharpened 2026-08-20), and a keeper who typed the ref has made
  the trust decision for the whole pack; the trust card already discloses skills, hooks,
  EJS and rules code BEFORE the install. A gate on this one case would ask a second time
  for less: it cannot tell a pack that means to enable `mature-mode` from one that named
  the id by accident, and the disclosure line tells the keeper either way.
- **Consequence, accepted:** a pack can deliberately enable built-ins — `mature-mode` (which
  lifts the output censor for the room) and the forge skills included — by naming them in
  `contents.skills`. The pack's OWN file still never runs: a built-in always wins discovery,
  which is what the new `commands.pack.shadowed` line tells the room.
- **Rule home:** `docs/plugins.md` (install ≠ enable, and the in-room exception);
  `gateway/commands/panels.py::_switch_everything_on` (the line, and why it is not a gate);
  `docs/notes/implemented/pack-install-receipt-and-command-table.md`.
- **Date:** 2026-08-20 (owner).
