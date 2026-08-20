# Implemented: the run-2 GUI play-test batch — stale registries, silent waits, blind lanes

- **Problem:** the 2026-08-19 run-2 (desktop client against a cloud-hosted server) surfaced
  eight faults that were not bugs in any one component. (1) `core.rulepacks` discovery and
  alias resolution are process-lifetime caches and only an IN-process install cleared them,
  so a pack installed by the desktop client — which shells out to the CLI, another process —
  left the running server permanently unable to resolve its rulepack. (2) `.import`'s option
  loop silently skipped a token that was neither a role nor a resolvable system, so three
  explicit `coc7-antu` attempts were dropped and the card imported under the default system:
  the amplifier that turned (1) into a mystery. (3) `gh:` installs hit GitHub's per-IP
  anonymous rate limit as a 403 from a shared cloud address. (4) Input typed during a running
  turn produced no acknowledgement at all until the turn ended, so it looked lost. (5) A long
  turn published one `busy` frame and then went quiet — a slow turn and a hung one were
  indistinguishable. (6) The tool probe sees only what the model ASKED for, so the session's
  zero images could not be attributed: neither the Scribe's per-turn verdict nor the
  Director's decision is a tool call. (7) A room with no image provider staged nothing at
  all, though the module ships fourteen authored 定妆 references. (8) `.companion list`
  answered "this room has no cast records", which is about the other list.
- **Verdict (owner, 2026-08-19): fix all eight**, plus one design call — on a REMOTE table,
  `.pack install` means install AND enable, with a risk line rather than a per-item trust
  ceremony, because the terminal's confirmation has no honest wire equivalent and a keeper
  who typed the ref has already made the trust decision.
- **Shape:** a rulepack resolution MISS re-checks the discovery dirs' signature (names,
  `mtime_ns` and sizes) and reloads before giving up; an unchanged signature rescans nothing,
  so a bad name cannot start a scan storm. Two commits widened it the same week: 13ad1c5 put
  the same check on the HIT path and on the listings — throttled to one stat sweep every
  couple of seconds — because a pack REINSTALLED under an id already resolved is a hit that
  would otherwise keep serving the old scan; and 2026-08-20 gave the command router the same
  self-heal one layer up, since its dot-command dialect table is a snapshot of
  `all_command_words()` taken when it was built. `GITHUB_TOKEN`/`GH_TOKEN` authorizes the
  release lookup alone — d977de8 narrowed it from "any request to `api.github.com`" to the
  request this module composes itself, so a caller-named `https://api.github.com/…` ref is
  fetched anonymously, and a redirect that leaves the host (or merely downgrades to `http` on
  it, 2026-08-20) drops the header. The queue receipt is fire-and-forget on purpose:
  awaiting it between the `locked()` check and the `acquire()` would let two racing inputs
  swap places in the lock's FIFO waiter queue. `turn_status` gains OPTIONAL `activity` (four closed
  categories — a tool name or argument on a room-wide frame would leak keeper-side material)
  and `round`, published per tool round through an `AgentCtx.activity_sink` the gateway
  injects only on the player-turn path, which is the same structural gate the Scribe and the
  Director already have. `agent.tool_trace.trace_event` writes non-tool decisions into the
  same JSONL under the same `tool` field, so one reader serves both; the Director's image
  outcome NAMES which gate said no (`kit_missing` / `template_denied` / `images_off` /
  `pack_only` / `no_provider` / `ref_missing` / `budget` / `llm_failed` / `larder` /
  `ref_fallback` / `generated` — the one `imagegen_off` word was later split into the three
  different noes it was hiding). When generation declines, the subject's own 定妆 reference
  is shown — it is the very image a generation would have been conditioned on — charging no
  budget and leaving the larder alone. (c862364 took the fallback back OUT of the larder:
  the larder is consulted before generation, so an entry written there retired the subject
  forever; the reference is re-shown on every beat that names the subject instead.) No
  reference still means no picture, so 宁缺毋滥 is untouched. `gateway/pack_install.py` is
  the ONE install implementation both doors call.
- **Closed right after, not in this batch:** `core.skills` discovery had the SAME
  out-of-process staleness, deliberately left alone here because the in-room installer clears
  both caches itself; 40e2c7a gave it the twin treatment a day later, and 0f9078f pointed
  `.skill enable` at `load_skill` so the command a keeper reaches for right after installing
  resolves rather than reading the throttled listing.
- **Not changed, on purpose:** `gateway.panels`'s card-kind memos were audited and are NOT
  stale by construction (they key on the pack home and its manifest's identity) — pinned by
  test rather than "fixed". The wire protocol stays 2.3: the new `turn_status` fields are
  optional additions, so only the npm package's free patch component moved (2.3.0 → 2.3.1).
- **Rule home:** `docs/protocol.md` (`turn_status`); `docs/plugins.md` Discovery §
  (`.pack install`, the GitHub token); `docs/defensive-patterns.md` #1 (why the receipt is
  not awaited); `agent/stage_director.py` (the image outcomes); `agent/tool_trace.py` (what
  the probe holds).
- **Date:** 2026-08-19 (text corrected 2026-08-20, where later commits overtook it).
