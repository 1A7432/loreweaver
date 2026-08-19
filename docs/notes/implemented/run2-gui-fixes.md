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
- **Shape:** a rulepack resolution MISS re-checks the discovery dirs' mtime signature once
  and reloads before giving up (an unchanged signature rescans nothing, so a bad name cannot
  start a scan storm, and the hit path never stats). `GITHUB_TOKEN`/`GH_TOKEN` authorizes the
  release lookup and ONLY requests to `api.github.com` — never the asset host, never a
  caller-named `https://` ref. The queue receipt is fire-and-forget on purpose: awaiting it
  between the `locked()` check and the `acquire()` would let two racing inputs swap places in
  the lock's FIFO waiter queue. `turn_status` gains OPTIONAL `activity` (four closed
  categories — a tool name or argument on a room-wide frame would leak keeper-side material)
  and `round`, published per tool round through an `AgentCtx.activity_sink` the gateway
  injects only on the player-turn path, which is the same structural gate the Scribe and the
  Director already have. `agent.tool_trace.trace_event` writes non-tool decisions into the
  same JSONL under the same `tool` field, so one reader serves both; the Director's image
  outcome NAMES which gate said no (`kit_missing` / `template_denied` / `imagegen_off` /
  `ref_missing` / `budget` / `llm_failed` / `larder` / `ref_fallback` / `generated`). When
  generation declines, the subject's own 定妆 reference is shown — it is the very image a
  generation would have been conditioned on — charging no budget and reusing the larder
  entry; no reference still means no picture, so 宁缺毋滥 is untouched. `gateway/pack_install.py`
  is the ONE install implementation both doors call.
- **Not changed, on purpose:** `core.skills` discovery has the SAME out-of-process staleness
  as `core.rulepacks` had; this batch was scoped to rulepacks, and the in-room installer
  clears both caches itself, so the gap is only reachable when another process installs a
  pack carrying skills. `gateway.panels`'s card-kind memos were audited and are NOT stale by
  construction (they key on the pack home and its manifest's identity) — pinned by test
  rather than "fixed". The wire protocol stays 2.3: the new `turn_status` fields are
  optional additions, so only the npm package's free patch component moved (2.3.0 → 2.3.1).
- **Rule home:** `docs/protocol.md` (`turn_status`); `docs/plugins.md` Discovery §
  (`.pack install`, the GitHub token); `docs/defensive-patterns.md` #1 (why the receipt is
  not awaited); `agent/stage_director.py` (the image outcomes); `agent/tool_trace.py` (what
  the probe holds).
- **Date:** 2026-08-19.
