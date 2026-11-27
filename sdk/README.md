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
| `create(init)` | A fresh room: build the initial state. |
| `load(snapshot, init)` | Restore from a value `save` returned earlier. |
| `save()` | After every successful **mutating** call; also right after `create`. |

Both `create` and `load` are given `init: { options, seed }`, the same at every load of
one life of the room:

- `options` is the module entry's `options` in the pack's `pack.yaml` (a JSON object of at
  most 16 KiB; `{}` when the manifest gives none): one module, configured per pack.
- `seed` is derived from the room, its generation and the module id. It stays the same
  through every restart and restore of this life of the room, and is a different one after
  a reset (or an undo, or an import) starts a new generation — so a module that builds a
  world from it in `create` builds the same world on every load until then.

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
   view's `for`, `characters` and `clock` are read-only. After them the module is restored
   from its last checkpoint, whatever the handler did, and no checkpoint is taken: after
   each of them, except that the views read for **one viewer** in one render share one
   restore, made after that viewer's last view. A view that changes state can therefore
   colour the same viewer's next views in that render — never another viewer's, and
   nothing survives the render. Do not count, cache or learn anything in them: it is
   thrown away. The engine checks once per render (one `save()` after the first viewer's
   views, compared with the checkpoint) and tells the operator, once, when reading changed
   the state (`read_changed_state`).
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
member with no `character` is a spectator. Seating is the engine's: a module never keeps
seats of its own. It may ask for one — seat a member on one of its own characters, or stand
them up — with `fx.seat` (see [Characters and seats](#characters-and-seats)), and reads the
result here on its next call.

`character.id` is the id the engine knows the character by — except for one of **this**
module's own characters, which comes as the module's own id for it (`"ana"`). A character
of another module comes namespaced as `<module>:<id>` (`"colony:ana"`); an engine
character's id never has that shape.

## The room snapshot

A module cannot ask the engine anything, so every call brings the room with it:

```ts
interface RoomSnapshot {
  turn: number;                 // the current turn, from 1
  variables: JsonObject;        // the room's variables
  clock: ClockReading | null;   // the room's clock, or null when it keeps none
  members: { id: string; name: string; role: "player" | "admin" | "observer" }[];
}
```

`members` is every member of the room — one per access key of the room, whether or not
its holder is connected — sorted by member id, so the same keys always give the same list.
It carries at most 256; a room with more sends the first 256 and tells the operator.

It is the room as it is when the call starts. Every event *is* a snapshot (`turn`,
`variables` and `clock` are fields of all three events), and every other handler gets
one as its **last** parameter: `available(who, room)`, `for(who, room)`,
`characters(room)`, `clock(room)` — and a command's `run(args, who, fx, room, call)`, where
only `call` (who is running it and the call's seed, see [Commands](#commands)) comes after it. A handler that
does not need it simply leaves the parameter out.

The snapshot is a **copy, made for each module and each call**: writing to it changes
nothing, neither the room nor what the next module sees. To change a variable, ask with
`fx.setVar`. The engine does not send a variables snapshot larger than 1 MB; a room past
that sends `{}` and tells the operator.

## The contract

```ts
defineModule({
  id: "taixu",                          // [a-z][a-z0-9_]*, at most 64 characters
  create(init) {},                      // init: { options, seed }
  load(snapshot, init) {},
  save() { return snapshot; },

  characters(room) { return [{ id, name, blurb?, resources?: [{ id, label, value, max? }] }]; },
  clock(room) { return { time: "Day 3, dusk", round?: 2 }; },

  on: {
    turnStart(event, fx) {},
    toolUse(event, fx) {},
    replyPhase(event, fx) {},
  },

  commands: { attack: { title, description?, params?, text?, role?, keeper?, danger?, available?(who, room), run(args, who, fx, room, call) /* → { text?, data?, more? } */ } },
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
  The engine checks the arguments against it **before** your code runs, whoever runs the
  command (see [Arguments](#arguments)); arguments that do not fit never reach `run`.
- `text` lists the command's text forms: what a member types to run it (see
  [Text forms](#text-forms)).
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
- `keeper: false` marks a member's own verb — an action a player takes for their own
  character, which the Keeper must not take for them. The Keeper never runs it: it is left
  out of the command list in the Keeper's prompt, and its `lookup_command` and
  `run_command` tools describe and refuse it as they do an `admin` command. Members run it
  as its `role` allows. Default `true`; a `role: "keeper"` command cannot say `false` (it is
  left out at load and reported).
- `danger: true` marks a command that is destructive or hard to take back (it wipes a
  tracker, ends a scene). A client asks the person before running it, and a pack's own page
  cannot answer for them. It changes nothing about who may run the command.
- `available(who, room)` (read-only) narrows it further: `true`, or a reason shown to that
  member. It is asked **at the moment of use only** — never when views are rendered or a
  command list is shown — from the point of view of the member the action belongs to (when
  the Keeper runs the command, `who` is the member whose turn it is). The `commands` view
  lists every command a member's role allows as available.
- `run(args, who, fx, room, call)` is mutating. `call.by` is `"keeper"` when the Keeper runs
  it (its `run_command` tool, during a turn) and `"member"` when a member does (typed text,
  a panel, `command.run`). `call.seed` is derived from persisted inputs only, as an event's
  seed is: the same call replayed over the same room state gets the same seed (`fx.roll`
  already derives its dice from it). `who` is the member the action belongs to either way: when the
  Keeper runs it, the member who spoke this turn, or `member: null` when nobody did. What
  `run` returns (`{ text?, data?, more? }`) answers whoever ran it and nobody else: the member,
  or the Keeper as its tool result. To tell the table, use `fx.fact`. Effects are applied the
  same way whoever ran the command. `more: true` asks for another step ([A long action in
  steps](#a-long-action-in-steps)); `call.step` says which step this is (0 for the first).

Commands are addressed as `<module id>/<command name>`, and every command can be typed as
that id followed by a JSON object: `.duel/attack {"target": "Bo"}`.

#### Text forms

A text form is what a member types, after the `.` prefix (`。` and `/` work too). Its
grammar: words separated by single spaces.

- The **first word is the command word**: letters, digits and `_`, 1 to 32 characters, in
  any script (`攻击` is a word); never `/`. It is matched case-folded.
- Each later token is a **literal word** (matched case-folded), `{name}` — one
  whitespace-delimited word of the input — or, as the **last** token only, `{name...}` —
  the rest of the line, trimmed (left out of the arguments when empty). So a form such as
  `j {text...}` also matches the bare word `.j`, with no `text`: require the property in
  `params` if a bare word should be refused, or answer it in `run`.
- Every `name` must be a property of the command's `params`, used once.

A form that breaks a rule is left out at load and reported to the operator; the command
stays (and can still be run by its id). A captured word is converted by its property's
declared `type`: `integer` and `number` are parsed strictly (`3`, `-2`, `1.5`), `boolean`
takes `true` or `false`; anything else — or a word that does not parse — stays the text as
typed, and the arguments are then checked against `params` like any others.

```ts
params: {
  type: "object",
  properties: { target: { type: "string" }, times: { type: "integer" }, line: { type: "string" } },
},
text: ["attack {target}", "attack {target} {times}", "attack at {target}", "say {line...}"],
```

| Typed | Arguments |
| --- | --- |
| `.attack Bo` | `{ target: "Bo" }` |
| `.attack Bo 3` | `{ target: "Bo", times: 3 }` |
| `.ATTACK at Bo` | `{ target: "Bo" }` — `attack at {target}` and `attack {target} {times}` both fit; the form with more literal words wins |
| `.say Run,   now!` | `{ line: "Run,   now!" }` |
| `.say` | `{}` |
| `.attack Bo many` | refused: `invalid_arg` at `times` |
| `.attack` | refused: `usage`, with the forms of `attack` |

When several forms of one word fit a line, the one with the most literal words wins, then
the first declared. **The room's own words win**: a form whose command word is one of the
engine's command words or of the room's rule system is dropped, and so is a word that two
enabled modules both claim — dropped for both. For example, a form `check {target}` is dropped
when the pack is enabled, because `check` is an engine command word: the engine's and the
rule system's words always win. Each drop is told to the operator, and named in the admin's
answer when a pack is enabled. The `commands` view lists, for each module command, the
words that run it now and its forms as typed.

`host.text` of the test host reads and matches forms with the engine's own code, so your tests
can cover them ([Testing a module](#testing-a-module)); the host cannot know about words the
engine or other modules own, so these drops happen only in a room.

#### Arguments

Before `run` is called, the arguments are checked against `params` with a subset of JSON
Schema, applied recursively: `type` (`object`, `string`, `number`, `integer`, `boolean`,
`array`, `null`, or a list of them), `properties`, `required`, `additionalProperties: false`,
`enum`, `const`, `minimum`/`maximum`, `minLength`/`maxLength` (in characters, i.e. code
points), `minItems`/`maxItems` and `items`. Every other keyword is ignored. A misfit is
refused with the engine's own codes and the argument's path — `unknown_arg` (a name an
`additionalProperties: false` object does not list), `missing_arg`, `invalid_arg` — to a
member as for an engine command, to the Keeper as its tool result. A command without
`params` takes any JSON object. The test host runs the same check before it calls `run`
(`host.command`, `host.keeperCommand`, `host.text`).

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

#### A long action in steps

One call into a module must end within the call limit (5 seconds): past it, the worker is
ended and the call's effects are lost. A long action — a simulation that advances three
years — runs in **steps**: a result with `more: true` asks the engine to call `run` again.

```ts
advance: {
  title: "Advance the colony",
  params: { type: "object", properties: { years: { type: "integer" } }, required: ["years"] },
  run(args, _who, fx, _room, call) {
    year += 1;                                   // one year a step
    fx.fact({ text: `Year ${year}: the harvest is in.` });
    const done = call.step + 1 >= Number(args.years);
    return done ? { text: `Year ${year}.`, data: { year } } : { text: `Year ${year}.`, more: true };
  },
},
```

The engine then applies that call's effects and keeps its checkpoint as for any call, and
calls `run` again with the **same arguments** and the next `call.step` (0, then 1, 2, …),
until a result without `more`, 8 calls, or 20 seconds since the first call began — whichever
comes first.

- Each step is its own call: its own time limit, its own effect limits, its own checkpoint
  and its own `call.seed` (derived from the first call's seed and the step, so a replay is the
  same). `available` is asked before the first step only.
- A step that fails or times out loses only itself: the steps before it stand.
- The table gets every step's events as they happen. Module views are rendered once, after
  the last step.
- Whoever ran the command gets **one** answer: the last completed step's `text`, and as
  `data` — only for a command that asked for `more` — `{ steps, data, stopped? }`: how many
  steps ran, the last step's own `data` (or `null`), and when the loop was cut, why: `"steps"`
  (the step limit), `"time"` (the time limit) or `"failed"` (a step failed). The Keeper's
  `run_command` runs the same loop, as one tool call with one result.

Keep the state between steps in the module (it is checkpointed after each step), so a cut
loop can be picked up by running the command again.

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
reaches one member. Return what that viewer may see and nothing more. A view is computed
only for the viewers who asked for it (subscribed to it, or asked for it once); a module
none of whose views anyone asked for is not read for views at all. Listing a room's views
(their names, titles and schemas) reads nothing: it comes from the module's description.

### Characters and seats

`characters(room)` (read-only) lists the characters the module keeps itself — `{ id, name,
blurb?, resources?: [{ id, label, value, max? }] }` — a simulation's settlers, a duel's
fighters. The engine reads it at every render and keeps the last list beside the module's
views. It never writes a sheet for such a character: the character stays the module's, and
the engine records only who sits on it.

- Outside the module the character is `<module id>:<id>` (`colony:ana`), so a module never
  names an engine character and two modules never collide. The table's views show it: `me`
  and `party` with its name and the resources you gave (and the module's id), the
  `characters` view among what can be played.
- A member is seated on one by **the module**, never by the engine's roster: `pc claim` of a
  module's character is refused. The engine's sheet and check commands, and the Keeper's
  sheet tools, know there is no sheet for it.
- The list is the module's offer to the table: name, blurb and resources are table-grade.
  Put nothing secret in it.

```ts
characters() {
  return settlers.filter((s) => s.alive).map((s) => ({
    id: s.id, name: s.name, resources: [{ id: "hp", label: "HP", value: s.hp, max: 10 }],
  }));
},
commands: {
  join: {
    title: "Join the colony",
    params: { type: "object", properties: { settler: { type: "string" } }, required: ["settler"] },
    run(args, who, fx) {
      if (who.member) fx.seat(who.member.id, String(args.settler));   // the module's own id
      return { text: "Welcome." };
    },
  },
},
```

**`fx.seat(member, character | null)`** seats `member` (a member id of `room.members`) on one
of this module's characters, or with `null` stands them up from one of this module's
characters. It works wherever a module may write (`turnStart`, `replyPhase`, a command's
`run`; not `toolUse`) and is applied with the call's other effects, through the room's
journal: undoing the turn takes it back. The id is resolved against your `characters()` as it
reads **after** the call, so a character the call itself created can be seated at once. The
engine refuses a seat, tells the operator and changes nothing when the member is not a member
of the room (`not_member`), already plays a character that is not this module's — an engine
character is never displaced (`member_has_character`) — the character is not one you offer
now (`unknown_character`), or another member plays it (`character_taken`). Standing up a
member who holds none of your characters is no change at all.

Death and replacement are yours to say: unseat the dead settler's player, then seat them on
the new one. A seat on a character your list no longer offers stays, shown by its id, until
you unseat it. A member may also stand up by themselves (`pc release`): you see
`who.character === null` on your next call. `reset chars` clears every seat, and disabling the
pack releases the seats on its modules' characters.

### The clock

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
| `fx.seat(member, character)` | yes | | yes | yes |
| `fx.log(text)` | yes | yes | yes | yes |

The types of each handler's `fx` only offer what works there. An effect used where it
does not belong anyway (from JavaScript, or through a cast) does not throw: it is dropped
and reported to the operator.

- **`fx.fact({ text?, data? }, { to?, importance?, narrateNow? })`** — the narration feed.
  `to: "table"` (default): a fact with `text` is shown to everyone as mechanical output.
  `to: "keeper"`: it reaches only the Keeper's prompt. `importance` is `low`, `normal`
  (default) or `high`: the Keeper's prompt lists pending facts high first, then normal,
  then low (in arrival order within a level), and when the pending list is full (64) a new
  fact takes the place of the oldest pending fact of a strictly lower importance, or is
  dropped when there is none (the operator is told either way). `narrateNow: true` asks
  the engine to open a Keeper turn over the pending facts. There are no facts for one
  member: private information goes in a view; a module's output is for the whole table or
  for the Keeper only.
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
- **`fx.seat(member, character | null)`** — seat a member on one of this module's characters
  (its own id), or stand them up from one; see [Characters and seats](#characters-and-seats).
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
| Seat requests | 16 |
| Steps of one command (`more: true`) | 8 calls, and no further step 20 seconds after the first began |
| Log lines | 32; 2,000 characters each |
| Denial reasons | 500 characters |
| Command result | text 4,000 characters; data 256 KB |
| Command arguments | 64 KB |
| A view's data | 512 KB |
| Commands / views per module | 64 / 32 |
| Titles / descriptions | 200 / 2,000 characters; text forms 16 of 200 characters (a command word at most 32); schemas 64 KB |
| Characters | 64 per module; id and name 200 characters (an id with a space at either end is dropped: no seat could hold it); blurb 2,000; 16 resources each |
| Clock reading | `time` 200 characters |
| Variables snapshot sent to modules | 1 MB (larger: `{}` is sent instead) |
| Members sent to modules | 256 (more: the first 256) |
| Pending facts waiting for the Keeper | 64 (see `importance`) |
| A module's `options` in `pack.yaml` | 16 KiB as JSON text (more: the pack is refused) |

These limits are fixed: nothing adjusts them per server or per room.

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
| `seed` | Prefix of the seeds the host derives (default `test`); `init.seed` is `<seed>:<module id>`. |
| `options` | The module's `init.options`, as a manifest would give them (default `{}`). |
| `variables`, `clock`, `members` | The room snapshot for calls that set none (default `{}`, null and none). |
| `fresh` | Returns a new instance of the module, for `restart()`. Import the entry file with a changing query string, as above: without it `restart()` reuses the same object, and state that `load` forgets to assign would wrongly survive. |
| `now` | Milliseconds, for the time limit of a command that runs in steps (default `Date.now`): to test that limit, pass a clock you move yourself. |

The host:

| | |
| --- | --- |
| `turnStart({ text, who?, turn?, seed?, variables?, clock? })` | Fires the event. `turn` defaults to one past the last. |
| `toolUse(calls, who?, room?)` | `calls` are `{ id?, name, args? }`; returns `verdicts` in call order: `true` or the first denial's reason. |
| `replyPhase({ reply, who?, turn?, seed?, variables?, clock?, rolls?, clockAdvances?, variableWrites? })` | Fires the event. |
| `command(name, args?, who?, room?)` | Runs a command as the member `who` (`call.by` is `"member"`) with the engine's role, argument and `available` checks, and its further steps while it answers `more: true`, as the engine does; `outcome` is `{ status: "ok", result }` (`result` as its caller is answered: for a stepped command the last step's `text` and `data: { steps, data, stopped? }`), `{ status: "refused", reason: "unknown" \| "role" }`, `{ status: "refused", reason: "args", code, path }` (the arguments do not fit `params`: `code` is `unknown_arg`, `missing_arg` or `invalid_arg`, as a member is refused, and `path` is the argument's, dotted, empty for the arguments as a whole; the module was not called), `{ status: "refused", reason: "unavailable", text }` or `{ status: "failed", error }`; `steps` is how many steps completed and `stopped` why the loop was cut (`"steps"`, `"time"`, `"failed"`) or null. The checks come in the engine's order: the command exists, the role allows it, the arguments fit [`params`](#arguments), then `available`. |
| `text(line, who?, room?)` | What a member types after the `.` prefix (`"attack Bo"`, `"j 攻 刀客"`). It is matched against the forms of the module's own commands — the command word case-folded, the form with the most literal words winning, then declaration order — and the captured words are converted by their property's `type`; then the command runs as `command` runs it (same role, argument and `available` checks, same steps). It answers what `command` answers, plus `matched`: `{ command, form, args }` — the form as declared and the arguments it built, set even when the arguments then fail the check — or null when no form fit. A line that fits none is refused: `{ status: "refused", reason: "text", code: "usage", forms }` when its first word is one of the module's command words (`forms` are that word's forms as declared), `{ status: "refused", reason: "text", code: "no_form" }` when it is not (the engine would treat such a line as another command or as unknown; the host knows only this module). A `<module>/<command> {…}` line is not a form: use `command`. |
| `view(name, who?, room?)` | The view's data for `who`; throws if it failed. |
| `keeperCommand(name, args?, who?, room?)` | Runs a command as the Keeper does (`call.by` is `"keeper"`; `who` is the member whose turn it is), with the same checks: `player` and `keeper` commands run, `admin` ones and those declaring `keeper: false` are refused with `reason: "role"`, and arguments that do not fit `params` are refused as for `command`. |
| `available(name, who?, room?)` | For the member `who`: `"role"` when the role forbids it (a `keeper` command: for everyone but an admin), else what `available` answers — the question the engine asks at the moment of use. |
| `characters(room?)`, `clock(room?)` | The read-only answers. |
| `checkpoint` | The current checkpoint: what a restart would load. |
| `description` | The static description the engine reads at load. |
| `forms` | The module's text forms as the engine reads them at load: `kept` (`{ command, form }`, in declaration order) and `dropped` (`{ command, form, problem }`: the forms the engine leaves out for their grammar; `problem` is `spacing`, `bad_word`, `bad_token`, `rest_not_last`, `unknown_param` or `repeated_param`). A dropped form is not matched by `text`; its command stays and runs by name. |
| `restart()` | A new instance, `load`-ed from the checkpoint. |

Every call returns what it did: `effects` (in order; empty when the call failed; a stepped
command's are every completed step's), `refused` (effects dropped as misplaced or malformed),
`error` (when it threw), `checkpoint` (after the call), and shortcuts `injected`, `facts`,
`writes`, `blocks`, `rolls`, `seats` (each with the `name` the module's `characters()` gave
after the call, or null when it does not offer that character), `logs`.
`who(name, { id?, role?, character? })` builds a `Who`; give `character` the module's own id
for one of its own characters.

`room` is `{ turn?, variables?, clock?, members? }`: what you leave out comes from the
options, and `turn` from the last turn started (1 before any).

The text forms and the arguments are tested with the engine's own code:

```ts
test("a typed line runs the attack, and a misfit never reaches the module", async () => {
  const host = createTestHost(duel);   // attack: params { target: string, times?: integer },
                                       // text ["attack {target}", "attack {target} {times}"]
  const ada = who("Ada");

  const hit = await host.text("attack Bo 3", ada);
  expect(hit.matched).toEqual({ command: "attack", form: "attack {target} {times}", args: { target: "Bo", times: 3 } });
  expect(hit.outcome.status).toBe("ok");

  const many = await host.text("ATTACK Bo many", ada);        // `times` stays text, which is no integer
  expect(many.outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "times" });
  expect(many.effects).toEqual([]);

  expect((await host.text("attack", ada)).outcome).toMatchObject({ status: "refused", code: "usage" });
  expect((await host.text("dance", ada)).outcome).toMatchObject({ status: "refused", code: "no_form" });
  expect(host.forms.dropped).toEqual([]);                     // every form of the module reads
});
```

The test host does not apply effects and does not enforce the engine's limits above;
check them in your own tests if you come near them. It knows only this module: a form
that a room drops because its word is an engine command word, a rule system's or another
module's (see [Text forms](#text-forms)) is still matched by `host.text`, and a line for
a command of the engine is `no_form` to it.

A script that drives a real server, rather than the test host, must respect the request
rate limit: a burst of 5, then one request per 2 seconds per member
([`docs/protocol.md`](../docs/protocol.md) §5.4).
