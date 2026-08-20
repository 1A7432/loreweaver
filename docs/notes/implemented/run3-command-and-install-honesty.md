# Implemented: the run-3 batch — four replies that were not true

- **Problem:** four surfaces reported something other than what happened. (1) Both `.st`
  scans take "everything before the value" as the attribute NAME, so `.st <teammate> <attr>
  <n>` — a real habit from dice-bot dialects — minted a ghost attribute "<teammate> <attr>"
  on the CALLER's own sheet and echoed it back as updated, while the named character's real
  attribute never moved. (2) The pack trust card is shared by two doors, and its world-card
  line ends "the keeper imports them with `.import <file> world`" — right for the terminal,
  where install is not import, and wrong in a room whose install had just imported the
  unique world card itself. (3) A pack-declared `loss_ceiling` that zeroed a loss printed
  the line written for a DECLARED zero ("the declared failure cost was 0"), so a module
  whose signature mechanic is a conditional immunity read as broken dice. (4) A `gh:`
  install from a shared or cloud address fails as an HTTP 403; the engine has honoured
  `GITHUB_TOKEN`/`GH_TOKEN` since 2026-08-19 but never said so.
- **Verdict (owner, 2026-08-20): fix all four**, with one amendment on (1) — do NOT refuse
  unknown single-token keys, because inventing a house skill mid-session (`.st 学识星象=45`)
  is what `.st` is for; refuse the WHITESPACE, which is the mis-parse.
- **Shape:** `.st` refuses, before any write, an assignment name holding whitespace that the
  room's pack does not resolve; when its first token names a character on the roster or in
  the pregen cast, the refusal says `.st` writes your own sheet alone, and either way it
  spells the corrected command out of the remainder (`.st 力量+=3`) when that remainder reads
  as one plausible key. `trust_card_lines` takes `instructional`, and the room door passes
  `False` for a count-only world-card line; the CLI door is unchanged, and the `.import`
  forks in the room reply (which name the ref a keeper would really type) are untouched.
  `check_with_loss` stops attributing a ceilinged zero to the caller's declaration and
  writes `loss_ceiling` into the session record, so the report, the recap and the Keeper
  re-reading the turn all see the cap; the wire `detail` already carried it. `PackRefError`
  gains an optional `hint` naming an i18n key — an engine literal, never caller text — set
  only on a 403 from the release-metadata request when no token is configured, and both
  install doors render it.
- **Not changed, on purpose:** unknown SINGLE-token keys still write, per the owner
  amendment above — an undeclared name without whitespace is a house skill, not a mis-parse.
  A pack-DECLARED multi-word name (`spot hidden=70`) still writes for the same reason: it
  resolves, so nothing was mis-parsed, and refusing it would cost English tables a documented
  form. The dice `detail` keeps its existing `loss_ceiling` field rather than gaining a
  `capped` twin — present-only-when-applied already says both things, and the protocol stays
  2.3. A 403 with a token already set suggests nothing: it means something else.
- **Rule home:** `gateway/commands/sheet.py` (`_refuse_spaced_key` — why whitespace and not
  unknown-ness is the test); `gateway/pack_install.py` (`instructional` — which door is
  rendering); `agent/kp_tools_subsystems.py` (`_run_check_with_loss` — the ceiling clause is
  generic, the engine never names a pack's fiction); `infra/pack_source.py` (`PackRefError.hint`).
- **Date:** 2026-08-20.
