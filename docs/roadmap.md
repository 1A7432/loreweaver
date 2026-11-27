*English · [中文](roadmap.zh.md)*

# Loreweaver roadmap

Loreweaver is young and built largely by one person with AI assistance. This is the honest forward plan — what the 3.0 rewrite has done, what it has not done yet, and one design question we argued in the open and then closed. For the layer contracts and iron rules, see [AGENTS.md](../AGENTS.md).

## The ambition

The goal is not "an AI stand-in for a game master" — it is to be **the engine and the open standard
for AI-run tabletop RPGs**. Powerful coding agents are everywhere; competent RPG agents barely
exist, and the formats a world would need to travel in do not exist at all. Every layer here — real
dice and hard rules, a Keeper that acts through tool calls, sub-actors that know only what they
should, an extension ecosystem growing along SKILL.md and SillyTavern conventions — points the same
way: making "running a world well" a first-class agent capability, on formats nobody has to ask
permission to use.

## Where things stand: 3.0

3.0 rebuilds Loreweaver on Bun in strict TypeScript, as a new project: a new wire protocol (3.0),
with no compatibility with 2.x on the wire, in the room database, or in pack and module formats.
SillyTavern card import carried over. The 2.x Python server has been removed from this branch.
What the rewrite has in place:

- **One workspace.** The server, the module SDK, the protocol package and the terminal client are one
  Bun workspace. The server compiles into a single file whose own self-test runs a real turn over a
  scripted model, and CI builds and self-tests that file on Linux (x64 and arm64), macOS and Windows.
- **A protocol with one description.** [docs/protocol.md](protocol.md), written from the code: a
  numbered event log with generations (undo, reset and import move the room to a new one), views the
  server keeps current for each viewer, one command table for the engine's, the rule system's and the
  modules' commands, and a byte channel for files. The protocol package carries the types, the
  decoder and a reference client session, and a test wires the real client to the real server and
  compares their logs.
- **Rooms that do one thing at a time.** Speech and commands queue behind one lock per room, in
  arrival order; only a line of speech opens a Keeper turn. Undo, reset and import do not wait for
  the lock: whatever the old generation still has in flight ends as stale by itself.
- **Modules are real code.** A pack's modules run in the room's own worker thread, never on the
  server's main thread, and answer through effects the engine validates and applies. The module SDK
  ([sdk/README.md](../sdk/README.md)) has the contract and a test host.
- **Packs, manifest 3.** One `.lwpack` carries modules, rule systems, skills, cards, panels, a
  presentation kit and assets; it is validated as a whole before anything is written, and its trust
  card says first whether it runs code. Installed by whoever runs the server, or by a room admin from
  the table; enabled per room.
- **Rules as data, documents as the one door out.** The CoC 7e, D&D 5e SRD and WoD rule systems are
  rule packs; all room content is documents, and `project(document, viewer)` is the only way content
  leaves toward a connection, with a sentinel test for every type.
- **A bounded turn.** One Keeper turn is at most 21 model calls, held by a test; the Scribe, the
  Stage Director, NPC voices and the chronicle fold are declared lanes, and every model call site is
  listed with its lane or the build fails.
- **The table.** Character creation by the rule system's dice, from a description (`.genchar`) or
  from a card; the session report as a self-contained page; three audio layers; a word filter; run-
  time model switching; the access-keys and model screens in the terminal client.

## Not in 3.0 yet

- **A release.** There is no published 3.0 build: no install script, no downloadable bundle, no
  self-update. Today you run it from a checkout with Bun. The `loreweaver-protocol` package on npm is
  still 2.6; the 3.0 package is in this repository.
- **The desktop client.** Loreweaver Studio is being moved to 3.0 in its own repository and cannot
  connect to a 3.0 server yet.
- **Running pages.** Panels that are HTML pages are listed and served, but no client runs one yet;
  the terminal client draws their fallback. Panels a room publishes at run time are reserved, not
  built. The protocol's `features` and `caps` lists are empty, and some signals (`turn.activity`,
  `turn.round`, `notice.spinner`) are defined but not sent — [protocol.md §14](protocol.md#14-not-in-30-yet).
- **Backups from the client.** `.save` exports a room as a bundle, but the terminal client does not
  write it to a file yet; copying the data directory is the backup for now.
- **A nightly live-model run.** The live-model play-test (`server/eval/playtest.ts`) is run by hand.
- **From 2.x, not carried over:** the chat-platform bridges (the QQ bridge included); the WebSocket
  transport; Docker; `hooks.js` and the QuickJS sandbox, the rule packs' script lane with them (a
  module is real code in the room's worker instead); AI companions; the generators that wrote a
  skill, a rule system or a module from a description; Gemini's native client and the ChatGPT /
  SuperGrok subscription providers; SillyTavern prompt presets; maps; the demo mode; the `doctor`
  and `lint` commands; live-reload dev rooms; the tool-call trace file.

## Near-term

- **A first 3.0 release**, with the single-file server built for each platform, so a table can play
  without a checkout.
- **The desktop client on 3.0.** [loreweaver-studio](https://github.com/1A7432/loreweaver-studio) is
  the graphical client and card/pack studio; until it speaks protocol 3.0, the terminal client is
  how you play.
- **Multiplayer polish.** Smooth off the remaining rough edges of networked play, so a room among
  people who trust each other is genuinely comfortable.
- **A flagship module.** The formats are only worth as much as the first serious thing built on
  them; one is in development on 3.0, co-designed with the panel and presentation layers so they have
  a real consumer rather than a hypothetical one.

## The bigger arc — the world engine

What sets this apart is the world *underneath* the adventure, not a chat with dice bolted on. The long direction:

- **A deeply customizable UI extension layer.** Modules and packs should be able to DRAW their interface — declarative blocks and template panels today, pages that run in a rich client next — so a world ships not just rules and lore but its own table dressing. Protocol clients are the rendering targets.
- **Deeper worldbook:** a generative world (not only keyword/vector-retrieved lore), a **living causal timeline** where events have consequences that propagate, and **canon consistency** so the Keeper can't contradict established facts.
- **Catching up a late arrival:** someone who joins halfway through gets told what their character *would* already know — and nothing their character wouldn't.
- **D&D Beyond sheet import**, alongside the existing SillyTavern-card path.

## A question we closed, and how

**Where do the Keeper's secrets live?** This was a real fork in the road for a while. The Keeper's
prompt carries the world's keeper-only material, and keeper-only tools hand secrets back word for
word — so on the Keeper's own side, the thing stopping a spoiler is an instruction not to quote that
material, not the shape of the code. The alternative was to keep secrets out of the base prompt and
have the Keeper pull them on demand, so the model only ever holds the one secret it just reasoned
about.

**We decided not to.** A Keeper that doesn't know the whole truth cannot run a mystery: it plants no
foreshadowing, mistimes its reveals, and contradicts itself two sessions later. Rationing the
Keeper's own knowledge would trade away the thing the product is for, in exchange for a smaller leak
risk that testing against real models can address directly. So the split is permanent and deliberate:

- **For everyone else, it is the code.** Players, NPCs and the Stage Director get a filtered view and
  nothing else. Tests exist purely to catch it if that ever stops being true.
- **For the Keeper alone, it is behaviour.** It sees the module. It is told not to quote it. That
  instruction is *tested* against real models, and never claimed as a guarantee.

The honest statement is the one in the README and in [deploy.md](deploy.md#data-flow-and-trust-boundaries),
and it stays there: green CI means the engine is correct, not that the Keeper is discreet.

## Offline tests vs. real-model quality

Worth saying plainly, because a green CI badge is easy to read too generously. The offline suite is deterministic and uses a *scripted* model. It proves the mechanical half properly — that keeper material is kept out of player material, that each NPC is built only from its own record, that the dice are real and seeded, that the commands do what they say — and it will catch any of those breaking. It **cannot** prove that a live model keeps quiet about a secret it has been shown, or that it rolls before it narrates. Those are things a model does, and they are exactly what the live-model play-test is there to measure. Read "CI is green" as *the engine is correct*, not *the Keeper is good*.

## How to help

Pick anything above. Before a PR, `bun run check` in `server/`, `sdk/` and `clients/tui/`, `bun test` in `clients/protocol/` and `bun run build` in `server/` must pass, and the iron rules in [AGENTS.md](../AGENTS.md) must hold: no user-facing string is hardcoded, anything the code should decide is never handed to the model, and information isolation is never broken.
