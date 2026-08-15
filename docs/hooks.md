*English · [中文](hooks.zh.md)*

# Writing `hooks.js` — the event-hook author reference

Event hooks let a skill or a card ship **behavior**: JavaScript handlers on the turn
lifecycle, run in the same QuickJS sandbox as full EJS. A hook can read the room's
variables, add a section to this turn's Keeper prompt, append or rewrite narration,
and draw declarative UI in the connected clients. This page is the author reference —
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
is not `false` (one switch governs every sandboxed-JS surface).

## Where hooks live

- **In a skill:** a `hooks.js` file next to the skill's `SKILL.md`. It is active
  while the skill is enabled for the room — `.skill enable <id>` is the on/off
  switch, nothing new to learn.
- **In a card:** an `extensions.loreweaver_hooks` list of script strings. A card
  carrying hooks is a **world card**: the scripts install when the Keeper imports
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
```

- **`turn_start`** — fires before the Keeper thinks, with the player's input. This
  is the only event where `inject()` is useful: the injected section joins **this**
  turn's Keeper prompt.
- **`reply_ready`** — the Keeper's narration is complete; `event.reply` is the text.
  The place for `narrate()` / `rewriteReply()`.
- **`dice_rolled`** — one or more dice tools resolved this turn.
- **`variables_changed`** — variable writes happened this turn. Fires **at most once
  per turn**, so a hook that writes variables in response cannot cascade forever —
  it stops because it cannot do otherwise, not because everyone agreed to be careful.
- **`clock_advanced`** — the Keeper moved the game clock forward this turn
  (`game_clock advance`); fires once per advance with the old face, the new face,
  and the verbatim delta text. The place for module-side calendars: day counters,
  deadline countdowns, scheduled omens.

Handlers may be `async`; rejections are caught and logged as warnings. A handler
that throws only loses its own effects — other handlers still run.

## Inside a handler

The full template bridge is available:

- **Variables:** `getvar(name)`, `setvar(name, value)`, `incvar(name, delta)`, plus
  the `variables` / `stat_data` tree views and lodash as `_`.
- **Write routing is validated:** a name that matches a module variable declared
  with `define_variable` goes through its kind/bounds check (a number with bounds
  stays inside them); any other name lands in the imported-card (MVU) variable tree. A
  failing write is skipped and reported, never fatal. At most **64 writes** apply
  per turn.
- **Snapshot semantics:** variables are snapshotted once per turn. A handler sees
  its **own** earlier writes — as REQUESTED, before validation (a `setvar` beyond a
  variable's bounds reads back unclamped in the sandbox; the store keeps the clamped
  value) — but not writes made mid-turn by Keeper tools or by the reply's own
  `<UpdateVariable>` protocol. In particular, inside a `variables_changed` handler
  `getvar(path)` does NOT return the new value for engine-applied writes; the event
  tells you WHAT changed and HOW (`{path, op}`), never the value. By the next turn
  everything is consistent again.
- **Trust tier:** hooks are module logic and see the **Keeper view** of the
  variables, including keeper-only trackers. What you choose to emit to players is
  authorial output — never put keeper-only material into `narrate` / `emitUI`.

Effect emitters:

| Emitter | Does | Per-turn caps |
|---|---|---|
| `inject(text)` | adds a section to this turn's Keeper prompt (`turn_start` only) | 8 × 4,000 chars |
| `narrate(text)` | appends to the player-visible reply | 8 × 2,000 chars |
| `rewriteReply(text)` | replaces the player-visible reply | 1 × 4,000 chars |
| `emitUI(blocks, opts?)` | draws declarative UI in clients (below) | 8 emissions |
| `log(text)` | writes a warning-level line to the server log | — |

## `emitUI` — declarative module UI

`emitUI(blocks, opts?)` sends validated UI blocks to clients as protocol-v1.7 `ui`
frames ([protocol.md](protocol.md) has the exact schema). Block kinds:

```js
{kind: "meter",   label, value, min, max}          // a bounded gauge
{kind: "stat",    label, value}                    // one labeled value
{kind: "badge",   label, tone?}                    // tone: "info" | "warn" | "danger"
{kind: "text",    text, style?}                    // style: "quote" | "warning"
{kind: "divider"}
{kind: "choices", prompt?, options: [{id, label, input}]}
```

Options (second argument): `panel: "inline" | "sidebar"` (default `"inline"` — into
the narrative stream; `"sidebar"` renders a persistent panel), `id` (names a UI
region — a later sidebar frame with the same `id` replaces that region), `replace:
true` (an inline frame may update the prior inline frame with the same `id` in
place).

Picking a `choices` option sends that option's `input` string back **as if the
player had typed it** — a normal input frame, no new protocol machinery.

UI frames are **not replayed on join**: a hook that wants a persistent panel simply
re-emits it every turn (cheap, idempotent with a stable `id`).

Caps: 8 emissions/turn × 16 blocks each; 12 options per `choices`; labels 120
chars, text 2,000, prompt 200, option input 200, `id` 64. A block that fails its
schema is dropped; the rest of the emission survives.

## Failure semantics (what happens when things go wrong)

- **At load:** the sandbox time limit is armed *before* your top-level code runs — a
  top-level infinite loop times out instead of hanging the server. A script that
  throws at load is skipped (logged); other scripts still load.
- **At dispatch:** a handler exception becomes a warning; a whole-dispatch failure
  (memory/time limit) returns an empty outcome. Either way the turn completes.
- **Environment:** missing `ejs` extra, `TRPG_ENABLE_FULL_EJS=false`, or no
  registered scripts → hooks are inert for the turn, logged, never fatal.
- **Sandbox:** one fresh interpreter per turn (no cross-turn or cross-room state),
  hard memory cap (64 MiB), per-eval time cap (1 s), zero host I/O.

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
