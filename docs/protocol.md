# Loreweaver wire protocol 3.0

This document is the open, versioned protocol between a Loreweaver server and its clients:
what a client sends, what the server sends back, and in what order. It is written so that a
client can be built from it without reading the server. Protocol version: `"3.0"`.

The authority is the code. The frame types, payload shapes and limits every client shares are
in the `loreweaver-protocol` package, entry `loreweaver-protocol/v3`
(`clients/protocol/src/v3/`): `frames.ts` (frames, event and signal payloads, limits),
`views.ts` (the built-in views and their JSON Schemas), `bytes.ts` (the byte channel),
`decode.ts` (what a client accepts and what it drops) and `client.ts` (a reference client
session that does no I/O). Where this document and that package disagree, the package is
right and this document has a bug.

**3.0 is a new protocol.** It has no compatibility with 2.x: not on the wire, not in the room
database, not in pack or module formats. The transport's ALPN carries the protocol major
(`loreweaver/3`), so a 2.x client fails to connect instead of misreading frames.

## Contents

1. [Concepts](#1-concepts)
2. [Transport](#2-transport)
3. [Frames](#3-frames)
4. [Connecting](#4-connecting)
5. [Requests and results](#5-requests-and-results)
6. [Commands](#6-commands)
7. [The event log](#7-the-event-log)
8. [Event kinds](#8-event-kinds)
9. [Signals](#9-signals)
10. [Views](#10-views)
11. [The byte channel](#11-the-byte-channel)
12. [Behaving well](#12-behaving-well)
13. [Example sessions](#13-example-sessions)
14. [Not in 3.0 yet](#14-not-in-30-yet)

---

## 1. Concepts

Loreweaver runs tabletop role-playing sessions with an AI game master. The protocol has four
ideas: an **event log** (what happened at the table, numbered and stored), **calls** (what a
client asks for, each answered once), **views** (structured values the server keeps current for
a client) and the **byte channel** (files, moved beside the control stream).

| term | meaning |
|---|---|
| room | One table: its members, its story, its log. Every key belongs to exactly one room. |
| key | A secret string that admits its holder to one room with one role. There is no registration. |
| role | `player`, `admin` or `observer`, fixed by the key. See [4.4](#44-roles). |
| the Keeper | The AI game master. It is not a member and holds no key. |
| admin | The human holding an admin key. An admin also plays; "admin" never means the AI. |
| member | One connection in a room. A person with two connections is two members with one member id. |
| member id | A stable id derived from the key (`m:` and 12 hex digits). It never reveals the key. |
| event | One entry of the room's log: numbered (`seq`), stored, sent to every member in order. |
| signal | An ephemeral message to the table: never stored, never replayed. |
| view | A named structured value computed for one viewer, pushed when it changes. |
| command | The one kind of operation a person performs: engine, rule pack and module commands alike. |
| turn | The Keeper's answer to one line of speech. Turns are numbered per room. |
| epoch | The room's generation. It moves when the log is rewritten (undo, reset, import). |
| `seq` | An event's number in its room's log. Never reused in a room, not even after an undo. |
| `head` | The highest `seq` the room has handed out (0 for a room that never logged anything). |
| `rid` | A request id the client chooses; the server's one `result` for that request carries it. |

## 2. Transport

### 2.1 Iroh

The server speaks over [iroh](https://iroh.computer): peer-to-peer QUIC, dialled by a
**ticket** (an iroh endpoint ticket string). No domain, TLS certificate or open port is needed.

- **ALPN:** `loreweaver/3`. It changes with the protocol major.
- **The control stream** is the first bidirectional stream the client opens on the connection.
  It lives as long as the connection. The client writes `hello` on it at once (a QUIC stream is
  not visible to the server until the client sends on it).
- **Every further bidirectional stream** the client opens on the same connection is one
  operation of the byte channel ([section 11](#11-the-byte-channel)). Byte streams never block
  the control stream.

The operator starts a server with `loreweaver serve`, which prints one JSON object holding the
`ticket` (and, the first time a data directory is used, a `first_key`: an admin key for the
room `main`). Further keys are minted with `loreweaver key <room> <admin|player|observer>
<name>`. A client needs a ticket and a key; nothing else identifies a server or a person.

### 2.2 Framing

Control frames are newline-delimited JSON: one compact JSON object per line, UTF-8, ended by
`\n`. Blank lines are skipped. Every frame is an object with a string `type`.

A line that is not valid JSON is treated as an unreadable frame (`bad_frame`,
[4.5](#45-connection-level-errors)).

### 2.3 Ping

The client may send `{"type":"ping","t":<number>}` at any time, even before `hello`; the
server answers `{"type":"pong","t":<same number>}` at once. Only the client pings: the server
never sends a ping and does not require one. Use it to measure the round trip or to notice a
dead link.

## 3. Frames

Eleven frame types.

Client to server:

| `type` | fields | purpose |
|---|---|---|
| `hello` | `protocol`, `key`, `name?`, `locale`, `client {name, version}`, `caps`, `resume? {epoch, after}` | The first frame: authenticates and joins the key's room. |
| `input` | `rid`, `text` | A line the person typed: speech, or a text command. |
| `call` | `rid`, `method`, `params` | Everything else a client asks for. |
| `ping` | `t` | Round-trip measurement. |

Server to client:

| `type` | fields | purpose |
|---|---|---|
| `welcome` | `protocol`, `server {name, version}`, `room {id, locale}`, `you {id, name, role}`, `features`, `epoch`, `head`, `first` | The answer to `hello`. |
| `event` | `seq`, `id`, `ts`, `kind`, `turn?`, `data` | One entry of the room's log, to every member, in `seq` order. |
| `signal` | `kind`, `data` | Ephemeral: never logged, never replayed. |
| `view` | `name`, `rev`, `at`, `data` | The current value of a view this connection subscribed to. |
| `result` | `rid`, `ok`, then `data?` and `text?` (ok) or `error {code, message}` (not ok) | The one answer to an `input` or a `call`, to the caller alone. |
| `error` | `code`, `message`, `fatal` | Connection-level only: there is no `rid` to answer. |
| `pong` | `t` | The answer to `ping`. |

A `rid` is a string of 1 to 64 characters, chosen by the client and unique among its requests
still waiting for an answer. Unknown fields in a client frame are ignored by the server.

## 4. Connecting

### 4.1 `hello`

```json
{"type":"hello","protocol":"3.0","key":"rT9vQ2xLm8Kc3PzW0aYbN5sEdF7gHjU1","name":"Ada","locale":"en","client":{"name":"my-client","version":"0.1.0"},"caps":[]}
```

| field | type | meaning |
|---|---|---|
| `protocol` | string | `"3.0"`. Only the major is compared. |
| `key` | string | The access key. |
| `name` | string, optional | The name to appear under. Trimmed; empty or absent means the key's own name. At most 64 code points. |
| `locale` | string | The client's language, e.g. `en`, `zh`, `zh-CN`. Only the part before `-` or `_` is used; a language the server has no catalog for falls back to `en`. Results, errors and views addressed to this member are written in it. |
| `client` | `{name, version}` | The client's own name and version, both strings. |
| `caps` | string[] | What the client can do. 3.0 servers define no values and ignore the list; send `[]`. |
| `resume` | `{epoch, after}`, optional | The room generation and the last `seq` this client holds. Integers. See [7.4](#74-resume-and-the-replay-limit). |

The server checks, in this order, and refuses with a **fatal** `error` (then closes the
connection) at the first failure:

1. the major of `protocol` is 3, else `protocol_mismatch` (the message names both versions);
2. the key is known, else `bad_key`;
3. the trimmed `name` is at most 64 code points, else `bad_name` (refused, never cut).

The language is taken from `hello` before these checks, so even these refusals are in the
client's language.

### 4.2 `welcome`, then the replay

On success the server sends, in this order and with nothing in between:

1. `welcome`;
2. the replay: the events the client is owed ([7.4](#74-resume-and-the-replay-limit)), in `seq` order;
3. from then on, live traffic.

```json
{"type":"welcome","protocol":"3.0","server":{"name":"loreweaver","version":"3.0.0-alpha.0"},"room":{"id":"main","locale":"en"},"you":{"id":"m:15b5f3445045","name":"Ada","role":"player"},"features":[],"epoch":1,"head":2,"first":1}
```

| field | meaning |
|---|---|
| `protocol` | The server's version. A client refuses a different major. |
| `server` | The server's name and version. |
| `room.id` | The key's room. |
| `room.locale` | The room's language: what events and signals are written in. |
| `you` | Your member id, the name you appear under, and your role. |
| `features` | What the server offers beyond the protocol. 3.0 servers send `[]`. |
| `epoch` | The room's generation now. |
| `head` | The highest `seq` the room has handed out. |
| `first` | The `seq` of the OLDEST event the room still holds (0 when its log is empty). `head` never goes back — not after a reset, not after an undo — so it does not say how much history exists; `first` does. |

Replay and join happen in one uninterrupted step on the server, so no live event can fall
between two replayed ones or be missed. The replay carries events and no views. When a Keeper
turn is running at that moment the server follows the replay with one `turn` signal
(`busy`, with the actor), so a client that connects in the middle of a turn knows; when none
is running nothing is sent, and a client starts in the idle state.

### 4.3 After the welcome

A `hello` sent again on a joined connection is answered with a non-fatal `bad_frame`. Any
other frame (`input`, `call`) sent before a successful `hello` ends the connection with a fatal
`hello_first`. `ping` is answered at any time.

Views are not subscribed automatically: a client that wants them calls `view.subscribe` after
the welcome, and again after every reconnect ([10.2](#102-subscribing)).

### 4.4 Roles

| role | may |
|---|---|
| `player` | Speak, run player commands, subscribe to views, upload (when uploads are on), fetch room media. |
| `admin` | Everything a player may, plus admin commands and admin-only arguments, and fetch admin-only files. |
| `observer` | Watch: receive events, signals and views, run the few commands marked for observers (`help`, `recap`, `uploads` without arguments, `model list` without arguments), fetch room media. An observer's speech is refused (`observer_speech`) and so are its uploads (`observer_upload`). |

The role belongs to the key; it cannot be changed from a connection. A room admin changes a
key's role with the `key` command ([6.8](#68-the-engines-commands)): the holder's live
connections then end, and the client comes back with the new role in its `welcome`. "Keeper" is never a
role: the Keeper is the AI. The person with the admin key is the room admin.

### 4.5 Connection-level errors

An `error` frame answers something that has no `rid`. With `fatal: true` the server closes the
connection after sending it; a client must not redial with the same settings (the reference
client marks the session ended).

| code | fatal | when |
|---|---|---|
| `protocol_mismatch` | yes | `hello.protocol` has another major. |
| `bad_key` | yes | The key is unknown. |
| `bad_name` | yes | `hello.name` is over 64 code points. |
| `hello_first` | yes | An `input` or `call` arrived before a successful `hello`. |
| `bad_frame` | yes before the welcome, no after it | A frame that cannot be read: not JSON, not an object, no string `type`, an unknown `type`, a missing required field, an `input` or `call` without a valid `rid`, or a second `hello`. |

A malformed `input` or `call` that does carry a valid `rid` is not an `error`: it is answered
with a `result` refusal (`input_too_long`, `invalid_params`).

## 5. Requests and results

### 5.1 One answer per request

Every `input` and every `call` is answered by exactly one `result` with the same `rid`, sent to
the caller alone. A refusal is a `result` with `ok: false`; it is never an event and never
reaches anyone else.

```json
{"type":"result","rid":"r3","ok":true,"data":{"totals":[10]}}
```

```json
{"type":"result","rid":"r5","ok":false,"error":{"code":"forbidden","message":"That is for the room admin."}}
```

- `ok: true` may carry `data` (structured, per method or per command) and `text` (the same
  answer written for a person, in the caller's language). Either, both or neither may be present.
  A text-only client prints `text`.
- `ok: false` carries `error.code` (stable, for programs) and `error.message` (for people, in the
  caller's language).

Results are not ordered with respect to each other: a command queued behind a Keeper turn is
answered after a `view.get` sent later. Match by `rid`.

**Where an outcome goes.** What happened at the table is published as **events**, to every
member. What concerns only the caller (done or not, why not, the answer to a query, anything
secret such as a hidden roll) is the **result**. One command often does both: `.r 2d6` puts a
`dice` event in the log and answers the caller with `data.totals`.

### 5.2 `input`

`{"type":"input","rid":"…","text":"…"}`. `text` is at most 8000 code points; over that it is
refused with `input_too_long`. The server decides what the line is ([6.2](#62-two-entrances)):

- **A text command** (a prefix and a command word): it runs exactly as `command.run` would, and
  its result is the command's answer.
- **Speech** (anything else): the line is accepted at once. Its `narrative` event and the
  `dice` events of its inline rolls are published first, then the caller gets `ok: true`
  (with `text` naming any inline roll that failed). The Keeper's turn then queues behind the
  room's lock and its reply arrives later as events. The result does not wait for the reply.

### 5.3 Methods

| method | params | `data` of a success | refusals |
|---|---|---|---|
| `command.run` | `{id, args?}` | the command's own answer ([6](#6-commands)) | `invalid_params` (`id` not a non-empty string of at most 200 code points), and every command refusal |
| `view.list` | `{}` | `{views: [{name, schema, title?}]}` | — |
| `view.subscribe` | `{names}` | `{problems: [{name, code}]}`; the current values follow as `view` frames | `invalid_params` (`names` not a list of at most 64 strings) |
| `view.unsubscribe` | `{names}` | `{removed: [name]}` | `invalid_params` |
| `view.get` | `{name}` | `{name, rev, at, data}` | `invalid_params`, `unknown_view`, `view_failed`, `too_large` |
| `log.page` | `{before, limit?}` | `{events: [event frame]}`, oldest first | `invalid_params` (`before` not an integer; `limit` not an integer from 1 to 100) |
| `media.offer` | `{name, mime, size, sha256, purpose?}` | `{upload_id}` or `{existing}` | see [11.2](#112-offering-a-file) |

An unknown method is refused with `unknown_method`. `params` may be omitted (it is then `{}`);
present and not an object, it is refused with `invalid_params`.

### 5.4 The rate limit

Each member has a token bucket: a burst of 5, refilled at one token every two seconds (the
server's default). Every `input` and every `command.run` spends one token; with none left the
request is refused with `rate_limited`, not queued. Views, `log.page` and `ping` are not
rate-limited. Uploads have their own limit ([11.2](#112-offering-a-file)).

## 6. Commands

### 6.1 The command model

A command is the only kind of operation a person performs. The engine's commands, the commands
of the room's rule system (its "rule pack") and the commands of the room's modules share one
table, discovered through the `commands` view ([6.5](#65-discovering-commands-the-commands-view)).

| source | ids look like | examples |
|---|---|---|
| `engine` | a plain word | `roll`, `undo`, `help` |
| `pack` | `rules.<subsystem>` | `rules.sanity_check` |
| `module` | `<module>/<name>` | `duel/strike` |

### 6.2 Two entrances

The same command is reached two ways, with the same role checks, argument validation, rate
limit and queueing:

- `input` with a text form: `.r 2d6`;
- `call` `command.run`: `{"id":"roll","args":{"expr":"2d6"}}`.

A text form's argument string is parsed into exactly the argument object a structured call
passes, then both are validated against the command's parameter schema and reach the same
handler. The command runs in one transaction: a refusal leaves the room exactly as it was.

**Ordering.** Commands and speech queue behind one lock per room, in arrival order. A command
opens no Keeper turn. Three commands are **room-lifecycle** commands and do not wait for the
lock: `undo`, `reset` and `save` (export and import). They run at once, even in the middle of a
Keeper turn; work of the old generation still running (a turn waiting on the model, a queued
line) fails to commit by itself, and the in-flight turn ends with its `turn idle` signal as usual.
`pack install`, `model`, `imagegen` and `key` do not wait for the lock either: they act on the
server (a fetch, a model switch, a revoked key) and must not sit behind a turn. A turn in flight
when the model is switched finishes on the model it started with.

### 6.3 Text forms

A line is a text command when, after trimming:

1. it starts with one of the three equivalent prefixes `.`, `。` (U+3002) or `/`;
2. optional whitespace follows, then the **command word**: the first run of non-whitespace
   characters, matched exactly after case folding. There is no glued form: `.r3d6` is the word
   `r3d6`, which is no command;
3. the word names a command in this room.

Everything after the word (trimmed) is the argument string, at most 4000 code points (over it
the command is refused with `too_long`, never cut short).

- A line with no prefix, no word, or a word that names no command is **speech**, said at the
  table as written. A mistyped command therefore reaches the Keeper as speech.
- Exception: a word that some installed rule system declares but this room's system does not is
  refused (`not_in_system`) instead of becoming speech.
- Engine forms win over rule-pack forms. Every command has an English and a Chinese alias table;
  both are always searched, the caller's language first.
- A module command's only text entrance is its full id followed by a JSON object:
  `.duel/strike {"target":"Bo"}` (no argument string means `{}`; anything that is not a JSON
  object is refused with `module_args`).

**Inline rolls.** Speech may carry up to 8 inline rolls written `[[expr]]`, e.g.
`I swing the lantern [[1d6]]`. Each is rolled and published as a `dice` event right after the
line's `narrative` event. A roll that fails to parse is skipped and named in the result's
`text`; more than 8 and none are rolled.

### 6.4 Refusals

A command refusal is a `result` with a stable code and a message in the caller's language. The
codes a client meets most:

| code | meaning |
|---|---|
| `unknown_command` | No command with that id (or text form) in this room. |
| `forbidden` | The command, or one of the arguments given, is for the room admin; or an observer tried a command not marked for observers. |
| `usage` | The text form's arguments could not be read; the message carries the usage line. |
| `unknown_arg`, `missing_arg`, `invalid_arg` | The argument object does not fit the schema; the message names the path (`expr`, `a.skill`, `writes.0.value`). |
| `too_long` | The text form's argument string is over 4000 code points. |
| `no_rule_system`, `not_in_system`, `no_media` | The command is not available in this room now (the same words appear as `reason` in the `commands` view). |
| `stale_generation` | The room was rewound, reset or replaced while the command waited. Try again. |
| `rate_limited` | The member's burst is spent. |
| `module_args`, `module_unavailable` | A module command's arguments are not a JSON object; the module refused (its own reason is shown as written). |
| `command_failed` | The server failed; nothing was changed. |

Commands add their own (`bad_dice`, `no_character`, `name_taken`, `reset_not_armed`,
`undo_out_of_range`, `undo_beyond_depth`, `not_uploaded`, `not_a_card`, `last_admin`, …). A code without a
sentence of its own is stated with a generic message that includes the code. Treat any code you
do not know as a plain refusal and show `message`.

### 6.5 Discovering commands: the `commands` view

The `commands` view ([10.4](#104-built-in-views)) lists the commands this viewer may see, as
this viewer may use them now:

```json
{"id":"roll","source":"engine","title":"Roll dice","description":"Roll a dice expression for the table to see. A comparison straight after a dice group counts the dice that meet it (5d10>=7); compare a total in parentheses ((5d10)>6). d% is a d100. N# rolls N times; adv/dis keeps the better or worse of two.","params":{"type":"object","properties":{"expr":{"type":"string","minLength":1,"maxLength":1000},"repeat":{"type":"integer","minimum":1,"maximum":20},"mode":{"type":"string","enum":["adv","dis"]}},"additionalProperties":false},"role":"player","available":true,"text":{"forms":["roll","r"],"usage":".r [N#][expr] [adv|dis] — e.g. .r 3d6+2, .r 2#1d20 adv, .r 5d10>=7"}}
```

| field | meaning |
|---|---|
| `id` | What `command.run` takes. |
| `source` | `engine`, `pack` or `module`. |
| `title`, `description` | In the viewer's language (a module's are as the module wrote them). |
| `params` | The arguments as a JSON Schema object ([6.6](#66-parameter-schemas)). |
| `text` | Optional: `forms` (the words that run it, without prefix) and `usage` (a one-line usage text). Absent for a command without a text form. |
| `role` | `player` (players and admins) or `admin` (admins only). |
| `danger` | Present and `true` for a destructive command: ask before running it (`undo`, `reset`, `save`). |
| `available` | Whether this viewer can run it here now. |
| `reason` | When not available: `observer`, `no_rule_system`, `not_in_system`, `no_media`, or a module's own reason code. |

- An admin command is not listed to a non-admin at all.
- Some player commands need the admin for certain arguments (`bot` with `on`, `rule` with
  `variant` or `system`, `uploads` with `on`, `init` with `name`, `lore` with anything but
  `list`, `import` with `as: "world"`, `model` with anything but a bare `list`). The entry says `role: "player"`; the admin-only
  arguments are refused with `forbidden`. See the table in [6.8](#68-the-engines-commands).
- `text.forms` lists the viewer's language table (or the other one when it is empty). The
  server accepts the forms of both tables.
- A module command's `text.forms` are the templates its module declared (such as
  `strike {target}`), shown for people, and its `available` is `true` for any player: the
  module answers at the moment of use.

### 6.6 Parameter schemas

Engine and rule-pack parameter schemas use this subset of JSON Schema, and the server validates
strictly:

| keyword | used for |
|---|---|
| `type` | `"object"`, `"string"`, `["string","null"]`, `"integer"`, `"number"`, `"boolean"`, `"array"` |
| `properties`, `required`, `additionalProperties` | objects; `additionalProperties` is `false` (no other names), `true` (any object), or a schema for every other name |
| `maxProperties` | objects (default cap 64 names) |
| `enum`, `minLength`, `maxLength` | strings (lengths in code points; default cap 4000) |
| `minimum`, `maximum` | integers and numbers |
| `items`, `maxItems` | arrays (default cap 64 items) |

A name the schema does not list is refused (`unknown_arg`); an integer must be a JSON number
with no fraction, and a number a finite JSON number, never the text `"5"`; an argument given as `null` counts only where the type
allows `null`; nesting deeper than 8 levels is refused. A module command's `params` is the
schema its module declared.

### 6.7 Room-lifecycle commands, as a client sees them

- **`undo`** (admin): rewinds the room by `turns` (default 1, at most 64, and never past the
  server's undo window, `undo_beyond_depth`). The table receives one `rewind` event
  ([8.5](#85-rewind)); the caller's result carries `data {turn, epoch, removedTurns}`.
  Undoing a turn also takes back every command that ran after that turn began.
- **`reset`** (admin): two steps. `{"scope":"story"}` (or `chars`, `all`; default `story`)
  *arms* a reset for 60 seconds, for this member and this room, and answers
  `data {armed: <scope>}`; nothing changes yet. `{"confirm":true}` within the window carries
  it out: the table receives one `reset` event ([8.6](#86-reset)) and the caller gets
  `data {scope, epoch}`. A confirm with nothing armed is `reset_not_armed`; one naming another
  scope is `reset_scope_mismatch`.
- **`save`** (admin): `{"op":"export"}` answers the whole room as a bundle in `data`, to the
  caller alone (it holds every secret of the room). `{"op":"import","bundle":{…}}` replaces the
  room with a bundle. An import replaces the room — another log under another numbering —
  so no event announces it: after answering the admin, the server ENDS the connection of every
  member of the room (no `error` frame; the link simply closes). Each client redials as after
  any dropped link; the `welcome` then names a new `epoch`, the client discards the log it
  held, and the replay hands it the room as it now is. A bundle's own `rewind` and `reset`
  events are not imported: they are markers of the room's earlier life.

### 6.8 The engine's commands

Generated from the server's command table (`server/src/gateway/commands/`). Every id here is
also listed in the `commands` view with its full parameter schema; `?` marks an optional
argument. Text forms are given as English table / Chinese table; with any of the prefixes
`.`, `。`, `/`.

| id | role | text forms | arguments | notes |
|---|---|---|---|---|
| `roll` | player | `roll`, `r` / `r`, `rd` | `expr?` (1–1000, default `1d20`), `repeat?` (1–20), `mode?` (`adv`\|`dis`) | One `dice` event per roll; `data {totals}`. |
| `hidden_roll` | player | `rh`, `hroll` / `rh` | `expr?`, `mode?` | No event: the table is not told. `text` and `data {expr, rolls, total}` to the caller. |
| `check` | player | `check`, `attack`, `cast`, `ra`, `rc` / `ra`, `rc`, plus the rule system's own check words | `skill?`, `target?`, `difficulty?`, `bonus?` (0–10), `penalty?` (0–10), `mode?`, `proficient?`, `params?` (object of integers, ≤16), `repeat?` (1–20) | Available when the room's rule system grades checks (`no_rule_system`). One `dice` event per check. |
| `opposed` | player | `opposed`, `rav`, `rcv` / `rav`, `rcv` | `a` `{skill?, value?, bonus?, penalty?}`, `b?` (same) | Available when the rule system has a contest (`not_in_system`). |
| `init` | player; `name`: admin | `init`, `initiative`, `ri` / `ri`, `init` | `op` (`show`\|`roll`\|`next`\|`clear`), `value?`, `name?` | Initiative order. |
| `sheet` | player | `sheet`, `st` / `st` | `op` (`show`\|`set`\|`clear`\|`finalize`), `writes?` (≤32 of `{name, op: "="\|"+="\|"-=", value}`) | Your character sheet. |
| `rename` | player | `rename`, `nn` / `nn` | `name` (1–64) | Renames the character you play. |
| `new_character` | player | the creation words of the installed rule systems (with the built-in ones: `coc`, `coc7`, `dnd`, `dnd5e`) | `system`, `name?` | Makes and seats a character; a `narrative` system event; `data {id, name, system, violations}`. |
| `pc` | player | `pc`, `roster` / `pc`, `角色池`, `预设角色` | `op` (`list`\|`claim`\|`release`), `name?` (≤128) | The roster of characters on offer. |
| `recap` | player, observer | `recap` / `recap`, `前情提要`, `前情` | — | The spoiler-free story so far. |
| `lore` | player; all but `list`, and `list` with `disabled`: admin | `lore` / `lore`, `设定`, `設定` | `op` (`list`\|`add`\|`enable`\|`disable`\|`bind`\|`unbind`\|`restore`), `title?` (≤200), `content?` (≤16000), `condition?` (≤500), `disabled?` | The room's lore. |
| `var` | admin | `var`, `vars` / `var`, `变量`, `變量` | `op` (`list`\|`expose`\|`hide`\|`set`\|`add`), `path?` (≤200), `value?` (≤4000), `delta?` | The room's variables; `expose` shows a branch to players. |
| `npc` | admin | `npc` / `npc`, `角色` | `op` (`list`\|`show`\|`delete`), `name?` | The answer is the caller's alone. |
| `chronicle` | admin | `chronicle` / `chronicle`, `编年史`, `年史` | `op` (`list`\|`summary`\|`threads`\|`note`), `text?` | The answer is the caller's alone. |
| `habits` | admin | `habits` / `habits`, `习惯`, `習慣` | `op` (`show`\|`forget`), `text?` (≤200) | What the Keeper learned about this table. |
| `rule` | player; `variant`, `system`: admin | `rule` / `rule`, `规则`, `規則` | `variant?` (string or `null`), `system?` (string or `null`) | Shows or sets the rule system and its house-rule ladder; `null` returns to the default. |
| `bot` | player; `on`: admin | `bot` / `bot` | `on?` (boolean) | Shows or sets whether the Keeper answers. |
| `language` | admin | `language` / `language`, `语言`, `語言` | `locale` (`en`\|`zh`) | Sets the room's language; announced by a `narrative` event in the new language. |
| `undo` | admin, danger | `undo` / `undo`, `撤销`, `撤銷` | `turns?` (1–64) | Lifecycle ([6.7](#67-room-lifecycle-commands-as-a-client-sees-them)). |
| `reset` | admin, danger | `reset` / `reset`, `重置`, `重开`, `重開` | `scope?` (`story`\|`chars`\|`all`), `confirm?` | Lifecycle; arm, then confirm. |
| `save` | admin, danger | `save` / `save`, `存档`, `存檔` | `op` (`export`\|`import`), `bundle?` (object) | Lifecycle. |
| `uploads` | player, observer; `on`: admin | `uploads` / `uploads`, `上传` | `on?` (boolean) | Shows or sets the room's upload switch. Available when the server keeps files (`no_media`). |
| `import` | player; `as: "world"`: admin | `import` / `import`, `导入` | `file?` (a 64-hex content hash), `pack?` (1–64), `card?` (1–512), `as` (`world`\|`character`), `name?` (1–64) | Imports a card file the caller uploaded with `purpose: "import"` ([11.6](#116-importing-a-card)), or a card an enabled pack ships (`pack` and `card`, its path in the pack; `pack_not_enabled`, `card_not_in_pack`). `no_media` without a media store and with no pack installed. |
| `pack` | player; `enable`, `disable`, `install`: admin | `pack`, `packs` / `pack`, `扩展包`, `擴展包` | `op` (`list`\|`enable`\|`disable`\|`install`), `id?` (1–64), `ref?` (1–2000) | `list`: an admin sees every installed pack, a player the room's by name. `enable`/`disable` switch an installed pack in this room (`unknown_pack`, `too_many_packs`, `module_id_taken`); disabling one stops what plays one of its audio cues (an `audio` `stop` signal per layer). `install` (text form `install <ref>`): `ref` a path on the server, an `https://` URL or `gh:owner/repo[@tag]`; installs the pack on the server and enables it here with its skills; `data {id, version, replaced, sha256, enabled, skillsEnabled, shadowed, trust}`, `text` the trust card in words; one `narrative` system event. It runs without queuing behind the room's turns, and its one result comes when the fetch and install are done. Refusals: `not_https`, `bad_gh_ref`, `source_not_found`, `archive_too_large`, `fetch_failed`, `too_many_redirects`, `no_pack_asset`, `bad_release`, `bad_archive`, `invalid_pack`, `engine_too_old`, `already_installed`, `index_unreadable`, `install_failed`, `install_unavailable`. |
| `skill` | admin | `skill`, `skills` / `skill`, `技能` | `op` (`list`\|`enable`\|`disable`), `id?` (1–64) | The Keeper's skills this room may enable: the built-in ones and those of its enabled packs (`skill_not_available`, `too_many_skills`). |
| `report` | player, observer; `reveal`: admin | `report` / `report`, `团报`, `跑团记录` | `format?` (`text`\|`html`), `reveal?` (boolean) | The session report. Without arguments: a short scoreboard as the result's `text` (`data {format: "text", players, turns, lines}`). `html`: the whole session as one self-contained page; `data {format: "html", edition, media: {hash, mime, size, name}}` — see below. `reveal` (text forms `reveal`, `复盘`): the admin's edition, which also prints what was hidden from the players. Emits no event; does not wait for the room's lock. `report_no_files` on a server without a file store. |
| `jrrp` | player | `jrrp`, `luck` / `jrrp` | — | Today's luck. |
| `draw` | player | `draw` / `draw`, `抽牌` | — | Draws a card from a shuffled deck. |
| `help` | player, observer | `help`, `h` / `help`, `帮助` | `id?` (1–128) | The `commands` view as text; with `id` (an id or a form), one command. |
| `audio` | admin | `audio` / `audio`, `音频`, `音訊` | `op` (`list`\|`set`\|`remove`), `query?` (1–400), `title?` (1–400), `layer?` (`bgm`\|`ambience`\|`sfx` or `null`), `tags?` (≤16 of 1–32) | The room's audio library ([10.4](#104-built-in-views) `audio`): the sounds its admin uploaded with `purpose: "audio"` ([11.2](#112-offering-a-file)) and the cues of its enabled packs, named `<pack>/<cue>`. `list`: `data {sounds: [{id, title, layer, tags, source}]}`. `set` changes an upload's title, layer and tags; `remove` takes an upload out of the library (what plays it stops; its bytes go unless the table's log or an enabled pack still uses them). A pack's cue is read-only (`audio_read_only`). Text forms: `audio [list]`, `audio set <sound> title=<t> layer=<l> tags=a,b` (a value with spaces in quotes), `audio remove <sound>`. Available when the server keeps files (`no_media`). |
| `bgm`, `ambience`, `sfx` | admin | `bgm` / `bgm`, `背景音乐`, `背景音樂`; `ambience`, `amb` / `ambience`, `amb`, `环境音`, `環境音`; `sfx` / `sfx`, `音效` | `op` (`play`\|`stop`\|`pause`\|`resume`\|`volume`), `query?` (1–400), `loop?`, `volume?` (a number 0–1), `fadeMs?` (0–60000) | One command per layer. `play` names a library sound by `query` — its id, else its exact title (or an upload's file name, or a cue's id without the pack), else a unique prefix of an id or title, else a unique substring — and plays it (`bgm` and `ambience` loop unless `loop: false`; volume 1 unless given); `stop`, `pause`, `resume`, `volume` act on what the layer plays (`audio_not_playing` when nothing). One `audio` signal ([9.4](#94-audio)) to the table; `data {layer, action, …}`. Refusals: `audio_not_found`, `audio_ambiguous` (the message names up to five candidates), `audio_bad_volume`, `audio_bad_fade`. Text forms: `bgm [play] <sound> [--loop\|--once] [--volume 0.7\|70%] [--fade 2000]`, `bgm stop\|pause\|resume [--fade N]`, `bgm volume <0–1\|N%>`; the Chinese words `播放`, `停止`, `暂停`, `继续`, `音量` too. |
| `model` | player, observer for `list` without `provider`/`lane`; everything else: admin | `model`, `models` / `model`, `模型` | `op` (`show`\|`list`\|`set`\|`key`\|`reset`), `lane?` (`keeper`\|`npc`\|`scribe`\|`director`\|`memory`; default `keeper`), `provider?` (1–64), `model?` (1–200), `key?` (1–1000), `baseUrl?` (1–2000), `wire?` (`openai-compatible`\|`anthropic`\|`openai-responses`), `effort?` (`low`\|`medium`\|`high`\|`xhigh`\|`max`), `contextWindow?`, `maxOutputTokens?`, `timeoutMs?` (positive integers), `promptCacheKey?` (boolean) | The model each lane uses, **server-wide** (every room follows). `show`: `data` is the [`admin/model`](#104-built-in-views) value. `list` without `provider` or `lane`: the providers this server knows, for anyone (`data {providers}`); with them, or from an admin: asks that provider for its models — `data {providers, provider, models, total, truncated, skipped}`, at most 500 ids of at most 200 code points, ids that are not are skipped and counted (`model_list_timeout`, `model_list_too_large`, `model_list_failed` with the provider's class of failure in the message, `model_not_configured`, `unknown_provider`). `set`: the lane now talks to `provider` (a preset, or any name with `baseUrl`); a key not given is the one saved for that provider, or the server's own (`unknown_provider`, `model_required`, `model_wire_mismatch`, `bad_provider`, `bad_model_id`, `bad_base_url`, `bad_key`, `too_many_credentials`); `data {lane, keySaved}`. `key`: the key of the provider the lane uses now, saved for that provider. `reset`: the lane (or every lane) goes back to the server's settings; saved keys stay; `data {reset, keeper}`. Keys come back masked (`sk-a...wxyz`). The next turn uses the new model; a turn in flight finishes on the one it started with. Runs without queuing behind the room's turns. No event. Text forms: `model [show]`, `model list [provider] [lane=…]`, `model set <provider> [model] [key=…] [base_url=…] [wire=…] [effort=…] [context=N] [max_output=N] [timeout=N] [cache=on\|off] [lane=…]`, `model key <key> [lane=…]`, `model reset [lane]`; the words `show`/`查看`, `list`/`列表`, `set`/`use`/`切换`, `key`/`密钥`, `reset`/`重置`. |
| `imagegen` | admin | `imagegen` / `imagegen`, `图片生成`, `圖片生成` | `op` (`show`\|`set`\|`off`), `provider?` (1–64: `openai`, `xai`, or a name with `baseUrl`), `model?` (1–200), `size?` (`WIDTHxHEIGHT` or `auto`), `key?`, `baseUrl?` | Image generation, server-wide. `set` without `baseUrl` needs a provider whose address is known (`openai`) or saved (`image_base_url_required`, `bad_image_size`); `off` stops pictures until an admin sets a provider again. `data {imagegen}` as in `admin/model`. No event. Text forms: `imagegen [show]`, `imagegen set <provider> [model] [size] [key=…] [base_url=…]`, `imagegen off`. |
| `key` | admin | `key`, `keys` / `key`, `钥匙`, `鑰匙` | `op` (`list`\|`mint`\|`rename`\|`role`\|`revoke`), `id?` (a key id, `k:` and 12 hex digits), `name?` (1–64), `role?` (`player`\|`admin`\|`observer`) | This room's access keys only. `list`: `data {keys}` as in [`admin/keys`](#104-built-in-views). `mint {name, role?}` (default `player`): `data {id, name, role, key}` — the new key, in this answer and nowhere else, ever. `rename {id, name}`. `role {id, role}`: the holder's live connections end, to come back with the new role. `revoke {id}`: the key stops working and the holder's live connections end; a client redialling with it gets `bad_key`. The room's last admin key cannot be revoked or demoted (`last_admin`); an admin may revoke the key they are connected with while another admin key exists, and is disconnected after the answer. `unknown_key_id` for an id that is not this room's. No event. Text forms: `key [list]`, `key mint [player\|admin\|observer] <name>`, `key rename <id> <name>`, `key role <id> <role>`, `key revoke <id>`; `新建`, `改名`, `角色`, `吊销` too. |
| `panels` | player, observer; `enable`, `disable`: admin | `panels`, `panel` / `panels`, `面板`, `模组面板` | `op` (`list`\|`enable`\|`disable`), `id?` (`<pack>/<panel>`, 1–129) | The panels of the room's enabled packs ([10.6](#106-panels)). Every one is on by default; the admin's switch is a room setting that survives resets. `panel_not_available` for an id no enabled pack has. |

**The session report as a page.** `report` with `format: "html"` answers with a reference to
a file, not with the file: `data.media` is `{hash, mime: "text/html", size, name}`, and the
client fetches it by `hash` over the byte channel ([11.3](#113-get)) and saves it under `name`
or opens it. The page is one self-contained HTML file — no script, nothing loaded from
anywhere — in the caller's language. It is the room's *unlisted* file: no `media` event
announces it and it is in no listing; only the caller is told its hash. The player edition is
made from the event log alone and any member of the room holding the hash may fetch it. The
reveal edition is stored for admins: its hash is `media_not_found` to anyone else. A new page
replaces the room's previous page of the same edition, whose hash stops resolving — fetch a
page when it is offered, do not keep its hash for later.

**Rule-pack commands** depend on the room's rule system. With the built-in systems only `coc7`
has any:

| id | text forms | arguments |
|---|---|---|
| `rules.sanity_check` | `sc`, `sanity` | `success?`, `failure?` (loss notations, 1–100), `tag?` (≤64) |
| `rules.skill_growth` | `en`, `growth` | `skill` |
| `rules.random_madness` | `ti`, `li` | `table?` (1–64) |

### 6.9 Sending a secret

`model` and `imagegen` take API keys, and `key mint` answers with an access key. A client
should send a secret with **`command.run`**, from a field of its own (masked as the person
types), never as a typed line in the place where speech is written: a mistyped command word
makes the line speech, and speech is said at the table as written ([6.3](#63-text-forms)).

The server keeps a secret to the caller either way. These commands publish no event, so a key
reaches neither the table, nor the log (`log.page`), nor the record of commands the Keeper
reads; a refusal carries a code and never the arguments; an answer and `admin/model` show a key
only masked: its first and last four characters (`sk-a...wxyz`), or only stars for one of 16
characters or fewer. The access key `key mint` makes is in that one answer and nowhere else.
A key set from chat is stored in the server's database, which only the server's owner can read.

## 7. The event log

### 7.1 The envelope

```json
{"type":"event","seq":5,"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","ts":1764240000123,"kind":"narrative","turn":2,"data":{"speaker":"kp","text":"The lantern catches, and the quay comes out of the dark.","format":"markdown"}}
```

| field | meaning |
|---|---|
| `seq` | The event's number in the room's log, an integer ≥ 1. Increases in sending order; never reused in the room. |
| `id` | The event's id (a string). A `narrative` event takes the id of the draft it replaces ([9.1](#91-draft)); a `blocks` event with `replace: true` reuses the id of the one it replaces, so ids are not unique in a log. |
| `ts` | Milliseconds since the Unix epoch, server time. |
| `kind` | `narrative`, `dice`, `blocks`, `media`, `rewind` or `reset` ([8](#8-event-kinds)). |
| `turn` | The Keeper turn the event belongs to, when it belongs to one. |
| `data` | The payload of that kind. |

**`turn` is present** on events of a turn: the player's line, its inline rolls, the Keeper's
reply, NPC lines and staging produced for that turn. **It is absent** on turn-less events: a
command's events, a shared file (`media`), `rewind` and `reset`.

### 7.2 What is in the log, and in what order

- Every member receives every event, in `seq` order, as it is appended.
- Events are stored as sent, in the room's language at the time. A replayed event is the
  recorded one: changing the room's language does not rewrite the past.
- `seq` has holes. An undo removes events and their numbers are never handed out again; a reset
  empties the log but `head` stays where it was. Never infer a count from `seq`.
- Turns interleave. A line is logged when it is accepted and numbered then; its reply is
  logged when the Keeper's turn ends. Lines accepted while a turn runs get the next turn
  numbers at once, so the log can read: line of turn 1, line of turn 2, reply of turn 1,
  reply of turn 2.
- Some events of a turn arrive after its `turn idle` signal: the Stage Director's staging (a
  `blocks` event carrying that turn's number) and its `audio` signals come from a pass that runs
  after the turn without holding the room, possibly after later lines have been logged.

### 7.3 Epoch and head

`welcome.epoch` is the room's generation. It starts at 1 and moves by one on every undo, reset
and room import. Within one epoch the log only grows at its end, so a
client resuming by `seq` in the same epoch misses nothing. Across an epoch change the client's
copy of the log is void.

`welcome.head` and every `seq` come from one per-room counter that only rises.

### 7.4 Resume and the replay limit

The replay after a `welcome` is computed from `hello.resume` and the protocol's
`RESUME_LIMIT` = **200**:

- **`resume` present and `resume.epoch == welcome.epoch`:** the events with
  `seq > max(resume.after, head − 200)`.
- **otherwise** (no `resume`, or another epoch): the events with `seq > head − 200`. The
  welcome's epoch tells the client that whatever it holds is void.

So a client that was away for more than 200 events in one epoch receives only the newest
stretch and has a **gap**: every `seq` with `resume.after < seq < head − 199` may hold events it
does not have. Fill it with `log.page`.

### 7.5 Paging: `log.page`

`{"method":"log.page","params":{"before":<seq>,"limit":<1..100>}}` answers
`{events: [...]}`: the newest `limit` events with `seq < before`, **oldest first**, as full
event frames (in the same shape as live events). `limit` defaults to and is at most
`PAGE_LIMIT` = **100**; asking for more is refused (`invalid_params`), not cut to 100. Fewer
than `limit` events back means the log has nothing older. Paged events are history: a
`rewind` or `reset` among them has already been applied by the server and changes nothing
for the client.

### 7.6 Keeping a local log

The reference client (`client.ts`) does this, and a client that keeps a log should do the same:

1. **On `welcome`:** if you hold a log built under another epoch, or one whose newest `seq` is
   above `welcome.head`, discard it. If you hold none, the log is complete when
   `first` is 0 (the room has no events) or `first > head − 200` (its oldest event is within
   the replayed stretch). If you hold one and `head − lastSeq > 200`, record a gap
   `(lastSeq, head − 199)`.
2. **On each event:** insert it by `seq`, ignoring a `seq` you already hold. Apply `rewind` and
   `reset` as described below. Remember the highest `seq` seen, **including events of kinds you
   do not know** (they still occupy a place in the log): that number is `resume.after` next time.
3. **On `rewind {from, kept, epoch}`:** drop every event with `seq ≥ from` except those whose
   `seq` is in `kept`; adopt `epoch` if it is higher than yours. Then keep the `rewind` event
   itself (it is in the log).
4. **On `reset {scope, epoch}`:** drop everything you hold and every draft; adopt `epoch`. The
   `reset` event is the first entry of the new log.
5. **On reconnect:** send `resume {epoch, after: lastSeq}`.

### 7.7 Why an undo can remove from the middle

An undo of turn N keeps every event of turns before N, however late it landed, and removes
every event of turn N and later, together with every turn-less event logged after the first of
them. Because turns interleave, what it removes is not always a suffix: with lines of turns 1
and 2 accepted before either reply, the log is `1 (line, turn 1)`, `2 (line, turn 2)`,
`3 (reply, turn 1)`, `4 (reply, turn 2)`, and undoing turn 2 leaves 1 and 3. The `rewind` event
says exactly that: `{"from":2,"kept":[3],"epoch":2}`. In the common case `kept` is empty.

## 8. Event kinds

A client renders the kinds it knows and skips the others ([12.1](#121-forward-compatibility)).

### 8.1 `narrative`

```json
{"speaker":"player","name":"Ada","member":"m:15b5f3445045","text":"I light the lantern.","format":"plain"}
```

| field | meaning |
|---|---|
| `speaker` | `player` (a member's speech), `kp` (the Keeper), `npc` (a non-player character speaking), `system` (an announcement by the engine, e.g. a new character, a changed setting). |
| `name` | Who speaks: the character (or member) name for `player`, the NPC's name for `npc`. Absent for `kp`; usually absent for `system`. |
| `member` | For `player`: the speaking member's id. |
| `text` | The line. |
| `format` | `markdown` (the Keeper's prose) or `plain` (render verbatim). |

### 8.2 `dice`

One roll or check as the table saw it. It never carries Keeper-only information.

```json
{"actor":"Alice","kind":"check","expr":"1d100","rolls":[19],"total":19,"target":25,"effectiveTarget":25,"outcome":{"id":"regular","label":"Success","success":true,"critical":false,"fumble":false,"tier":2,"margin":6},"detail":{"skill":"Spot Hidden","modifier":0,"modifiers":[],"params":[]}}
```

| field | meaning |
|---|---|
| `actor` | Who rolled: a character or member name. |
| `kind` | `roll` (plain dice), `check` (a graded check), `subsystem` (a rule subsystem such as a sanity roll), `opposed` (a contest), `init` (initiative). |
| `expr` | The notation rolled, in canonical form. |
| `rolls` | The individual results. |
| `total` | The result. |
| `target`, `effectiveTarget` | For a check: the value rolled against, and the value after difficulty and modifiers. |
| `subsystem`, `subsystemLabel` | For `subsystem`: its stable id and its name in the room's language. |
| `outcome` | For a graded roll: see below. |
| `detail` | Extras declared by the rule system (an object). Show them verbatim if you like; never branch on them. A plain roll carries `detail.text`, a readable rendering such as `"2d6 (5, 5) = 10"`. |

**The outcome contract** is neutral to the rule system, so one client renders every system:

| field | meaning |
|---|---|
| `id` | The system's own rank word (`regular`, `hard`, `extreme`, …). Presentation only: never branch on it. |
| `label` | The rank, already in the room's language. Show this. |
| `success`, `critical`, `fumble` | Booleans. Colour by these. |
| `tier` | A number; higher is better. Shade by it if you like. |
| `margin` | Optional: how far above (positive) or below (negative) the target. |

### 8.3 `blocks`

Declarative content set into the story: a module's card, the Stage Director's staging.

```json
{"blocks":[{"kind":"title_card","title":"Act II","subtitle":"The Drowned Quay"},{"kind":"letter","from":"M.","body":"Come alone."}],"replace":true}
```

| field | meaning |
|---|---|
| `blocks` | Up to 256 blocks, rendered in order. |
| `replace` | When `true`, this event updates the earlier `blocks` event with the same event `id` in place (render it where the earlier one was, or replace it; do not show both). |

| block `kind` | fields | render as |
|---|---|---|
| `meter` | `label`, `value`, `min`, `max` | a gauge |
| `stat` | `label`, `value` (number, string or boolean) | a labelled value |
| `badge` | `label`, `tone?` (`info`\|`warn`\|`danger`) | a tag |
| `text` | `text`, `style?` (`quote`\|`warning`) | a paragraph |
| `divider` | — | a rule |
| `choices` | `prompt?`, `options` (≤64 of `{id, label, command, args?}`) | buttons; pressing one is `command.run {id: command, args}` made as the member pressing it |
| `image` | `hash`, `mime?`, `size?`, `caption?`, `alt?` | a picture, fetched by `hash` over the byte channel |
| `letter` | `body`, `from?`, `to?`, `date?` | a letter or note |
| `clipping` | `headline`, `body`, `source?`, `date?` | a newspaper clipping |
| `map_pin` | `hash`, `mime?`, `size?`, `label`, `x`, `y`, `note?` | a pin at (`x`, `y`) on the image `hash` |
| `title_card` | `title`, `subtitle?`, `act?` | a chapter card |

**Fail closed.** A block of an unknown `kind` is skipped and the rest of the event is shown. A
block of a known kind with a missing field, a wrong type or an enumerated value the client does
not know (a `tone`, a `style`) makes the whole event malformed: drop it rather than draw it
wrongly.

### 8.4 `media`

A file shared with the table.

```json
{"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","mime":"image/png","size":48213,"name":"map.png","from":"m:15b5f3445045"}
```

`hash` is the lowercase hex SHA-256 of the bytes, fetched over the byte channel; `from` is the
sharing member's id, or `server`.

### 8.5 `rewind`

```json
{"from":3,"kept":[],"epoch":2}
```

An undo: the log lost every event numbered `from` or higher **except** those whose `seq` is in
`kept`, and the room moved to generation `epoch`. Apply it as in [7.6](#76-keeping-a-local-log).

### 8.6 `reset`

```json
{"scope":"all","epoch":3}
```

The campaign was wiped (`story`: the story; `chars`: the story and the characters; `all`:
everything) or the room was replaced by an import (always `all`). Clear the scrollback and every
draft; adopt `epoch`. Views follow with their new values. A reset of `all` also clears what the
room plays: stop every audio layer (no `audio` signal says so). A lighter reset leaves the music
playing.

## 9. Signals

`{"type":"signal","kind":…,"data":…}`. Signals are sent to every member and are never stored or
replayed. A signal from work of a past generation (a turn cancelled by an undo) is not sent,
except `turn idle`.

### 9.1 `draft`

Streaming text of the Keeper's reply.

```json
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","text":"The lantern catches, "}}
```

```json
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","discard":true}}
```

- `{id, text}` **appends** a slice to the bubble `id`; the first slice for an id opens the bubble,
  shown after the newest event. Slices go out at about 48 characters or at a newline.
- `{id, discard: true}` removes the bubble: the model round turned out to call tools, or the
  provider retried. A retry streams again under a new id.
- The `narrative` event with the same `id` **replaces** the bubble. The event is authoritative;
  a draft can show less than the event, never more (text that might belong to a hidden block is
  held back and may be dropped).
- On `turn idle`, drop every bubble still open: a turn that failed or was cancelled by an undo
  does not always discard its drafts.
- A draft for an id whose `narrative` event you already hold is stale: ignore it.

### 9.2 `turn`

```json
{"type":"signal","kind":"turn","data":{"status":"busy","actor":"Ada"}}
```

```json
{"type":"signal","kind":"turn","data":{"status":"idle"}}
```

`busy` means the Keeper is working on a turn; `actor` is the name of whoever's line it answers.
`idle` means it finished (replied, failed or was cancelled). Treat `busy` as a state, not an
event. A member who connects while a turn is running is sent `busy` right after the replay. The protocol also defines two optional
`busy` fields, `activity` (`reading`\|`dice`\|`cast`\|`bookkeeping`, presentation only: an
unknown value is ignored) and `round` (an integer); the 3.0 server does not send them.

### 9.3 `notice`

An out-of-band line for the table, in the room's language.

```json
{"type":"signal","kind":"notice","data":{"level":"warn","code":"provider_transient","text":"The AI provider is still temporarily unavailable after retrying. Please try again shortly."}}
```

| field | meaning |
|---|---|
| `level` | `info` or `warn`. |
| `code` | Optional, stable. Sent today: `turn_failed`, `reply_blocked`, `provider_auth`, `provider_quota`, `provider_transient`, `provider_content`, `unavailable`. |
| `text` | Show it. |
| `spinner` | Optional boolean (a long operation under way). Not sent by the 3.0 server. |

### 9.4 `audio`

A playback **transition**; the bytes are fetched by `hash` over the byte channel
([11.3](#113-get)). What each layer plays NOW is the `audio` view ([10.4](#104-built-in-views)).

```json
{"type":"signal","kind":"audio","data":{"id":"01J…","action":"play","layer":"bgm","sound":"harbor/rain","hash":"3f9a…","mime":"audio/ogg","size":48213,"title":"Rain on the quay","loop":true,"volume":0.8,"fadeMs":1500}}
```

| field | meaning |
|---|---|
| `id` | This signal's own id. |
| `action` | `play`, `stop`, `pause`, `resume`, `volume`. |
| `layer` | `bgm`, `ambience` or `sfx`. `bgm` and `ambience` hold one sound each and loop by default; `sfx` is one-shot: each `play` sounds once, beside the others. |
| `sound` | The library id of the sound (`<pack>/<cue>`, or an upload's hash): on `play`, and on a transition of a `bgm` or `ambience` layer, the sound it acts on. |
| `hash`, `mime`, `size` | `play` only: the sound to fetch, and its size in bytes. |
| `title` | `play` only, optional: for display. |
| `loop` | `play` only. |
| `volume` | `play` and `volume`: 0 to 1. |
| `fadeMs` | Optional: fade over this many milliseconds (at most 60,000). |

**The view is the state, the signal is the transition.** A client:

1. on every connect (and reconnect), subscribes to `audio` and starts what `playing` says: each
   layer's sound at its `volume`, looping as `loop` says, paused when `paused`;
2. afterwards follows the signals: `play` replaces what the layer plays (`sfx`: sounds once),
   `stop` ends it, `pause` / `resume` hold and continue it, `volume` changes it — over `fadeMs`
   when given;
3. takes the view as the truth whenever they could disagree: after a reconnect (signals are not
   replayed), and after a `reset` of `all` (which stops every layer, [8.6](#86-reset)).

The signals come from two places, through one path that moves the room's state with each
signal: the admin's `bgm`, `ambience` and `sfx` commands (and an `audio remove` or a
`pack disable` stopping what played the sound), and the Stage Director's pass after a turn (a
pack's cue, [7.2](#72-what-is-in-the-log-and-in-what-order)). An undo does not change what
plays and sends no `audio` signal.

## 10. Views

### 10.1 The model

A view is a named, structured value computed for one viewer: the member, their role, their
language and the character they play. Names and labels in it are in the **viewer's** language;
ids are never translated. A client subscribes to the views it wants; the server sends a view's
current value at once and then whenever that value changes for this viewer. Each update carries
the whole value.

```json
{"type":"view","name":"room","rev":1,"at":2,"data":{"locale":"en","localeLabel":"English","system":{"id":"coc7","label":"CoC"},"variant":null,"keeperMuted":false,"uploads":true}}
```

| field | meaning |
|---|---|
| `name` | The view's name. |
| `rev` | Counts per connection per view name and only grows: one rev never names two different values. It survives an unsubscribe on the same connection, and starts again on a new connection. Keep the value with the highest rev from the current connection. |
| `at` | The log `head` the value reflects. |
| `data` | The value. |

The server recomputes subscribed views after every Keeper turn, every command, every
lifecycle command, the pass after a turn, and whenever a member joins or leaves (presence is
part of `party`), and sends only the values that changed. A line of speech by itself does not
refresh views.

### 10.2 Subscribing

- **`view.list`** answers the views this connection may subscribe to, each with its JSON Schema
  (and a module view's `title`).
- **`view.subscribe {names}`** answers `{problems: [{name, code}]}` first, then sends the current
  value of each newly subscribed view as a `view` frame. A name already subscribed is not sent
  again. Problem codes: `unknown_view` (no such view, or one this connection may not see),
  `too_many_views` (more than 64 subscriptions on one connection), `too_large`, `view_failed`.
- **`view.unsubscribe {names}`** answers `{removed: [...]}`: the names that were subscribed.
- **`view.get {name}`** answers `{name, rev, at, data}`: the view recomputed now, whether or not
  the connection is subscribed. The rev moves only when the value differs from the last one sent
  under that name, so an unchanged value comes back under its old rev.

Subscriptions belong to the **connection** and die with it. After a reconnect, subscribe again
(the reference client keeps a wanted set and re-subscribes on every welcome).

One call names at most `MAX_VIEW_NAMES` = 64 views; a connection holds at most 64
subscriptions; a view name is at most 200 code points; a value over 512 KiB (as compact JSON)
is not sent (`too_large`; the last value sent stands).

### 10.3 Who sees what

Every built-in view is computed per viewer from the server's per-viewer projections: a player
sees what a player may see, an admin also sees what is hidden from players (marked
`hidden: true` where a view carries such entries), an observer sees what the table sees. Several
connections of one member with the same role, language and character share one computation.
When a member's character or role changes, the next refresh computes for the new viewer.

Views named `admin/…` are for admins alone. Anyone else is never sent one, not even empty:
`view.list` does not list them, `view.subscribe` answers `unknown_view` for them, and
`view.get` refuses them.

### 10.4 Built-in views

The JSON Schemas are in the protocol package (`BUILT_IN_VIEW_SCHEMAS`) and in `view.list`.

**`me`**: the viewer and the character they play.

| field | type | meaning |
|---|---|---|
| `member` | `{id, name, role, roleLabel}` | `roleLabel` is the role in the viewer's language. |
| `character` | object or `null` | `null` for a spectator (no character). |
| `character.id`, `.name`, `.pack` | string | `pack` is the character's rule system id. |
| `character.status` | string[] | Conditions. |
| `character.resources` | `[{id, label, value, max}]` | Meters such as HP and sanity. |
| `character.attributes`, `.skills` | `[{key, label, value}]` | `value` is a number or a string. Filled only when the sheet is the viewer's own. |

**`party`**: who is at the table, what they play, and the fight's order.

| field | type | meaning |
|---|---|---|
| `members` | `[{id, name, role, online, character}]` | Members online, then seated members who are not. `role` is `null` for one who is offline; `character` is a character id or `null`. |
| `characters` | `[{id, name, pack, status, resources, player}]` | Every seated character, and any other the room keeps that is not on offer (a companion). `player` is `{id, name}` or `null`. |
| `initiative` | `{round, acting, order: [{name, value}]}` or `null` | `null` while no fight is on. `acting` is a name or `null`. |

**`scene`**: what the table is looking at, and the time.

| field | type | meaning |
|---|---|---|
| `name`, `focus` | string | Empty strings when unset. |
| `established` | `[{text, at}]` | Facts established in the scene; `at` is a time text or `null`. |
| `time` | string or `null` | The clock's text. |
| `clockModule` | string or `null` | The module that keeps the clock; `null` when the Keeper does. |
| `round` | integer or `null` | The combat round while a fight is on, else a module clock's round, else `null`. |

**`variables`**: the room variables this viewer may see.

| field | type | meaning |
|---|---|---|
| `module` | `[{id, kind, label, value, valueLabel?, min?, max?, options?, hidden?}]` | Declared variables. `kind` is `number`, `bool`, `text` or `enum`; `value` a number, boolean or string. |
| `tree` | `[{path, value, description?, hidden?}]` | Leaves of the imported variable tree; `value` is a scalar or a list of scalars. |

A player sees only player-visible variables and exposed leaves; an admin sees all of them, the
ones players do not see marked `hidden: true`.

**`characters`**: what can be played.

| field | type | meaning |
|---|---|---|
| `claimable` | `[{id, name, blurb, source: {kind, id}, player}]` | Characters on offer; `source.kind` is `pack` or `module`; `player` is `{id, name}` of whoever plays it, or `null`. |
| `systems` | `[{id, label, active}]` | Rule systems that can make a new character; `active` marks the room's. |
| `mine` | string or `null` | The id of the character the viewer plays. |

**`commands`**: `{commands: [entry]}`, the command table for this viewer
([6.5](#65-discovering-commands-the-commands-view)).

**`room`**: the room's settings.

| field | type | meaning |
|---|---|---|
| `locale`, `localeLabel` | string | The room's language and its name in the viewer's language. |
| `system` | `{id, label}` or `null` | The active rule system. |
| `variant` | string or `null` | The house-rule ladder within it; `null` for the default. |
| `keeperMuted` | boolean | The Keeper does not answer while `true`. |
| `uploads` | boolean | Whether members may upload files. `false` on a server that keeps no files. |

**`usage`**: the token figures of the room's last Keeper turn.

| field | type | meaning |
|---|---|---|
| `last` | object or `null` | `null` before the first turn (and after a story reset). |
| `last.turn` | integer | The turn. |
| `last.inputTokens`, `.outputTokens`, `.cachedInputTokens`, `.cacheWriteTokens`, `.reasoningTokens` | integer | As the provider reported them, summed over the turn. |
| `last.estimated` | boolean | The prompt size was estimated by the engine: the provider reported none. |

**`packs`**: the content packs, by name.

| field | type | meaning |
|---|---|---|
| `packs` | `[{id, version, name, enabled, cards: [{file, name, kind}]}]` | An admin sees every installed pack, each with whether this room enabled it; anyone else the packs this room enabled. `kind` is `world` or `character`. |

**`panels`**: this viewer's panel list ([10.6](#106-panels)).

| field | type | meaning |
|---|---|---|
| `panels` | `[entry]` | The panels of the room's enabled packs that are switched on and listed to this viewer, in the order the packs were enabled, then as each pack declares them. |
| `entry.id` | string | `<pack>/<panel>`. |
| `entry.title` | string | In the viewer's language. |
| `entry.slot` | string | `sidebar`, `tray` or `modal`. A text client may fold all three into its sidebar. |
| `entry.kind` | string | `template` or `page`. |
| `entry.views` | `[{as, view}]` | The views the panel reads, each under the handle its paths use. Subscribe to every `view`. |
| `entry.source` | `{kind, id}` | `kind` is `pack` (the only source in 3.0; `room` is reserved for panels a room publishes itself). |
| `entry.blocks` | `[template block]` | A template's blocks. |
| `entry.page` | `{hash, size, mime}` | A page's HTML (`mime` is `text/html`), fetched by hash over the byte channel ([11.3](#113-get)). |
| `entry.fallback` | `[template block]` or `null` | A page's template for a client that cannot run it; `null`: show one "needs a rich client" line. |

**`audio`**: the room's audio library and what each looping layer plays ([9.4](#94-audio)).

| field | type | meaning |
|---|---|---|
| `library` | `[sound]` | The sounds the room's admin uploaded with `purpose: "audio"` (oldest first), then the audio cues of the room's enabled packs. |
| `sound.hash`, `.mime`, `.size` | string, string, integer | What fetching it over the byte channel needs ([11.3](#113-get)): every viewer gets these, to prefetch. A non-admin gets each file once and nothing else. |
| `sound.id` | string | Admin only. The library id: `<pack>/<cue>` for a pack's cue, the hash for an upload. What `bgm`/`ambience`/`sfx` take as `query`. |
| `sound.title` | string | Admin only. |
| `sound.layer` | string or `null` | Admin only. `bgm`, `ambience` or `sfx`: the layer it is meant for (an upload's is `null` until the admin sets it). |
| `sound.tags` | string[] | Admin only. |
| `sound.source` | `{kind, id}` | Admin only. `kind` `upload` (`id` `null`) or `pack` (`id` the pack). |
| `playing` | `{bgm?, ambience?}` | What each looping layer plays; a layer with nothing playing is absent. `sfx` is never here. |
| `playing.<layer>` | `{id, title, hash, mime, size, loop, volume, paused}` | The sound (its library id, title and what fetching it needs), whether it loops, its volume (0 to 1), and whether it is paused. For every viewer. |

A player sees only what fetching needs because a sound's name is content: a pack's cue titles and
an admin's uploads may tell the story before the table hears it. What plays is named for
everyone.

**`admin/model`** (admins only): what each model lane and image generation use now. Server-wide:
it changes for every room's admins when one of them runs `model` or `imagegen`.

| field | type | meaning |
|---|---|---|
| `lanes` | `[lane]` | `keeper`, `npc`, `scribe`, `director`, `memory` (the chronicle fold), in that order. |
| `lane.source` | string | `override` (an admin set it), `environment` (the server's own settings), `default` (nothing set: for the Keeper, no model; for another lane, it uses the Keeper's). |
| `lane.sameAsKeeper` | boolean | The lane uses the Keeper's client. |
| `lane.provider`, `.model`, `.baseUrl`, `.wire`, `.effort` | string or `null` | `provider` is a preset id or an admin's name for an endpoint; `null` for an endpoint the server's settings name by address only. `wire` is `openai-compatible`, `anthropic` or `openai-responses`. |
| `lane.contextWindow` | integer or `null` | In tokens; `null` when unknown. |
| `lane.key` | `{set, masked}` | Whether a key is set, and its masked form (`null` when none). Never the key. |
| `providers` | `[{id, preset, wire, baseUrl, credential}]` | The presets this server knows, then the endpoints admins saved under a name of their own; `credential`: a key is saved for it (or the server's settings have one). |
| `imagegen` | `{source, enabled, provider, model, size, baseUrl, key}` | Image generation; `source` as for a lane (an `override` with `enabled: false` is `imagegen off`). |
| `imageProviders` | `[{id, credential}]` | `openai`, `xai`, then saved names. |

**`admin/keys`** (admins only): this room's access keys. Never another room's.

| field | type | meaning |
|---|---|---|
| `keys` | `[{id, name, role, masked, created?, online}]` | `id` is what the `key` command takes, never the key. `masked` is the key's first and last characters. `created` (ms) is absent for a key minted before this was recorded. `online`: someone is connected with it now. Refreshed when keys change and when members connect or leave. |

**`admin/content`** (admins only): what this room can use and has on.

| field | type | meaning |
|---|---|---|
| `skills` | `[{id, title, enabled, source}]` | The Keeper's skills this room may enable (the built-in ones and those of its enabled packs). |
| `ruleSystems` | `[{id, title, enabled, source}]` | The server's rule systems; `enabled` marks the room's. |
| `packs` | `[{id, title, version, enabled}]` | The installed packs; `enabled`: this room enabled it. |
| `source` | `{kind, id}` | `kind` `builtin` (`id` `null`) or `pack` (`id` the pack). |

### 10.5 Module views

A module may publish views named `<module>/<name>`, each with the JSON Schema and title its
module declared (listed by `view.list`). The module computes each value per viewer and the
server forwards it unfiltered, to that viewer only; a value over 512 KiB is dropped. Their
shapes are the module's; a client that does not know a module view renders it generically or
not at all. Names starting `admin/` are reserved and never offered by a module.

### 10.6 Panels

A panel is persistent UI beside the story, shipped by a pack ([LWF panels](lwf/formats/panels.md)).
Its data comes **only from views**: there is no panel frame. A client:

1. subscribes to `panels`, and to every view an entry names in `views`;
2. for a `template`, calls `instantiate({views, blocks}, values)` — `values` being each
   view's data by name — and draws the resulting blocks (the same `Block` vocabulary as a
   `blocks` event, [8.3](#83-blocks)); for a `page`, runs the HTML in a sandboxed frame if it
   can, else instantiates the `fallback`, else shows one "needs a rich client" line;
3. sends a `choices` option, and anything a page does, as `command.run {id: command, args}`
   ([6.2](#62-two-entrances)), as the member viewing the panel.

A template block is a `Block` whose fields may be **bindings**, `{"$view": "<path>"}`, plus
`visible_when` (a condition) on any block and the construct
`{"repeat": {"each": "<path>", "as": "<handle>", "prefix"?: "…", "block": <block>}}`.
A path is `<handle>.<segment>…`: the handle is one of the entry's `views[].as` (or, inside a
repeat, its `as`); a segment names a record's property, a list's element by index, or a
list's element by its `id`/`key`/`path`. Elements flagged `hidden` are never read. A binding
that does not resolve drops its block (required field) or field (optional field); a condition
that cannot be decided hides its block. The grammar, the caps and the full rules are the LWF
panels document §4–§6; the protocol package's `instantiate`, `panelBlocks` and
`panelViewNames` implement them, and its `panels.vectors.json` is the table every
implementation must match.

```json
{"type":"view","name":"panels","rev":1,"at":12,"data":{"panels":[{"id":"harbor/tide","title":"The tide","slot":"sidebar","kind":"template","views":[{"as":"tide","view":"harbor/tide"}],"source":{"kind":"pack","id":"harbor"},"blocks":[{"kind":"meter","label":"Tide","value":{"$view":"tide.level"},"min":0,"max":10},{"kind":"text","text":"Flood warning!","style":"warning","visible_when":"tide.level >= 8"}]}]}}
```

Which panels a member is listed is the server's decision: a panel the pack restricts to
admins, or one that reads an `admin/*` view, is never in a player's `panels`. A page's HTML
and a panel's pictures are the room's unlisted media: fetchable by the room's members (an
admin-only page by its admins), listed nowhere, and unknown to every other room.

## 11. The byte channel

### 11.1 Streams

Files move on their own streams beside the control stream. Each operation is one new
bidirectional stream on the same connection: the client writes **one header line** (compact
JSON and `\n`), the server answers with one header line and, for a GET, the bytes; then the
server finishes the stream.

- At most `MAX_BYTE_STREAMS` = **4** byte streams open at once per connection (the control
  stream not counted); a fifth is refused with `too_many_streams`.
- A header line is at most `MAX_BYTE_HEADER_BYTES` = **2048** bytes, newline included
  (`header_too_long`).
- A stream on which nothing arrives for `BYTE_STALL_MS` = **30 s** is closed (`stalled`).
- The connection must have been welcomed (`not_open` otherwise, and after the session ends).
- A refused stream gets one error line and is closed. The connection and its control stream
  are never affected.

Content is addressed by **hash**: the lowercase hex SHA-256 of the bytes, exactly 64
characters.

### 11.2 Offering a file

An upload starts on the control stream with `call media.offer`:

| param | type | meaning |
|---|---|---|
| `name` | string | The file name, at most 255 code points (stored sanitised). |
| `mime` | string | The file's type (at most 128 characters). |
| `size` | integer | Bytes, greater than 0. |
| `sha256` | string | The lowercase hex SHA-256 of the bytes. |
| `purpose` | `share` (default), `import` or `audio` | `share`: the file becomes room media and the table sees a `media` event once the bytes arrive. `import`: a card file for the `import` command ([11.6](#116-importing-a-card)), stored where only admins can fetch it, announced to nobody. `audio` (admins only, sounds only): a sound for the room's audio library, fetchable by every member, announced by no event; it joins the `audio` view's library ([10.4](#104-built-in-views)) under its file name without the extension as title. |

A success answers one of:

- `{"upload_id":"…"}`: send the bytes with a PUT ([11.4](#114-put)). The id is good for one
  attempt, by this member, within 15 minutes.
- `{"existing":{hash, mime, size, name, from}}`: the room already holds these bytes; send
  nothing. For a `share`, the file is announced to the table again (a new `media` event, `from`
  the offering member). For an `import`, the file is ready for the `import` command. For an
  `audio`, the sound is in the library (it already was, or the room held these bytes as a file
  every member may fetch).

Accepted types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml` (a
restricted subset), `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/flac`, `audio/mp4`,
`audio/aac`. For `purpose: "import"` only `image/png` (a card with the data embedded) and
`application/json`; for `purpose: "audio"` only the `audio/…` types.

Default limits: an image at most 8 MiB and 512 MiB of images per room; a sound at most
128 MiB and 2048 MiB of sounds per room (the operator sets these two); 10 offers per member per
room per minute (a refused offer still spends one); 100 uploaded sounds in a room's audio
library.

Refusals: `invalid_params` (a field of the wrong shape), `media_unavailable` (the server keeps
no files), `observer_upload`, `forbidden` (`audio` from a non-admin), `audio_library_full`,
`media_disabled` (the room's upload switch is off),
`media_rate_limited`, `media_bad_mime`, `media_bad_offer`, `media_too_large`, `media_bad_hash`,
`media_quota_exceeded`.

### 11.3 GET

```
client: {"op":"get","hash":"<64 hex>"}\n
server: {"op":"get","ok":true,"hash":"…","size":<n>,"mime":"…","name":"…"}\n  then exactly <n> bytes
```

A member can fetch what the room holds under an audience its role may see: room media (shared
files, staging pictures), the audio library's sounds and the files of the room's enabled packs
for everyone (what only an admin-only panel names, for admins); import files for admins. A hash in another room, one the
role may not see and one nobody holds all answer the same: `media_not_found`.

### 11.4 PUT

```
client: {"op":"put","upload_id":"<id>"}\n  then exactly the offered size in bytes, then it finishes its side of the stream
server: {"op":"put","ok":true,"hash":"…","size":<n>,"mime":"…","name":"…"}\n
```

The client **must finish its sending side** after the body: the server confirms the end of the
body by reading the end of the stream, and a stream left open is closed as `stalled`. The bytes
are checked (exact size, SHA-256, the declared type's file signature, the SVG subset) before
anything is stored. For a `share`, the `media` event goes to the table before the PUT's answer
line.

PUT refusals: `media_unknown_upload` (no waiting offer with that id for this member: never
made, expired, already used, or the room was cleared), `media_size_mismatch` (more or fewer
bytes than offered), `media_hash_mismatch`, `media_bad_signature`, `media_bad_svg`,
`media_quota_exceeded`, `media_disabled`, `media_bad_upload`, `media_storage_failed`,
`audio_library_full` (another upload filled the library meanwhile; the bytes are not kept). Any
failed PUT uses the offer up: offer again.

### 11.5 Errors

```
server: {"ok":false,"code":"<stable code>","message":"<in the member's language>"}\n
```

The channel's own codes: `bad_request` (the header is not a request this channel knows),
`header_too_long`, `too_many_streams`, `stalled`, `not_open`, `byte_failed` (the server
failed; nothing was kept); plus the media codes above.

### 11.6 Importing a card

A card (a SillyTavern character card as PNG or JSON, or a native card as JSON) is brought in
two steps: upload it with `media.offer {purpose: "import"}` (and a PUT when the answer is an
`upload_id`), then run `command.run import {file: <hash>, as: "character"|"world"}`. Only the
member who uploaded a file can import it (`not_uploaded` otherwise). As `character` any player
makes it their character; as `world` (admin only) it becomes the room's world, and the table
hears one `narrative` line naming it.

## 12. Behaving well

### 12.1 Forward compatibility

Minor versions within a major are additive. A client:

- **ignores** a frame of an unknown `type`, an event of an unknown `kind` (but counts its `seq`,
  [7.6](#76-keeping-a-local-log)), a signal of an unknown `kind`, and a block of an unknown
  `kind` (showing the rest of its event);
- **ignores unknown fields** everywhere;
- **fails closed** on a field that gates rendering: a known field with a value this version does
  not know (a `speaker`, a `format`, a dice `kind`, a `role`, a reset `scope`, an audio `action`
  or `layer`, a notice `level`, a block's `tone` or `style`), or a known field of the wrong type,
  makes the frame malformed, and a malformed frame is dropped, not drawn wrongly. The one
  exception is `turn.activity`, which is presentation only: an unknown value is left out;
- **caps** what it accepts and drops a frame over a cap rather than truncating it. The reference
  decoder (`decode.ts`) uses: 256 characters for short strings (ids, codes, names, view names,
  locales, hashes), 200,000 for texts (a narrative, a draft slice, a notice, a result's text, a
  block's body), 1024 for a dice expression, 10,000 dice per roll, 256 blocks per event, 64
  options per `choices` block, 1000 events per `log.page` answer, 4096 entries in a rewind's
  `kept`;
- passes opaque values through: `view.data` of module views, `result.data`, a dice `detail`.

Built-in view values are checked against their schemas, but extra fields are allowed: a newer
server may add fields to a view.

### 12.2 Languages

| what | language |
|---|---|
| events and signals (everything sent to the table) | the room's (`welcome.room.locale`; the `room` view after a change) |
| `result` text and error messages, `error` frames, byte-channel errors | the member's (`hello.locale`) |
| views | the viewer's (`hello.locale`) |

### 12.3 Text from the server

Every string comes from people, the Keeper, a module or a card. Render it as text. Strip
terminal control characters before writing to a terminal: `loreweaver-protocol/v3` exports
`stripControlChars` for that. `format: "markdown"` is the only text the server marks as Markdown.

### 12.4 Limits

| limit | value | where |
|---|---|---|
| `input.text` | 8000 code points | `MAX_INPUT_CHARS` |
| `hello.name` | 64 code points | server |
| `rid` | 1–64 characters | `frames.ts` |
| `command.run` `id` | 200 code points | server |
| text-command argument string | 4000 code points | server |
| inline rolls per line | 8 | server |
| string argument (default) | 4000 code points | parameter schema |
| list argument (default) | 64 items | parameter schema |
| replay after `welcome` | 200 events | `RESUME_LIMIT` |
| `log.page` `limit` | 1–100 | `PAGE_LIMIT` |
| names per `view.subscribe` / `view.unsubscribe` | 64 | `MAX_VIEW_NAMES` |
| subscriptions per connection | 64 | server |
| view name | 200 code points | server |
| view value | 512 KiB | server |
| requests (`input`, `command.run`) | burst 5, then one per 2 s per member | server default |
| byte streams per connection | 4 | `MAX_BYTE_STREAMS` |
| byte header line | 2048 bytes | `MAX_BYTE_HEADER_BYTES` |
| byte stream stall | 30 s | `BYTE_STALL_MS` |
| `upload_id` | 64 characters | `MAX_UPLOAD_ID_CHARS` |
| offered file name | 255 code points | `MAX_OFFER_NAME_CHARS` |
| offers | 10 per member per room per minute | server default |
| reset confirmation window | 60 s | server |
| model ids in a `model list` answer | 500, each ≤ 200 code points | server |
| `model list` wait for the provider | 15 s | server |

### 12.5 Result error codes

The protocol-level codes a `result` may carry (command refusals are in [6.4](#64-refusals),
upload refusals in [11.2](#112-offering-a-file)):

| code | from |
|---|---|
| `input_too_long` | `input` over 8000 code points |
| `invalid_params` | a `call` whose `params` (or a field of it) has the wrong shape |
| `unknown_method` | a `call` of a method the server does not have |
| `rate_limited` | `input`, `command.run` |
| `observer_speech` | an observer's line of speech |
| `unknown_view`, `view_failed`, `too_large`, `not_open` | `view.get` |
| `command_failed` | the server failed running a command; nothing was changed |

## 13. Example sessions

### 13.1 A table session

Every line below is one frame exactly as it crosses the wire (whitespace aside). The room
`main` speaks English, plays with the `coc7` rule system, and already holds two events: Bao
said something and the Keeper answered.

**1. Ada says hello.** A first visit: no `resume`.

```json
{"type":"hello","protocol":"3.0","key":"rT9vQ2xLm8Kc3PzW0aYbN5sEdF7gHjU1","name":"Ada","locale":"en","client":{"name":"my-client","version":"0.1.0"},"caps":[]}
```

**2. The welcome, then the replay** of the two events (`head` is 2, under the replay limit, so
this is the whole log).

```json
{"type":"welcome","protocol":"3.0","server":{"name":"loreweaver","version":"3.0.0-alpha.0"},"room":{"id":"main","locale":"en"},"you":{"id":"m:15b5f3445045","name":"Ada","role":"player"},"features":[],"epoch":1,"head":2,"first":1}
{"type":"event","seq":1,"id":"2c1f8e7a-6b5d-4c3e-9f2a-1b0c9d8e7f6a","ts":1764240000001,"kind":"narrative","turn":1,"data":{"speaker":"player","name":"Bao","member":"m:b40a5aaa35ea","text":"I wait by the quay.","format":"plain"}}
{"type":"event","seq":2,"id":"7d6e5f4a-3b2c-4d1e-8f9a-0b1c2d3e4f5a","ts":1764240002410,"kind":"narrative","turn":1,"data":{"speaker":"kp","text":"The fog thickens.","format":"markdown"}}
```

**3. Ada subscribes to two views.** The answer comes first, then one `view` frame per view.
Ada has no character yet, so `me.character` is `null`.

```json
{"type":"call","rid":"r1","method":"view.subscribe","params":{"names":["me","room"]}}
{"type":"result","rid":"r1","ok":true,"data":{"problems":[]}}
{"type":"view","name":"me","rev":1,"at":2,"data":{"member":{"id":"m:15b5f3445045","name":"Ada","role":"player","roleLabel":"Player"},"character":null}}
{"type":"view","name":"room","rev":1,"at":2,"data":{"locale":"en","localeLabel":"English","system":{"id":"coc7","label":"CoC"},"variant":null,"keeperMuted":false,"uploads":true}}
```

**4. A line of speech with an inline roll.** The line is accepted at once: its `narrative`
event (turn 2) and the inline roll's `dice` event are published, then Ada's result arrives.
The Keeper's turn follows: `busy`, two draft slices, the `narrative` event that replaces them
(same id), `idle`.

```json
{"type":"input","rid":"r2","text":"I light the lantern. [[1d6]]"}
{"type":"event","seq":3,"id":"5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b","ts":1764240010000,"kind":"narrative","turn":2,"data":{"speaker":"player","name":"Ada","member":"m:15b5f3445045","text":"I light the lantern. [[1d6]]","format":"plain"}}
{"type":"event","seq":4,"id":"0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d","ts":1764240010001,"kind":"dice","turn":2,"data":{"actor":"Ada","kind":"roll","expr":"1d6","rolls":[6],"total":6,"detail":{"text":"1d6 (6) = 6","inline":true}}}
{"type":"result","rid":"r2","ok":true}
{"type":"signal","kind":"turn","data":{"status":"busy","actor":"Ada"}}
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","text":"The lantern catches, "}}
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","text":"and the quay comes out of the dark."}}
{"type":"event","seq":5,"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","ts":1764240014820,"kind":"narrative","turn":2,"data":{"speaker":"kp","text":"The lantern catches, and the quay comes out of the dark.","format":"markdown"}}
{"type":"signal","kind":"turn","data":{"status":"idle"}}
```

**5. One command, both entrances.** Typed, then structured: the same command, the same shape
of outcome. Each puts a turn-less `dice` event in the log and answers Ada with the totals. No
Keeper turn opens.

```json
{"type":"input","rid":"r3","text":".r 2d6"}
{"type":"event","seq":6,"id":"3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f","ts":1764240020000,"kind":"dice","data":{"actor":"Ada","kind":"roll","expr":"2d6","rolls":[5,5],"total":10,"detail":{"text":"2d6 (5, 5) = 10"}}}
{"type":"result","rid":"r3","ok":true,"data":{"totals":[10]}}
{"type":"call","rid":"r4","method":"command.run","params":{"id":"roll","args":{"expr":"2d6"}}}
{"type":"event","seq":7,"id":"8f7e6d5c-4b3a-4f2e-9d1c-0b9a8f7e6d5c","ts":1764240025000,"kind":"dice","data":{"actor":"Ada","kind":"roll","expr":"2d6","rolls":[3,4],"total":7,"detail":{"text":"2d6 (3, 4) = 7"}}}
{"type":"result","rid":"r4","ok":true,"data":{"totals":[7]}}
```

**6. Ada tries to undo.** `undo` is an admin command: the refusal is Ada's alone.

```json
{"type":"input","rid":"r5","text":".undo"}
{"type":"result","rid":"r5","ok":false,"error":{"code":"forbidden","message":"That is for the room admin."}}
```

**7. The admin undoes the last turn.** On the admin's connection:

```json
{"type":"call","rid":"a1","method":"command.run","params":{"id":"undo","args":{}}}
```

Every member, Ada included, receives the `rewind`. It removes everything from `seq` 3 on: turn
2 (the line, its roll and the reply) and the two rolls that came after turn 2 began. The room is
now in epoch 2.

```json
{"type":"event","seq":8,"id":"6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d","ts":1764240030000,"kind":"rewind","data":{"from":3,"kept":[],"epoch":2}}
```

The admin's own answer:

```json
{"type":"result","rid":"a1","ok":true,"text":"Rewound 1 turn(s); the room is back at the end of turn 1.","data":{"turn":1,"epoch":2,"removedTurns":[2]}}
```

Ada's log now holds `seq` 1, 2 and 8. If she reconnects with
`"resume":{"epoch":1,"after":8}`, the welcome says `"epoch":2`: she discards her log and takes
the replay afresh.

### 13.2 The byte channel

Ada shares a 48,213-byte PNG. On the control stream:

```json
{"type":"call","rid":"r6","method":"media.offer","params":{"name":"map.png","mime":"image/png","size":48213,"sha256":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"}}
{"type":"result","rid":"r6","ok":true,"data":{"upload_id":"c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a"}}
```

On a new stream, the PUT header, then the 48,213 bytes, then Ada finishes her side:

```json
{"op":"put","upload_id":"c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a"}
```

The table (Ada included) sees the file arrive on the control stream:

```json
{"type":"event","seq":9,"id":"e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b","ts":1764240040000,"kind":"media","data":{"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","mime":"image/png","size":48213,"name":"map.png","from":"m:15b5f3445045"}}
```

and the PUT stream answers, then closes:

```json
{"op":"put","ok":true,"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","size":48213,"mime":"image/png","name":"map.png"}
```

Bao fetches it on a stream of his own; the answer line is followed by exactly 48,213 bytes:

```json
{"op":"get","hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"}
{"op":"get","ok":true,"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","size":48213,"mime":"image/png","name":"map.png"}
```

A hash the room does not hold (or one Bao may not see):

```json
{"ok":false,"code":"media_not_found","message":"No such file."}
```

## 14. Not in 3.0 yet

These are defined in the design, or reserved in the code, but not built in 3.0:

- **`features` and `caps` values.** Both lists exist; the server sends `features: []` and
  ignores `caps`.
- **Running pages.** The `panels` view lists pages and the byte channel serves their HTML;
  no reference client runs one yet (the terminal client shows the fallback). The page bridge
  is the desktop client's to define. Panels a room publishes at runtime (`source.kind:
  "room"`) are reserved: no server produces them.
- **`turn.activity`, `turn.round` and `notice.spinner`** are defined in the frames but not sent.
