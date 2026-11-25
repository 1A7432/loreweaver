# LWF: skills (`SKILL.md`) and event hooks (`hooks.js`)

**Version 2.0 · stable (additive-only).** Numbered with the rest of the LWF 2.0 family;
against the unpublished 1.0 draft, 2.0 adds two events (`clock_advanced`,
`tool_use` with `denyTool`), `decvar`, the native-bundle hook location, the image and
performance block kinds for `emitUI`, and `emitPanel` as stable. It also corrects the
cap and kill-switch statements of 1.0 to what the reference enforces. The hook-private
state store (`getstate`/`setstate`, §4), module actions (`defineAction`, §4) and
`event.seed` (§3) are **additive** extensions within 2.0: a script that uses none of them
behaves exactly as before. Reference
implementation: `core/skills.py`, `core/hooks.py`, `agent/hook_runtime.py`,
`core/ejs_full.py`, `core/ejs_lite.py` and the hook phases in `agent/loop.py` in the
Loreweaver engine.

## 1. Skills

A skill is a directory `skills/<id>/` whose name is the skill id (a slug inside a pack).
It contains `SKILL.md` and, optionally, `hooks.js`. Inside a pack it contains nothing
else ([pack.md](pack.md) §2).

`SKILL.md` follows the Claude Code shape:

- The first line MUST be `---`. The frontmatter runs up to the next line that is exactly
  `---`, and a file without a closing fence is malformed.
- The frontmatter is YAML, read with a safe loader that rejects anchors and aliases, and
  MUST be a mapping. Unknown keys are ignored.
- The rest of the file is the Markdown **body**: instructions for the runtime's
  game-master agent while the skill is enabled.

| Frontmatter | Meaning |
|---|---|
| `name` | Display name. Defaults to the id. |
| `description` | When to enable the skill. Shown to the room admin. |
| `name-zh`, `description-zh` | Optional localized display metadata. The English fields are the fallback. |
| `allowed-tools` | A list of runtime tool names that the skill unlocks while it is enabled. A runtime MUST ignore names it does not know. |
| `metadata.scope` | `room`, the default and the only defined value: a per-room toggle. |
| `metadata.systems` | The rule-system ids the skill is written for. Informative. |
| `metadata.content-rating` | `mature` or `explicit` declares mature content. While such a skill is enabled, a runtime MAY lift its output content filter for that room; the reference does. |

Rules:

- **Install ≠ enable.** A skill becomes active in a room only through a room-admin enable
  action ([pack.md](pack.md) §6.5).
- **Built-ins win.** A skill whose id a runtime built-in already claims never replaces
  the built-in.
- **Robust discovery.** A malformed skill MUST be skipped with a log, without blocking
  other skills.

Reference: `core/skills.py::parse_skill_text`, `gateway/ops.py::room_content_unfiltered`.

## 2. Where hooks live

- A skill's `hooks.js` is active while the skill is enabled for the room.
- A card's hook scripts ([cards.md](cards.md) §4) are installed room-wide by the room
  admin's world import. A native bundle carries them as its top-level `hooks` list, and
  a SillyTavern card as `extensions.loreweaver_hooks`. Re-importing a card replaces that
  card's scripts and never stacks them.

A room runs at most **16 scripts** in total, skills and cards together, and each script
is at most **40,000 characters**. A script beyond the cap, a script that is too long,
and a script that throws while loading are each skipped with a logged warning. The other
scripts still load.

## 3. Events

A script registers handlers with `on(event, handler)`. Handlers run in registration
order, and a handler that throws loses only its own effects. A handler may be `async`; a
rejection is logged.

| Event | Payload | When |
|---|---|---|
| `turn_start` | `{user_message, actor}` | Before the game-master agent runs for the player's input. |
| `tool_use` | `{tool, arguments}` | Before each tool call the game-master agent makes. Also before each variable write by another AI lane that the runtime describes as the equivalent tool call. |
| `dice_rolled` | `{rolls: [{tool, result}]}` | After the reply, when at least one dice tool resolved this turn. `result` is truncated to 200 characters. |
| `clock_advanced` | `{from, to, delta}` | After the reply, once for each game-clock advance made this turn. |
| `reply_ready` | `{reply}` | After the reply is final. |
| `variables_changed` | `{writes: [{path, op}]}` | Last, at most once per turn, and only when something wrote variables this turn: hooks, the reply's own variable-update blocks, or tool calls. `op` is `set`, `insert`, `delete`, `add` or `move`. Writes made by this event's own handlers do not fire it again, so hook cascades end by construction. |

After the reply, the phases run in this order: `dice_rolled`, `clock_advanced` (once per
advance), `reply_ready`, `variables_changed`.

**`event.seed`.** Every payload above, and every module action's `event` (§4), also carries
`seed`: a non-negative integer below 2^53. A runtime MUST derive it from persisted inputs
only (the reference: sha256 over the room, the turn in flight and the dispatch's stream
and ordinal within the turn), so that the same room state yields the same seeds and a
rewound turn replays them. Script authors needing randomness SHOULD seed their own
generator from it; `Math.random()` is not replayable.

**`denyTool(reason)`** may be called in a `tool_use` handler. It refuses the tool call,
and the reason goes back to the agent as the refusal. A refusal **fails open**: if the
dispatch fails or times out, the call is allowed. A room admin's own commands are not
tool calls and are never subject to `denyTool`.

## 4. Inside a handler

**Variable bridge.** These are available inside every handler:

- `getvar(name, {defaults}?)`: reads a typed variable by id, or a path in the imported
  variable tree.
- `setvar(name, value)`: writes a value.
- `incvar(name, delta = 1)` and `decvar(name, delta = 1)`: adjust a value.
- The `variables` and `stat_data` tree views, and lodash as `_`.

A leading `variables.` or `stat_data.` on a name is ignored.

Hooks are module logic. They see the **keeper view** of the variables, including
keeper-only typed variables and unexposed tree leaves. Everything they emit to players
is authorial output, so authors MUST NOT emit keeper-only material.

**Snapshot semantics.** Variables are snapshotted once per turn. A handler sees its own
earlier writes as it requested them, before validation. It does not see writes that
tools or the reply made earlier in the same turn. `variables_changed` reports which paths
changed and how, never the new values.

**Private state.** A hook-only JSON store, separate from the variables. It is available
in hook handlers only, never in templates (§7).

- `getstate(key)`: returns a copy of the stored value, or `undefined` when the key is
  absent. Mutating the copy changes nothing stored.
- `setstate(key, value)`: stores any JSON value, as it is at the moment of the call.
  `null` or `undefined` deletes the key. A value that cannot be represented as JSON,
  including NaN or Infinity anywhere inside it, is refused and logged.

A runtime MUST keep this store out of the variable space: it is never rendered into the
game-master prompt, never sent to any client, never reported by `variables_changed`, and
never resolvable by conditions, panel bindings or `getvar`. Writes are buffered and applied
like variable writes (§5); a handler sees its own earlier writes at once. At the start of
each phase (the turn's first event, the after-reply phases, each module action) the
handler's view MUST equal the persisted store. Writes made in a `tool_use` handler are not
applied. Limits, which a runtime MUST enforce per write:

| Limit | Value |
|---|---|
| Key | 1–64 characters of `A–Z a–z 0–9 _ . : -`; not `__proto__`, `constructor` or `prototype` |
| One value | ≤ 256 KiB, UTF-8 bytes of its compact JSON |
| Keys per room | ≤ 32 |
| All values per room | ≤ 1 MiB |
| Writes per dispatch | ≤ 32 |

A write over a limit is skipped and reported, never fatal. A stored value that cannot be
decoded reads as absent. The store is room state: a runtime that rewinds, exports or
resets a room treats it like the room's typed variables.

**Module actions.** `defineAction(name, spec, handler)` registers a mechanic the
game-master agent can call during the turn; it is available in hook scripts only.

- `name` matches `[a-z][a-z0-9_]{0,31}`. `spec` is an object: `description` (required,
  ≤ 200 characters), `params` (optional free-text hint of the argument shape, ≤ 400
  characters), `rolls` (optional, at most 8 identifier slots mapped to dice expressions).
  Unknown `spec` keys are ignored. A registration that breaks these rules is dropped with
  a logged warning; for a repeated name the first valid registration wins; a room has at
  most 24 actions.
- A runtime exposes the room's actions to the agent as one tool. The reference names it
  `module_action` with parameters `action` (an enum of the names) and `args` (an object),
  and lists each action as `name — description [params]` in registration order.
- Before each call the runtime refreshes the handler's view of variables and private
  state from the store, rolls each declared slot with its own dice engine, and calls
  `handler(args, event)` with `event = {actor, seed, rolls}` and
  `rolls = {slot: {expr, total, dice}}`. `args` is at most 8 KiB serialized.
- The handler's return value is the tool result: a string as is, any other value as
  compact JSON, `undefined` as a short confirmation; at most 4,000 characters.
- Effects (`setvar`, `setstate`, `emitUI`, `emitPanel`) are applied immediately as in §5,
  and its variable writes count as the turn's hook writes (`variables_changed` reports
  them). `inject`, `narrate`, `rewriteReply` and `denyTool` have no effect in an action.
- A handler that throws, times out, does not settle or returns a non-JSON value applies
  **nothing**; the agent receives a failure line.
- A `tool_use` handler sees and may deny action calls. A runtime MUST cap the calls per
  turn (the reference: 16) and MUST NOT run two action calls concurrently.

**Effect emitters.** Each emitter's cap applies **per event dispatch**.

| Emitter | Effect | Cap per dispatch |
|---|---|---|
| `inject(text)` | Adds a section to this turn's game-master prompt. Only useful in `turn_start`. | 8 × 4,000 characters |
| `narrate(text)` | Appends to the player-visible reply, after a blank line, in event order (`turn_start` first, held until the reply exists, then the after-reply phases in order); a later handler's `reply` includes earlier narrations. No effect in `tool_use` or a module action; a turn that fails before producing a reply delivers none. | 8 × 2,000 characters |
| `rewriteReply(text)` | Replaces the player-visible reply. It takes effect in `reply_ready`. | 1 × 4,000 characters |
| `emitUI(blocks, opts?)` | Sends declarative UI blocks to clients as protocol `ui` frames. | 8 emissions × 16 blocks |
| `emitPanel(panelId, payload)` | Sends an opaque event to one declared panel ([panels.md](panels.md) §4). | 20 per **turn** across all dispatches, each ≤ 32 KB serialized |
| `log(text)` | Writes an operator-visible warning line. | — |

**`emitUI`.** `blocks` uses the `ui` block vocabulary of [panels.md](panels.md) §3, in
wire form: an `image` or `map_pin` names its picture by sha256 `hash`, not by path.
`opts` takes the following keys; invalid values fall back or are dropped:

- `panel`: `inline` (the default) or `sidebar`;
- `id`: names a UI region, at most 64 characters;
- `replace: true`: lets an inline frame update the prior frame with the same `id`.

A block that fails its schema is dropped, and the rest of the emission survives. A
runtime MUST drop an `image` or `map_pin` whose hash is not reachable from the room: the
room's own media, or an asset of a pack enabled in the room.

**`emitPanel`.** `panelId` is the wire id `<pack-id>/<panel-id>`. A payload that is not
JSON-serializable is dropped, and so is one that contains NaN or Infinity or is larger
than 32 KB. A runtime MUST deliver the event only to viewers whose panel manifest
contains that panel. A payload for an `audience: all` panel reaches players.

## 5. Contract: hooks request, the runtime applies

Every effect goes into a buffer. Deterministic runtime code validates, caps and applies
the buffer after the handler returns.

- A `setvar` whose name is a declared typed variable goes through that variable's kind
  and bounds validation ([cards.md](cards.md) §2). Any other name lands in the imported
  variable tree.
- A write that fails validation is skipped and reported, never fatal.
- At most 64 writes are applied per dispatch.
- A `setstate` write is checked against the private-state limits (§4) on top of the
  state as stored, so the room-wide limits hold across every dispatch of a turn.

## 6. Sandbox (normative floor)

- **A fresh interpreter every turn.** The runtime builds the hook interpreter anew for
  each turn (module actions run in the same interpreter as that turn's events). Nothing survives to the next turn or crosses into another room, so a value
  kept in a script global resets every turn. Durable state MUST go through the variable
  bridge or the private state store (§4).
- **Hard limits.** A memory cap (the reference uses 64 MiB) and a time limit per
  evaluation (1 s), armed **before** a script's top-level code runs. An infinite loop
  times out and never hangs the runtime.
- **Zero host I/O.** No filesystem, no network, no host callables. State goes into the
  sandbox, and effects come out of it, only as serialized JSON.
- **Inert on failure.** Any failure degrades to "hooks inert for this turn (logged)",
  never to a broken turn. This covers a parse error, a timeout, a memory overrun and a
  missing sandbox runtime.
- **Kill switch.** An operator kill switch MUST exist, and it MUST disable hooks and
  full-mode templates (§7) together.

## 7. Templates (EJS) and macros

World content, meaning lore entries and card prose, may embed EJS templates and
SillyTavern macros.

- **Full mode** executes real JavaScript, the official EJS library plus lodash, in a
  sandbox of the class of §6 with the same caps. A template's variable writes are
  buffered: at most 64 per evaluation, applied by deterministic code after rendering.
- **Subset mode** renders when full mode is unavailable, disabled, or fails. A runtime
  MUST then render a safe, read-only subset:
  - `<% if / else if / else %>` blocks;
  - `<%= %>` and `<%- %>` outputs;
  - `getvar()`, `variables.<path>` and `stat_data.<path>` reads;
  - the `{{getvar::…}}` and `{{var:…}}` macros;
  - `@@if` conditions.
- **Never raw.** In either mode, raw template syntax MUST NOT reach a language model.
- **Macros:**
  - `{{user}}`: the active player character, resolved at render time;
  - `{{char}}`: bound to the card name when the card is imported;
  - `{{time}}`, `{{date}}`: the **game** clock, not the wall clock;
  - `{{roll:XdY}}`: rolled by the runtime's dice roller, never narrated into existence;
  - `{{random}}`, `{{pick}}`, `{{newline}}`, `{{// comments}}`.
- **Randomness.** `{{random}}`, `{{pick}}` and lore `probability` draw from real
  randomness, seeded per room and turn, so a re-run of the same turn reproduces the same
  draws. Macro draws and lore-probability draws use separate streams.
- **Inert features.** The reference stubs `faker` to return empty strings, and ignores
  `@INJECT` message-index positioning.

Reference: `core/ejs_full.py`, `core/ejs_lite.py`, `agent/card_text.py`;
`docs/cards.md` in the engine.
