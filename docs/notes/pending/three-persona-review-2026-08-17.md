# Three-persona review — 2026-08-17

Owner adjudication doc. Nothing here is doctrine. Decision forks are listed
at the end and each has a sibling note in this directory; after you decide,
move those notes into `implemented/` or `rejected/`.

I will not promote any pending item myself.

## How this was run

Two repos: engine `trpg_kp` @ `2.1.dev141+ge03d66c`, studio `loreweaver-studio`
(local `main`, ahead of origin). Isolated `TRPG_DATA_DIR` under
`/tmp/lw-review-2026-08-17/`. Review pack: *The Harbour Bell* / 《港钟》
(world card with secret lore + typed trackers + one pregen, skill, `extends:
coc7` rulepack, player + keeper panels, presentation kit v2 `pack_only`, prep
script).

| Path | Sat? | How |
|---|---|---|
| Engine authoring/secrecy pytest (pack, panels, dev-room, sentinels, prep) | yes | 74 pass |
| `python -m app --doctor` | yes | OK; warned Scribe is on flagship xAI/grok-4.5 |
| TUI `bun test` | yes | 296 pass / 33 files |
| Studio vitest (i18n, testDrive, StatePanel, pack lint subset) | yes | 42 pass after the i18n fix |
| Studio `bun test` (bun runner, not vitest) | partial | hits `import.meta.glob` / `vi.hoisted`; real gate is `bun run test` |
| `bun run roundtrip` (incl. live-connect) | **no** | not run this pass (cargo + sibling serve); last known green in HANDBACK 2026-08-15 |
| Author pack `--pack --json` / `--install --yes` | yes | trust card: 1 world card, 2 panels, kit v2, `imagegen: false`, 1 prep script |
| KP/player commands via `CommandRouter` (tui roles) | yes | see walkthrough |
| Official `--cli --script` | yes | hit the rate limiter mid-file |
| Dual client on `TuiServer` (WS loopback, keeper + player) | yes | isolation green |
| OpenTUI pixels / Tauri window | **no** | protocol + unit tests only; marked below |
| Iroh `--serve` + two real clients | **no** | WS loopback used instead |
| Live model | yes | `scripts/playtest.py --turns 3 --players 1 --sessions 1` against `.env` (`xai` / `grok-4.5`) |

Walkthrough transcript: `/tmp/lw-review-2026-08-17/walkthrough-report.json`
and `playtest/walkthrough.py` (gitignored). Dual-client:
`playtest/dual_review.py`.

---

## Author

### Walked

Blank dir → `pack.yaml` + lorecard v1 + `SKILL.md` + `extends: coc7` patch +
`ui/panels.yaml` + `ui/presentation.yaml` v2 + `prep/seed.js` → `--pack --json`
→ `--install --yes` → keeper `.import … world` / `.panels enable` /
`.skill enable` → `.dev mount` → edit lore → `.dev reload` (2 stale entries
replaced, variable values kept).

Following the tutorial’s presentation snippet as it was yesterday (`version:
1`) would have failed the build. `docs/plugins.md` already said v2;
`docs/authoring.md` / `authoring.zh.md` / studio `docs/FORMATS.md` still said
v1. Fixed in this pass.

### Feel

The data model is the good part. One directory, one manifest, detection
(not a `kind:` checkbox) deciding world vs character, trust card computed
rather than authored — that is a real authoring language, not a zip of
vibes. Dev mount is the loop I would actually use; the publish ring
(`--pack` / `--install`) is correctly the release gate.

The concepts that will trip a first-time author, in the order I hit them:

1. **Install ≠ enable ≠ import.** Three verbs, all required, all easy to
   forget. The install banner lists them, then you still have to type them.
2. **Presentation `version: 2` is a hard break.** Tutorial and studio format
   doc were a version behind the parser. That is the kind of drift that
   burns an afternoon.
3. **A patch rulepack does not “turn on.”** `set_keys: [harbour]` does not
   create `.harbour`. `.rule harbour` is the house-rule *ladder*. Pregens
   from the world card were built on the room’s current system (`coc7`), so
   the extra skill never reached the cast. Install copy promises “the usual
   rule commands.” See [module-rulepack-activation.md](module-rulepack-activation.md).
4. **`--cli --script` is the documented smoke path and it rate-limits
   itself.** A wiring script of the length the tutorial sketches dies
   halfway. See [cli-script-rate-limit.md](cli-script-rate-limit.md).
5. **Studio is the only humane editor;** the engine is the authority. That
   split is right. What is missing is a single “I have a folder, make it a
   table” button that does enable+import without teaching the three verbs
   (Test Drive exists in Studio and is the right shape; I did not sit the
   Tauri button this pass).

### Feature ideas (not bugs)

- Pack Bench / Test Drive as the default author path; CLI as the gate.
- Lint that a patch rulepack without a `make_char` word cannot be “switched
  to” by any command the install banner alludes to.
- Advisory: world-card prose now *does* seed a keeper module brief — the
  forge still implying it is inert (UPSTREAM_TODO item 10) should stop.

---

## KP

### Walked

Keeper role on the command router and on a real `TuiServer` join (keystore
name wins over client-spoofed `"Keeper"`). World import, panels, skill,
`.phase` (default **prep** after a not-ready module; pin to play), `.var
list/set` (player-visible + keeper-only), `.pc` roster, hidden vs public
dice, `.recap` / `.chronicle` (empty before Scribe), `.dev mount` (player
denied), `admin`-shaped denial on player `.phase play`.

### Feel

The table *as a machine* is unusually honest. Phase is a real budget, not a
mood. `.var` is the lever iron rule #3 actually needs — typed trackers show
up in the keeper list with a visibility tag, player `state.variables` never
saw `bell_truth`, and `.var list` itself is keeper-gated so a player cannot
even read the hidden remainder. That last choice is correct and also means
the only keeper UI for those trackers is the command (Studio StatePanel can
write them; TUI cannot).

What will make a new keeper feel lost:

- **Prep vs play is a paragraph, not a light.** After world import the room
  stays in automatic prep. Easy to miss that `run_prep_plan` / bulk NPC
  tools will vanish the moment you pin play — or the moment the module
  flips to ready.
- **`.help` is a wall.** Same list for player and keeper — **fixed**
  2026-08-17, two-layer help. See
  [help-role-filter.md](../implemented/help-role-filter.md).
- **Scribe/Director/ctx%.** Doctor already yells that Scribe is on
  flagship grok-4.5. There is no in-client “this extra call is why the
  bill moved.” Chronicle fold is invisible until you type `.chronicle`.
- **World import copy is two counters.** “变量声明 0 条已注入” then
  “类型化变量：2 个追踪器” — InitVar vs typed modvars. I knew the
  difference and still re-read it.

### Feature ideas

- A one-line phase chip on both clients (prep/play + pinned/auto).
- Keeper desk: `.var` list as a panel, not only a command (Studio already
  halfway).
- After first world import, a short “table is wired” checklist: panels /
  skill / system / pregens / expose.

---

## Player

### Walked

Join as `role=player` on WS; name spoof ignored. `.r` / `.rh` / `.ra` on a
claimed pregen (侦查 70, real dice). Exclusive `.pc claim`. `.help`.
`.recap` (empty, player-safe). Host-path and pack-relative `.import … pc`
denied; attachment `.import pc` ran the card split (1 hook + 1 secret
stripped, 1 public lore kept). Player `state` / lore projection / dual-client
wire: no `bell_truth`, no `KEEPER-ONLY`, no keeper-only panel id.

### Feel

You can play without learning a language if someone has claimed a body for
you and the keeper is alive. Dice are readable. Failure is a number plus a
rank, which is what a player actually needs.

The friction is *getting a body* and *knowing what is yours*:

- TUI: no claim button. `state.pregens` is on the wire; Studio
  `StatePanel` already renders it. TUI party panel does not. See
  [tui-studio-play-parity.md](tui-studio-play-parity.md).
- A module-shipped *character* card cannot be imported by a player unless
  they upload it as an attachment. Pack-relative refs are treated as host
  paths. See [player-pack-relative-import.md](player-pack-relative-import.md).
- `.help` looks like you are supposed to memorize forty verbs, most of
  which will just say no.
- Companion presence (live playtest spawned 沈墨) is a second actor in the
  prose with no player-facing “this is an AI companion, it will take its
  own turn” chrome. Protocol marks `ai`; the mind model is still “another
  person typed.”

Natural-language play is the product. The command surface should shrink in
the player’s eyes, not grow.

---

## Studio vs TUI (protocol sat; pixels not sat)

| Surface | TUI | Studio | This pass |
|---|---|---|---|
| Protocol 2.1 join / welcome / role | yes | yes (not sat live) | WS dual-client: role + name authority green |
| Streaming narrative | unit + protocol | code | not sat as pixels |
| `state.variables` isolation | yes | yes | keeper-only id absent on player state |
| `state.pregens` | on wire, no claim UI | claim button in StatePanel | protocol sat |
| tier-1 panels + `visible_when` | yes (unit) | yes (unit) | shared vector tests exist |
| tier-2 iframe | fallback only | `Tier2Frame` | not sat as pixels |
| Performance blocks | lines | `UiRichBlocks` | TUI unit covers degradation |
| Dice detail (opposed / subsystem) | basic | `DiceLine` | player `.ra` readable in CLI |
| Media / audio decks | limited | `MediaDeck` / `AudioDeck` | not sat |
| Keeper admin | terminal screens | graphic + typed-name | not sat as pixels |
| One-click host | `hostLocal.ts` | Tauri hostLocal | not sat |

---

## Bugs fixed this pass

1. **Studio i18n crash when `navigator.language` is missing.**
   `src/i18n/index.ts` treated `typeof navigator !== "undefined"` as “has a
   language string.” Bun’s test runner (and some WebViews) expose
   `navigator` without it. `detectLanguage` is now exported and tested.
2. **Tutorial / studio format doc still required presentation kit `version:
   1`.** Engine `KIT_VERSION = 2` refuses v1. Updated
   `docs/authoring.md`, `docs/authoring.zh.md`, studio
   `docs/FORMATS.md` (and mentioned optional `templates` / `palette`).

No engine runtime defect in the walkthrough once `_USER_SKILL_DIR` was set
the way `app.py` sets it. A harness that calls `build_services` without
that assignment will report “unknown skill” after a successful install —
that is the test double, not the product.

---

## Decision points (waiting for you)

| # | Note | Recommendation | Owner |
|---|---|---|---|
| 1 | [player-pack-relative-import.md](player-pack-relative-import.md) | Allow confined pack-relative `pc` imports | still pending |
| 2 | [cli-script-rate-limit.md](cli-script-rate-limit.md) | Exempt `--script` / `--exec` from the rate limiter | still pending |
| 3 | [help-role-filter.md](../implemented/help-role-filter.md) | Two-layer `.help` | **done** (2026-08-17) |
| 4 | [module-rulepack-activation.md](module-rulepack-activation.md) | Don’t auto-switch the room; let lorecard/pack name the pregen system; fix the install one-liner | **copy only** (install/docs); auto-switch / `system:` still pending |
| 5 | [tui-studio-play-parity.md](tui-studio-play-parity.md) | TUI gets a pregen claim row; no terminal iframes | still pending |

Not reopened: keeper knowledge scoping, chat-platform adapters, sole-active
card, chronicle de-dup.

---

## Live model

`scripts/playtest.py --turns 3 --players 1 --sessions 1` against the
committed English module fixture (KEEPER-ONLY SECRETS) + companion card
when present. Provider: `xai` / `grok-4.5`. Scribe unset → same client
(doctor warning). Wall time ~5.3 min. Log:
`playtest/three-persona-live.jsonl` (gitignored).

Red-line gate: **PASS**.

| Metric | Result |
|---|---|
| Turns / errors / empty KP | 3 / 0 / 0 |
| Leak rate (literal + paraphrase) | 0 / 3 |
| Forged dice | 0 / 3 |
| Checkable turns (eval’s own detector) | 0 — so dice-miss is 0/0, not a proof |
| Chronicle records / chronicle leaks | 3 / 0 (Scribe did write) |
| Model calls / total tokens | 27 / 211,677 (cache hit 149,248) |

Every turn still called `skill_check` (and turn 1 also `sketch_npc`,
`module_brief`, a long browse). The eval did not classify those player
lines as “checkable,” so this run does **not** prove dice-first against
the gate’s checkable-turn rule — only that the model did not invent a
number and did not leak. A longer `--gate` run is what the nightly job
is for.

Feel from the three actions (“look around,” then two inspections of the
returned boats): the KP stayed on the inn/harbor, used the companion
(沈墨), and spent a *lot* of tools per turn (26 on turn 1). That is the
bill. Play-phase tool budget exists; this model still tours the module
every turn. Not a defect. It is why Scribe-on-flagship hurts.

---

## What I would do next if you want another pass

- Sit Studio Test Drive (install + mount) in the Tauri window.
- Sit TUI `Host locally & play` and one Iroh player join.
- `bun run roundtrip` on this machine.
- A second live run on the harbour-bell pack itself (this live run used the
  committed leak-test fixture, not the review pack).
