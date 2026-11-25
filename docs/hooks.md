*English · [中文](hooks.zh.md)*

# Writing `hooks.js` — the event-hook author reference

Event hooks let a skill or a card ship **behavior**: JavaScript handlers on the turn
lifecycle, run in the same QuickJS sandbox as full EJS. A hook can read the room's
variables, keep private state of its own across turns, give the Keeper deterministic
mechanics to call mid-turn (module actions), add a section to this turn's Keeper prompt,
append or rewrite narration, and draw declarative UI in the connected clients. This page is the author reference —
events, the API, the limits, and what happens when something fails. The architectural side lives in
[plugins.md](plugins.md) (Layer C.1).

Two facts frame everything else:

1. **Hooks request, the engine applies.** Every effect a handler emits goes into a
   buffer; deterministic engine code validates, caps, and applies it after the
   handler returns. Nothing a hook does bypasses the rules.
2. **Hooks can never break a turn.** A broken script, a thrown handler, an infinite
   loop, or a missing `ejs` extra degrades to "hooks inert (logged)" — the turn
   proceeds without you.

Requirements: the server has the `ejs` extra installed and `TRPG_ENABLE_FULL_EJS`
is not `false`. That switch governs hooks and full EJS only; rules scripts and prep
scripts are not affected by it.

## Where hooks live

- **In a skill:** a `hooks.js` file next to the skill's `SKILL.md`. It is active
  while the skill is enabled for the room — `.skill enable <id>` is the on/off
  switch, nothing new to learn.
- **In a card:** a native lorecard (`*.lorecard.json`, format v1) carries its scripts in
  the top-level `hooks` list (strings or `{code: "…"}` objects); an ST-shaped card
  uses an `extensions.loreweaver_hooks` list of script strings. A card
  carrying hooks is a **world card**: the scripts install when the room admin imports
  it with `.import <file> world` (a player's character import strips them — see
  [cards.md](cards.md)); **re-importing the card replaces its scripts** rather
  than stacking duplicates.

A room runs at most **16 scripts**, each at most **40,000 characters**; anything
beyond is skipped with a logged warning.

## Events

Register handlers with `on(event, handler)`:

```js
on("turn_start",        (event) => { ... });  // event.user_message, event.actor
on("reply_ready",       (event) => { ... });  // event.reply
on("dice_rolled",       (event) => { ... });  // event.rolls: [{tool, result}]
on("variables_changed", (event) => { ... });  // event.writes: [{path, op: "set"|"insert"|"delete"|"add"|"move"}]
on("clock_advanced",    (event) => { ... });  // event.from, event.to, event.delta
on("tool_use",          (event) => { ... });  // event.tool, event.arguments — may denyTool(reason)
```

- **`turn_start`** — fires before the Keeper thinks, with the player's input. This
  is the only event where `inject()` is useful: the injected section joins **this**
  turn's Keeper prompt.
- **`reply_ready`** — the Keeper's narration is complete; `event.reply` is the text.
  The place for `narrate()` / `rewriteReply()`.
- **`dice_rolled`** — one or more dice tools resolved this turn.
- **`variables_changed`** — variable writes happened this turn: hook writes, the reply's
  own `<UpdateVariable>` commands, and the Keeper's `set_variable` / `adjust_variable` /
  `set_stat` / `adjust_stat` tool calls alike. Fires **at most once
  per turn**, so a hook that writes variables in response cannot cascade forever —
  it stops because it cannot do otherwise, not because everyone agreed to be careful.
- **`clock_advanced`** — the Keeper moved the game clock forward this turn
  (`game_clock advance`); fires once per advance with the old face, the new face,
  and the verbatim delta text. The place for module-side calendars: day counters,
  deadline countdowns, scheduled omens.
- **`tool_use`** — fires BEFORE each Keeper tool call, with the tool's name and
  arguments. The one event whose handler can refuse: `denyTool(reason)` blocks the
  call and the reason is fed back to the model (e.g.
  `on("tool_use", (e) => { if (e.tool === "game_clock") denyTool("time is frozen in this scene"); })`).
  Read the field names exactly — a guard reading a field this event does not carry
  never fires, silently, and the door it was supposed to hold stands open.

Every event also carries **`event.seed`** — see [Seeds](#seeds--eventseed) below.

Handlers may be `async`; rejections are caught and logged as warnings. A handler
that throws only loses its own effects — other handlers still run. Handler errors and
`log(text)` lines are written to the server log at warning level, labelled with the room
and the event.

## Inside a handler

The full template bridge is available:

- **Variables:** `getvar(name)`, `setvar(name, value)`, `incvar(name, delta)`, plus
  the `variables` / `stat_data` tree views and lodash as `_`.
- **Write routing is validated:** a name that matches a module variable declared
  with `define_variable` goes through its kind/bounds check (a number with bounds
  stays inside them); any other name lands in the imported-card (MVU) variable tree. A
  failing write is skipped and reported, never fatal. At most **64 writes** apply
  per event dispatch.
- **Snapshot semantics:** variables are snapshotted when the turn's interpreter is
  built, and re-read from the store before every [module action](#module-actions--defineaction)
  (so an action sees the Keeper's mid-turn writes, and handlers after it in the same
  turn see the store as of that action). A handler sees its **own** earlier writes — as
  REQUESTED, before validation (a `setvar` beyond a variable's bounds reads back
  unclamped in the sandbox; the store keeps the clamped value) — but, unless an action
  refreshed the view in between, not writes made mid-turn by Keeper tools or by the
  reply's own `<UpdateVariable>` protocol. In particular, inside a `variables_changed`
  handler `getvar(path)` does NOT reliably return the new value for engine-applied
  writes; the event tells you WHAT changed and HOW (`{path, op}`), never the value. By
  the next turn everything is consistent again.
- **Trust tier:** hooks are module logic and see the **Keeper view** of the
  variables, including keeper-only trackers. What you choose to emit to players is
  authorial output — never put keeper-only material into `narrate` / `emitUI`.
- **Private state:** `getstate(key)` / `setstate(key, value)` — machinery state that is
  not a variable at all (see the next section).

Effect emitters:

| Emitter | Does | Caps (per event dispatch unless noted) |
|---|---|---|
| `inject(text)` | adds a section to this turn's Keeper prompt (`turn_start` only) | 8 × 4,000 chars |
| `narrate(text)` | appends to the player-visible reply | 8 × 2,000 chars |
| `rewriteReply(text)` | replaces the player-visible reply | 1 × 4,000 chars |
| `emitUI(blocks, opts?)` | draws declarative UI in clients (below) | 8 emissions |
| `emitPanel(panelId, payload)` | sends an opaque JSON payload to one module panel's own code (`panel_event` frame) | 20 per **turn**, 32 KiB each |
| `log(text)` | writes a warning-level line to the server log | — |

## Private state — `getstate` / `setstate`

A hook's JavaScript globals live for one turn (see Sandbox, below). Anything that has to
survive a turn is engine-owned state, and there are two kinds. Pick by **who reads it**:

- **A tracker the table or the Keeper should see → a variable** (`setvar`/`incvar`,
  declared with `define_variable` when you can). Variables reach the Keeper prompt,
  panels, conditions, `variables_changed` and the Scribe — that is their job.
- **Machinery state only your hooks read → `setstate`.** A ledger, a queue, a
  per-character table, a dice history, a state machine's internals. It is never
  rendered into the Keeper prompt, never sent on any player or admin wire frame, never
  a `variables_changed` write, never in a turn's hook-write list, invisible to the
  Scribe, and not resolvable by conditions, panel `$var` bindings or `getvar`.

```js
on("dice_rolled", (event) => {
  const ledger = getstate("crossing") ?? { hours: [] };   // a fresh copy, or undefined
  ledger.hours.push(event.rolls.length);
  setstate("crossing", ledger);                           // buffered; the engine persists it
});
```

- **API (hooks only — worldbook EJS templates do not get it):** `getstate(key)` returns
  a fresh copy of the stored value, or `undefined` when the key is absent. Mutating the
  copy changes nothing until you `setstate` it back. `setstate(key, value)` stores any
  JSON value (object, array, string, number, boolean) as it is at the moment of the
  call; `setstate(key, null)` or `setstate(key)` deletes the key. A value that is not
  JSON — a function, a cycle, `NaN`/`Infinity` anywhere inside — is refused on the spot
  and logged.
- **Same contract as `setvar`:** writes are buffered in the sandbox, and the engine
  validates, caps and persists them after the dispatch. A handler sees its own earlier
  `setstate` writes immediately. After each dispatch the sandbox is re-synced to what
  the engine actually stored, so a write the engine refused is visible only until the
  end of the dispatch that made it. Call it inside a handler: a `setstate` at the top
  level of a script belongs to no event and is dropped (logged).
- **Snapshot:** the sandbox's state view equals the persisted state at the start of
  each phase: it is read when the turn's interpreter is built, again at the start of the
  reply phases, and again before every module action. (Hooks are the store's only
  writer, but a companion's nested turn runs the room's hooks on an interpreter of its
  own, so the store — not the snapshot — is the truth.) Every event of the turn — `turn_start`, `dice_rolled`, `clock_advanced`,
  `reply_ready`, `variables_changed` — persists its writes. **`tool_use` does not:** only
  its `denyTool` is honoured, so its `setstate` writes are dropped (logged) and the
  sandbox view rolls back, consistent with variable writes there, which are not applied
  either.
- **Caps:** key 1–64 characters of `A–Z a–z 0–9 _ . : -`, and not `__proto__`,
  `constructor` or `prototype`; each value ≤ 256 KiB (UTF-8
  bytes of its compact JSON); ≤ 32 keys and ≤ 1 MiB in total per room; ≤ 32 `setstate`
  writes per event dispatch. A write that breaks a cap is skipped and logged as a hook
  warning — never fatal, and the other writes still land. A stored value that has been
  corrupted reads as absent.
- **Lifetime:** it is room state, so `.undo` rewinds it with the turn, a room export
  carries it, and `.reset all` clears it (the same scope that clears the module's
  variables; `.reset story` and `.reset chars` keep it, as they keep the variables). A
  dev-room (`.dev mount`) reload keeps it.

## Module actions — `defineAction`

Events fire around the Keeper; a **module action** is a mechanic the Keeper calls. The
reply-phase events (`dice_rolled`, `reply_ready`, …) run after the narration is final, so
a hook that books an hour of a march there books it too late: the Keeper has already
narrated a number of its own. An action answers inside the turn — its return value is the
tool result the Keeper reads in its next round.

```js
defineAction("book_hour", {
  description: "Book one march hour of the crossing and return the booked line",
  params: '{pace: "fast"|"slow"}',
  rolls: { march: "8d10" },                    // rolled by the engine before the handler runs
}, (args, event) => {
  const ledger = getstate("crossing") ?? { crossed: 0, hours: 0 };
  const faces = event.rolls.march.dice;        // event.rolls.march = {expr, total, dice}
  const successes = faces.filter((d) => d >= (args.pace === "fast" ? 7 : 6)).length;
  const gain = successes * (args.pace === "fast" ? 30 : 25);
  ledger.crossed += gain;
  ledger.hours += 1;
  setstate("crossing", ledger);                // machinery: hooks only
  setvar("crossed_count", ledger.crossed);     // the tracker the table sees
  emitUI([{ kind: "meter", label: "Crossed", value: ledger.crossed, min: 0, max: 800 }],
         { panel: "sidebar", id: "crossing" });
  return `Hour ${ledger.hours} (${args.pace}): ${successes} successes, +${gain}; ${ledger.crossed} of 800 across.`;
});
```

The Keeper sees one tool, `module_action(action, args)`, whose description lists every
action as `name — description [params]` in registration order; `action` is an enum of the
names. With 325 already across, `module_action({action: "book_hour", args: {pace: "slow"}})`
rolling faces `[10, 8, 6, 4, 6, 2, 4, 10]` returns
`"Hour 4 (slow): 5 successes, +125; 450 of 800 across."` — and the Keeper narrates **that**.

- **Registration:** `defineAction(name, spec, handler)` in any hook script. `name` is
  `[a-z][a-z0-9_]{0,31}`. `spec.description` is required (≤ 200 chars); `spec.params` is
  an optional free-text hint of the args shape (≤ 400 chars); `spec.rolls` optionally maps
  up to 8 identifier slots to dice expressions. Unknown spec keys are ignored. A bad
  registration is dropped with a load warning; for a duplicate name the first valid
  registration wins; at most **24** actions per room.
- **The handler** receives `args` (the model's JSON object, ≤ 8 KiB) and `event` —
  `{actor, seed, rolls}`, where `rolls` is `{slot: {expr, total, dice}}` rolled by the real
  dice engine (the table sees a dice frame; an action without `rolls` emits none). It may
  be `async`. Return a string (used as is), anything else JSON (compact-stringified), or
  nothing (the Keeper gets a short "done" line). Results are cut at 4,000 characters with a
  visible marker.
- **Effects** apply immediately, through the same paths as events: `setvar` (validated,
  and counted as this turn's hook writes — `variables_changed` reports them and the
  Scribe leaves them alone), `setstate`, `emitUI`, `emitPanel` (the per-turn caps hold).
  `inject`, `narrate`, `rewriteReply` and `denyTool` are ignored inside an action (logged):
  the result is the action's voice.
- **Fresh views:** before each call the engine re-reads the variables and the private
  state from the store, so an action sees the Keeper's mid-turn writes and every earlier
  action's.
- **Failure applies nothing.** A handler that throws, times out (1 s), never settles or
  returns something that is not JSON produces a failure line for the Keeper with the error
  text; none of its effects apply and the sandbox views roll back. The turn goes on.
- **Guards:** a `tool_use` handler sees `module_action` calls like any other tool call
  (`e.arguments.action`, `e.arguments.args`) and can `denyTool` them. At most **16**
  action calls per Keeper turn; past that the tool tells the Keeper to narrate with what
  it has. Calls never run concurrently.
- **When the tool exists:** only in a turn whose hooks registered at least one action;
  hooks off (`TRPG_ENABLE_FULL_EJS=false`) means no tool. Offered in both prep and play.
  Action dice do not fire `dice_rolled` — the action already handled them.

## Seeds — `event.seed`

Every dispatch — the six events and every action call — carries `event.seed`, a
non-negative integer below 2^53 derived from the room, the turn in flight and the
dispatch's position in the turn. Nothing new is stored: the same room state derives the
same seeds, so a `.undo` and a retry of the turn replays them. That is intended — it makes
a hook's randomness replayable. `Math.random()` is not replayable; when a hook needs
randomness of its own, seed a small PRNG from `event.seed`:

```js
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
on("turn_start", (event) => { const rand = mulberry32(event.seed); /* … */ });
```

Dice that matter to the table belong to the dice engine (`spec.rolls`), not to a PRNG. The
Scribe's `tool_use` checks run on an interpreter of their own with their own seed stream,
so a `tool_use` seed there differs from the turn's.

## `emitUI` — declarative module UI

`emitUI(blocks, opts?)` sends validated UI blocks to clients as `ui`
frames ([protocol.md](protocol.md) has the exact schema). Block kinds:

```js
{kind: "meter",   label, value, min, max}          // a bounded gauge
{kind: "stat",    label, value}                    // one labeled value
{kind: "badge",   label, tone?}                    // tone: "info" | "warn" | "danger"
{kind: "text",    text, style?}                    // style: "quote" | "warning"
{kind: "divider"}
{kind: "choices", prompt?, options: [{id, label, input}]}
{kind: "image",   hash, mime?, caption?, alt?}     // a picture by sha256 content hash (64 hex)
// the four presentation templates:
{kind: "letter",     body, from?, to?, date?}
{kind: "clipping",   headline, body, source?, date?}
{kind: "map_pin",    label, hash, x, y, note?}     // x, y: 0..1 fractions of the map image
{kind: "title_card", title, subtitle?, act?}
```

`image` and `map_pin` name their picture by content hash, and the hash must be reachable
in the room's media or the block is dropped before it reaches the wire. A block missing a
required field is dropped; a bad optional field is stripped and the block kept.

Options (second argument): `panel: "inline" | "sidebar"` (default `"inline"` — into
the narrative stream; `"sidebar"` renders a persistent panel), `id` (names a UI
region — a later sidebar frame with the same `id` replaces that region), `replace:
true` (an inline frame may update the prior inline frame with the same `id` in
place).

Picking a `choices` option sends that option's `input` string back **as if the
player had typed it** — a normal input frame, no new protocol machinery.

UI frames are **not replayed on join**: a hook that wants a persistent panel simply
re-emits it every turn (cheap, idempotent with a stable `id`).

Caps: 8 emissions per event dispatch × 16 blocks each; 12 options per `choices`; labels 120
chars, text 2,000, prompt 200, option input 200, `id` 64. A block that fails its
schema is dropped; the rest of the emission survives.

## Failure semantics (what happens when things go wrong)

- **At load:** the sandbox time limit is armed *before* your top-level code runs — a
  top-level infinite loop times out instead of hanging the server. A script that
  throws at load is skipped (logged); other scripts still load.
- **At dispatch:** a handler exception becomes a warning (written to the server log); a
  whole-dispatch failure (memory/time limit) returns an empty outcome. Either way the
  turn completes. A failed module action applies nothing and tells the Keeper it failed.
- **Environment:** missing `ejs` extra, `TRPG_ENABLE_FULL_EJS=false`, or no
  registered scripts → hooks are inert for the turn, logged, never fatal.
- **Sandbox:** one fresh interpreter per turn (no cross-turn or cross-room state),
  hard memory cap (64 MiB), per-eval time cap (1 s), zero host I/O. A counter kept in
  a JavaScript global therefore resets every turn, silently: keep it in a variable
  (`incvar`) if the table should see it, in `setstate` if only your hooks read it.
- **State writes:** a failed dispatch loses its `setstate` writes along with its other
  effects, and the sandbox view goes back to what is stored; a store failure while
  persisting them is logged and the turn continues.

## A worked example

A fear meter for a horror module: it rises on every roll, shows in the sidebar, and
past a threshold it starts leaning on the Keeper. Declare the tracker in the module
setup (`define_variable`: kind `number`, 0–10, player-visible) so writes are
kept in range by the engine; the hook is then:

```js
on("dice_rolled", (event) => {
  incvar("fear", event.rolls.length);
  emitUI(
    [{ kind: "meter", label: "Fear", value: getvar("fear"), min: 0, max: 10 }],
    { panel: "sidebar", id: "fear-hud" }
  );
});

on("turn_start", () => {
  if (getvar("fear") >= 8) {
    inject("The town is past reason: doors bolt at dusk, and nobody answers a knock.");
  }
});
```

Every step here goes through the engine: `incvar` is held to 0–10 by the
tracker's bounds, the meter is schema-validated before any client sees it, and if
the script ever breaks, the module keeps running — just without its fear meter.
