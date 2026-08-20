# Implemented: the install receipt, the command table's self-heal, one staging dir per attempt

- **Problem:** an adversarial review of the 2026-08-19/20 pack-install batch reproduced six
  faults, all in what an install PROMISES versus what it does. (1) `CommandRouter` folds
  `all_command_words()` into its spec table once, in `__init__`, and lives as long as the
  process: discovery self-heals against an out-of-process install, but nothing rebuilt the
  table it feeds, so a bundled rulepack's `make_char` and subsystem words routed nowhere
  until a restart — `.wordmake` unhandled on the live router, handled on a fresh one.
  (2) Staging was `packs_dir/.tmp-install-<id>`, one name per pack ID, while `.pack install`
  extracts in a worker thread under a per-ROOM lock: two rooms installing the same pack had
  each attempt's cleanup delete the other's half-extracted tree, leaving a half-written pack
  home or a `FileNotFoundError` escaping a command that localizes `PackError` alone. (3) A
  single world card that failed to import printed the several-modules FORK line, both halves
  untrue. (4) "Its panels and presentation kit are live in this room" printed for packs
  shipping neither. (5) The risk line had been narrowed to panel code by the very commit that
  widened auto-enable to skills and the world card. (6) A skill id a built-in shadows was
  enabled in silence, so the pack's own file never ran and nothing said so.
- **Verdict (owner, 2026-08-20):** fix all six, and the standing ruling holds where they
  touch it — a pack naming BUILT-IN skill ids, `mature-mode` included, still gets them
  enabled. 便利性 > 安全性: the keeper typed the ref, the keeper is the trust subject, and a
  gate here would buy nothing the trust card does not already disclose. What the room gets is
  a line naming every shadowed id — a courtesy for the author debugging "my skill changed
  nothing", not a refusal. (Recorded as `docs/notes/rejected/pack-install-shadowed-gate.md`.)
- **Shape:** a dot-command word no spec claims IS the router's resolution miss, so `resolve`
  re-checks discovery once and rebuilds the spec table and both alias maps before giving up —
  the same doctrine as the registry self-heal, one layer up. The throttle sits on the ROUTER
  (borrowing `core.rulepacks.RESCAN_MIN_INTERVAL_SECONDS`, so relaxing one relaxes both)
  because the trigger is player-typed text: every unmatched `.word` is a miss, and an
  unthrottled probe would let one bad word start a stat storm. `core.rulepacks
  .refresh_discovery()` is the miss door for a caller holding its own snapshot; tables are
  rebuilt into locals and swapped, never mutated in place, because the router is shared.
  `.pack install` calls the same refresh with the throttle skipped — that door knows a pack
  just landed — but the out-of-process door has only the miss path, so the miss path is the
  one that must work. Staging is now one `mkdtemp` per ATTEMPT inside `packs_dir` (the final
  rename stays on one filesystem), and each install sweeps staging trees older than a day,
  since per-attempt names mean nothing else will ever reuse — or clean — what a killed
  process left behind. The receipt claims only what the install did: a failed single card
  says so and names the retry, the panels claim rides the same predicate `.panels enable`
  refuses an empty pack with, the risk line names hooks JS, EJS templates, rule scripts and
  panel code again (server- and client-side), and `_switch_everything_on` takes the whole
  `InstallReport` so the shadowed ids can be named. Alongside: a redirect must stay on the
  host AND on https to keep the GitHub credential (a same-host `http` downgrade puts the
  token on the wire in clear); both discovery fingerprints read `(mtime_ns, size)` like the
  repo's other two; CI runs `bun run test` in `clients/protocol`, so the `tsc --noEmit` gate
  added with the 2.3.1 bump actually runs.
- **Not changed, on purpose:** the shadowed line does not gate, delay or partially enable
  anything (see the verdict). The failed-card branch keeps the "one choice left to you"
  header — it is still a thing left to the keeper, and the retry is named on the line below
  it. `.pack install` still enables the panel pack before knowing whether the pack ships
  panels: enabling an empty pack costs nothing and keeps one enable path, so only the
  SENTENCE was made conditional. And the local-path branch of `infra/pack_source.py` gets no
  path confinement and no path-echo removal — same doctrine, the operator's box.
- **Rule home:** `docs/plugins.md` Discovery § (the signature, and that an install refreshes
  the dialect words); `gateway/commands/router.py::refresh_pack_words` (why the throttle is
  there); `core/pack.py::install_pack` (why staging is per-attempt);
  `docs/notes/rejected/pack-install-shadowed-gate.md` (why enabling is not gated).
- **Date:** 2026-08-20.
