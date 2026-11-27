# loreweaver — the module SDK

A **module** is content code shipped in a pack: one TypeScript (or JavaScript) entry
file whose default export is `defineModule({...})`. It is how a pack adds rules the
Keeper cannot be trusted to keep by itself: a tracker, a clock, a combat round, a
private status panel, a command the players can type.

This package holds the contract a module is written against (`loreweaver/module`) and a
test host for running one under `bun test` (`loreweaver/testing`).

```ts
import { defineModule } from "loreweaver/module";

let alarm = 0;

export default defineModule({
  id: "alarm",
  create() { alarm = 0; },
  load(snapshot) { alarm = (snapshot as { alarm: number }).alarm; },
  save() { return { alarm }; },

  on: {
    turnStart(event, fx) {
      if (/shout|fire|run/i.test(event.text)) alarm += 1;
      fx.inject(`The manor's alarm level is ${alarm} of 5.`);
      if (alarm >= 5) fx.fact({ text: "The bells ring out across the manor." }, { narrateNow: true });
    },
  },

  views: {
    alarm: { title: "Alarm", schema: { type: "integer" }, for: () => alarm },
  },
});
```

A module needs no build step. Inside a room, the server answers the `loreweaver/module`
import itself, with the SDK it was built with. If your module uses npm packages, bundle
them into the entry file when you build the pack.

## How a module runs

Every module enabled in a room lives in that room's **worker thread**: one per room,
long-lived, so module-level variables persist from one call to the next. The worker
makes one call at a time. Modules of a room are called in the order they were enabled,
and that order is part of the contract.

**A module never calls the engine.** The engine notifies it (an event, a command, a
render) and it answers through the effects object `fx` it is handed. Effects are
*requests*: they are collected during the call, returned when it ends, and the engine
validates, caps and applies them. Nothing else a module does reaches the room.

A module may use the filesystem, the network and npm packages on its own; the engine
offers no interface for that and keeps no account of it. There is no security sandbox.
What the runtime does guarantee is **fault isolation**: one module's failure never costs
another module its call, and never costs the table its turn.

### State and checkpoints

| Function | When the engine calls it |
| --- | --- |
| `create()` | A fresh room: build the initial state. |
| `load(snapshot)` | Restore from a value `save` returned earlier. |
| `save()` | After every successful **mutating** call; also right after `create`. |

The value `save()` returns, passed through `JSON.stringify` and back, becomes the
module's **checkpoint**. It is stored with the room. Every rollback, every restore after
a read-only call and every restart `load`s the checkpoint, so:

- **`save` must hand over everything that matters.** What it leaves out is lost at the
  next restart. Values JSON cannot hold are changed the way `JSON.stringify` changes
  them (a `Date` becomes a string, `undefined` fields vanish, `NaN` becomes `null`); a
  `BigInt` or a cycle makes `save` throw, which fails the call.
- **`load` must set every piece of state**, not only some: after a rollback, anything it
  does not assign keeps whatever the failed call left in it.
- **A module without `save` keeps no state between calls.** Its checkpoint never exists,
  so every restore runs `create()` again.

### The rules of atomicity

1. **The call is the unit of atomicity.** A mutating call that succeeds has its effects
   applied and its `save()` kept. A call that throws loses its effects *and* the module
   is `load`-ed back from its last checkpoint: memory and the room cannot disagree.
2. **Read-only calls leave no trace.** `on.toolUse`, every command's `available`, every
   view's `for`, `characters` and `clock` are read-only. After each of them the module is
   restored from its last checkpoint, whatever the handler did, and no checkpoint is
   taken. Do not count, cache or learn anything in them: it is thrown away.
3. **A call that never returns ends the whole worker.** Each call has a time limit. Past
   it, the engine terminates the room's thread; the next call starts a new worker and
   loads every module from its checkpoint. Calls queued behind the hung one are not lost.
4. **A restore that itself throws** (a broken `load`) leaves the module in an unknown
   state: it is skipped until the worker is restarted from the checkpoints.

Handlers may be `async`; the call ends when the returned promise settles. `fx` belongs to
its call: an effect used after the call has ended (from a timer, a stray promise) is
dropped.

## Who

Who plays whom is engine data. Every call that concerns a person carries a `Who`:

```ts
interface Who {
  member: { id: string; name: string; role: "player" | "admin" | "observer" } | null;
  character: { id: string; name: string } | null;
}
```

`member` is null when the call concerns nobody in particular (the Keeper, the engine). A
member with no `character` is a spectator. A module never keeps its own seating: it
lists the characters that can be played (`characters()`), and the engine maps members to
them.

## The room snapshot

A module cannot ask the engine anything, so every call brings the room with it:

```ts
interface RoomSnapshot {
  turn: number;                 // the current turn, from 1
  variables: JsonObject;        // the room's variables
  clock: ClockReading | null;   // the room's clock, or null when it keeps none
}
```

It is the room as it is when the call starts. Every event *is* a snapshot (`turn`,
`variables` and `clock` are fields of all three events), and every other handler gets
one as its **last** parameter: `available(who, room)`, `for(who, room)`,
`characters(room)`, `clock(room)` — and a command's `run(args, who, fx, room, call)`, where
only `call` (who is running it, see [Commands](#commands)) comes after it. A handler that
does not need it simply leaves the parameter out.

The snapshot is a **copy, made for each module and each call**: writing to it changes
nothing, neither the room nor what the next module sees. To change a variable, ask with
`fx.setVar`. The engine does not send a variables snapshot larger than 1 MB; a room past
that sends `{}` and tells the operator.

## The contract

```ts
defineModule({
  id: "taixu",                          // [a-z][a-z0-9_]*, at most 64 characters
  create() {},
  load(snapshot) {},
  save() { return snapshot; },

  characters(room) { return [{ id, name, blurb?, resources?: [{ id, label, value, max? }] }]; },
  clock(room) { return { time: "Day 3, dusk", round?: 2 }; },

  on: {
    turnStart(event, fx) {},
    toolUse(event, fx) {},
    replyPhase(event, fx) {},
  },

  commands: { attack: { title, description?, params?, text?, role?, available?(who, room), run(args, who, fx, room, call) } },
  views: { status: { title?, schema, for(who, room) } },
});
```

Every part is optional except `id`. Module ids, command names and view names must match
`^[a-z][a-z0-9_]{0,63}$` and must not be a name every JavaScript object already has
(`constructor`): such a command or view is left out at load and reported.

### Events

**`turnStart(event, fx)`** — mutating. A turn begins.

| Field | |
| --- | --- |
| `turn` | The turn number, from 1. |
| `seed` | Derived from persisted inputs only: the same room state replays the same seed. |
| `text` | What was said. |
| `who` | Who said it. |
| `variables` | The room's variables when the turn started (a copy, see above). |
| `clock` | The room's clock reading, or null. When a module claims the clock, this is its `clock()`, read at the start of this same call. |

This is the only place `fx.inject` works: it adds a section to *this* turn's Keeper
prompt.

**`toolUse(event, fx)`** — read-only. The Keeper is about to use tools. `event.calls` is
every tool call of this round, in call order (`{ id, name, args }`), with the room's
`turn`, `variables` and `clock` alongside; refuse one with
`fx.deny(call.id, reason)`. Several modules may deny the same call; a call no module
denies goes ahead. Only `fx.deny` and `fx.log` work here.

**`replyPhase(event, fx)`** — mutating. The Keeper has replied. Fields: `turn`, `seed`,
`variables`, `clock`, `reply` (the published text), `rolls` (dice rolled during the turn), `clockAdvances`
(`{ amount, reason? }`), `variableWrites` (`{ path, value, by }`, where `by` is `keeper`
or a module id), `who`.

Each module gets its own copy of the event: changing it tells the next module nothing.
The variables are as they were when the exchange started: writes requested earlier in
the same exchange (by `fx.setVar`) are not in them yet.

### Commands

```ts
commands: {
  attack: {
    title: "Attack",
    description: "Strike someone within reach.",
    params: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    text: ["attack {target}"],
    role: "player",
    available(who, room) { return who.character ? true : "Take a seat at the table first."; },
    run(args, who, fx, room) {
      const roll = fx.roll("1d20+3", "attack");
      fx.fact({ text: `${who.character?.name} attacks ${String(args.target)}: ${roll.total}` });
      return { text: roll.total >= 12 ? "A hit." : "A miss." };
    },
  },
},
```

- `params` is a JSON Schema object schema for the arguments (default `{ type: "object" }`).
- `text` lists text forms the engine's parser can match; it is data, nothing more.
- `role`: who may run it. The engine checks it before your code runs.
  - `player` (default): players and admins, and the Keeper.
  - `admin`: admins only. The Keeper never runs it, whoever is speaking: admin commands
    (resets, settings) are the human admin's.
  - `keeper`: the Keeper's. It is Keeper machinery: never listed in a player's
    `commands` view, and a player who names it anyway is refused as having the wrong role.
    The Keeper sees it in its list of the room's commands and runs it with its
    `run_command` tool. A room's **admin** may run it too (and sees it among their
    commands): that is how a person repairs what the Keeper got wrong — a clock advanced
    too far, a reveal triggered early. Then `call.by` is `"member"` and `who` is the admin.

  Observers use no command.
- `available(who, room)` (read-only) narrows it further: `true`, or a reason shown to that
  member. It is asked from a member's point of view: when the engine renders what each
  member can do, and again at the moment of use (when the Keeper runs the command, `who`
  is the member whose turn it is).
- `run(args, who, fx, room, call)` is mutating. `call.by` is `"keeper"` when the Keeper runs
  it (its `run_command` tool, during a turn) and `"member"` when a member does (typed text,
  a panel, `command.run`). `who` is the member the action belongs to either way: when the
  Keeper runs it, the member who spoke this turn, or `member: null` when nobody did. What
  `run` returns (`{ text?, data? }`) answers whoever ran it and nobody else: the member, or
  the Keeper as its tool result. To tell the table, use `fx.fact`. Effects are applied the
  same way whoever ran the command.

Commands are addressed as `<module id>/<command name>`.

A command that only the Keeper should run — a clock it advances, a reveal it triggers —
declares `role: "keeper"`. A command both may run can say more to the Keeper than to a
player by branching on `call.by`: its answer goes only to whoever ran it.

```ts
commands: {
  advance: {
    title: "Advance the clock",
    role: "keeper",                       // players never see or run it
    params: { type: "object", properties: { hours: { type: "integer" } } },
    run(args, _who, fx) {
      hours += typeof args.hours === "number" ? args.hours : 1;
      fx.fact({ text: `${hours} hours have passed.` });
      return { text: hours >= 6 ? "Six hours: the bell tolls now." : `${hours} hours.` };
    },
  },
  search: {
    title: "Search the room",
    run(_args, who, fx, _room, call) {
      fx.fact({ text: `${who.character?.name ?? "Someone"} searches the room.` });
      return call.by === "keeper"
        ? { text: "Nothing found. (The letter is behind the mirror; it turns up on a second search.)" }
        : { text: "You find nothing." };
    },
  },
},
```

### Views

```ts
views: {
  sheet: {
    title: "Your sheet",
    schema: { type: "object" },
    for(who, room) { return who.character ? sheets[who.character.id] ?? null : null; },
  },
},
```

`for(who, room)` is read-only and computed **per viewer**: it is how private information
reaches one member. Return what that viewer may see and nothing more.

### Characters and the clock

`characters(room)` (read-only) lists the characters members can be seated as, with optional
resources (`{ id, label, value, max? }`) for the client to show.

`clock(room)` (read-only) returns the room's current time (`room.clock` is the last
reading the engine has). Defining it **claims the room's
clock**: only one module of a room may, and two claims fail the room's load, naming both
modules.

## Effects

| Effect | `turnStart` | `toolUse` | `replyPhase` | `run` |
| --- | :-: | :-: | :-: | :-: |
| `fx.fact(fact, options?)` | yes | | yes | yes |
| `fx.inject(text)` | yes | | | |
| `fx.setVar(path, value)` | yes | | yes | yes |
| `fx.blocks(blocks, options?)` | yes | | yes | yes |
| `fx.roll(notation, label?)` | yes | | yes | yes |
| `fx.deny(callId, reason)` | | yes | | |
| `fx.log(text)` | yes | yes | yes | yes |

The types of each handler's `fx` only offer what works there. An effect used where it
does not belong anyway (from JavaScript, or through a cast) does not throw: it is dropped
and reported to the operator.

- **`fx.fact({ text?, data? }, { to?, importance?, narrateNow? })`** — the narration feed.
  `to: "table"` (default): a fact with `text` is shown to everyone as mechanical output.
  `to: "keeper"`: it reaches only the Keeper's prompt. `importance` is `low`, `normal`
  (default) or `high`. `narrateNow: true` asks the engine to open a Keeper turn over the
  pending facts. There are no facts for one member: private information goes in a view.
- **`fx.inject(text)`** — a section for this turn's Keeper prompt.
- **`fx.setVar(path, value)`** — a request to write a room variable.
- **`fx.blocks(blocks, { id? })`** — declarative blocks set into the story; a later
  emission with the same `id` replaces this one.
- **`fx.roll(notation, label?)`** — rolls the **engine's dice** now and returns
  `{ notation, label?, total, text }` at once; the roll is also recorded, so the table sees
  real dice. The randomness derives from the call's seed, the module id and how many
  rolls the module has made in this call, so a replayed call rolls the same faces and a
  sibling module's rolls never shift yours. Bad notation throws.
- **`fx.deny(callId, reason)`** — refuse one tool call of the round.
- **`fx.log(text)`** — a line for the operator's log, never shown at the table.

### Limits

The engine drops (never shortens) whatever is over these limits and reports it to the
operator. Characters are Unicode code points; sizes are bytes of the JSON text. Counts
are per module per call unless noted.

| | Limit |
| --- | --- |
| Injections | 8 per turn (all modules together), 4,000 characters each |
| Facts | 32; text 2,000 characters; data 16 KB |
| Variable writes | 32; path 200 characters; value 16 KB |
| Block emissions | 8; 64 KB each |
| Dice rolls | 16 (a roll over the limit is not shown at the table, though your code saw it) |
| Log lines | 32; 2,000 characters each |
| Denial reasons | 500 characters |
| Command result | text 4,000 characters; data 256 KB |
| Command arguments | 64 KB |
| A view's data | 512 KB |
| Commands / views per module | 64 / 32 |
| Titles / descriptions | 200 / 2,000 characters; text forms 16 of 200 characters; schemas 64 KB |
| Characters | 64 per module; id and name 200 characters; blurb 2,000; 16 resources each |
| Clock reading | `time` 200 characters |
| Variables snapshot sent to modules | 1 MB (larger: `{}` is sent instead) |

## Testing a module

`loreweaver/testing` runs a module in-process through the same runner a room's worker
uses: same checkpoints, same rollbacks, same restores after read-only calls.

```ts
import { expect, test } from "bun:test";
import { createTestHost, who } from "loreweaver/testing";

import alarm from "./alarm.ts";

test("shouting raises the alarm, and the alarm survives a restart", async () => {
  let generation = 0;
  const host = createTestHost(alarm, {
    fresh: async () => (await import(`./alarm.ts?fresh=${++generation}`)).default,
  });

  const turn = await host.turnStart({ text: "I shout for help!" });
  expect(turn.injected).toEqual(["The manor's alarm level is 1 of 5."]);
  expect(host.checkpoint).toEqual({ alarm: 1 });

  await host.restart();
  expect(await host.view("alarm", who("Ada"))).toBe(1);
});
```

`createTestHost(definition, options?)`:

| Option | |
| --- | --- |
| `dice` | A list of totals handed out in order (`[17, 4]`; `text` is `"<notation> = <total>"`), or a function `(notation, seed) => ({ total, text })`. Without it, a module that rolls fails its call. |
| `snapshot` | Start from this checkpoint (as `load`) instead of `create`. |
| `who` | Who calls are made as when a call names nobody (default: a player with no character). |
| `seed` | Prefix of the seeds the host derives (default `test`). |
| `variables`, `clock` | The room snapshot for calls that set none (default `{}` and null). |
| `fresh` | Returns a new instance of the module, for `restart()`. Import the entry file with a changing query string, as above: without it `restart()` reuses the same object, and state that `load` forgets to assign would wrongly survive. |

The host:

| | |
| --- | --- |
| `turnStart({ text, who?, turn?, seed?, variables?, clock? })` | Fires the event. `turn` defaults to one past the last. |
| `toolUse(calls, who?, room?)` | `calls` are `{ id?, name, args? }`; returns `verdicts` in call order: `true` or the first denial's reason. |
| `replyPhase({ reply, who?, turn?, seed?, variables?, clock?, rolls?, clockAdvances?, variableWrites? })` | Fires the event. |
| `command(name, args?, who?, room?)` | Runs a command as the member `who` (`call.by` is `"member"`) with the engine's role and `available` checks; `outcome` is `{ status: "ok", result }`, `{ status: "refused", reason: "unknown" \| "role" }`, `{ status: "refused", reason: "unavailable", text }` or `{ status: "failed", error }`. |
| `view(name, who?, room?)` | The view's data for `who`; throws if it failed. |
| `keeperCommand(name, args?, who?, room?)` | Runs a command as the Keeper does (`call.by` is `"keeper"`; `who` is the member whose turn it is), with the same checks: `player` and `keeper` commands run, `admin` ones are refused with `reason: "role"`. |
| `available(name, who?, room?)` | For the member `who`: `"role"` when the role forbids it (a `keeper` command: for everyone but an admin), else what `available` answers. |
| `characters(room?)`, `clock(room?)` | The read-only answers. |
| `checkpoint` | The current checkpoint: what a restart would load. |
| `description` | The static description the engine reads at load. |
| `restart()` | A new instance, `load`-ed from the checkpoint. |

Every call returns what it did: `effects` (in order; empty when the call failed),
`refused` (effects dropped as misplaced or malformed), `error` (when it threw),
`checkpoint` (after the call), and shortcuts `injected`, `facts`, `writes`, `blocks`,
`rolls`, `logs`. `who(name, { id?, role?, character? })` builds a `Who`.

`room` is `{ turn?, variables?, clock? }`: what you leave out comes from the options, and
`turn` from the last turn started (1 before any).

The test host does not apply effects and does not enforce the engine's limits above;
check them in your own tests if you come near them.
