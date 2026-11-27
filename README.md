# Loreweaver

**[简体中文 →](README.zh.md)**

<!-- owner 待填：下面三句英雄句是已锁定的旧稿（landing-redesign.md「用户锁定」）。
     若要为这一版换新句子，改这里；正文其余部分不写口号，只写事实。 -->

**"Your favorite character shouldn't live only in a chat window."**

Take them into a full world: dice decide what succeeds, rules keep it honest, and what you live through together leaves marks. You adventure together, fail together, and see the story through to the end.

Neither of you knows the script — **you create the story together.**

Loreweaver is an open-source **engine and open standard for AI-run tabletop RPGs**. You and your friends bring the characters; an AI Keeper reads the module, remembers the world, plays every NPC and guards every clue. What separates it from "chatting with an AI" is that **the dice are real**: checks, damage, sanity and every number on a sheet are rolled and resolved by code, and the model's job is to tell you what that meant. **The AI tells the story. The code keeps the score.**

A world's rules, lore, cast, interface and staging are all plain files in documented formats rather than features baked into the engine, so a world can be packed up and handed to someone else. The server runs on your own machine. Call of Cthulhu 7e and D&D 5e (SRD) ship with it, and English and Chinese are both first-class.

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![server](https://img.shields.io/badge/server-TypeScript%20%2F%20Bun-black) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black) [![protocol](https://img.shields.io/badge/protocol-3.0-informational)](docs/protocol.md)

**Links:** [Homepage](https://1a7432.site) · [Play](docs/play.md) · [Author a pack](docs/authoring.md) · [Run a table](docs/operating.md)

> **Honestly:** this is a young project, built mostly by one person working with AI. The deterministic half — dice, rules, sheets, projections — is the solid part, held by more than 5,000 offline tests. How the AI Keeper *behaves* is a separate question: we publish what we measured and promise nothing beyond it. The [status section](#where-this-actually-stands) below says exactly what is proven and what is not.

---

## Five minutes to a table

Version 3.0 is a rewrite of Loreweaver on Bun and TypeScript. **There is no published 3.0 release
yet**: today you run it from a checkout of this repository, with [Bun](https://bun.sh) installed.
The desktop client, Loreweaver Studio, is being moved to 3.0 in
[its own repository](https://github.com/1A7432/loreweaver-studio) and cannot connect to a 3.0
server yet; until it can, the terminal client in this repository is how you play.

### 1. Get the code

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
bun install
```

On Windows, run the client in **Windows Terminal** or **WezTerm** — the legacy console host renders
broken borders and swallows mouse input.

### 2. Host

```bash
cd clients/tui && bun run dev
```

On the connect screen, choose **⌂ Host locally & play**. There is no step two: it starts the server
from this checkout (its data goes to the *Local server folder*, `~/.loreweaver` by default), mints
your admin key, and drops you into the main menu as the room admin.

**Without a model the server still starts**, and dice, sheets and commands all work; the Keeper
answers once a model is configured. Copy `.env.example` to `.env` at the root of the checkout and
set `TRPG_LLM__*` before hosting, or, as the room admin, open **Model** in the main menu at any
time — the running server switches immediately.

### 3. Invite

Open **Access keys** in the main menu and mint one key per friend. The screen shows the **ticket**
(a p2p address) and their key together; they paste both on the connect screen, pick a nickname, and
they're in.

**No domain, no TLS certificate, no port forwarding.** Connections are peer-to-peer over
[Iroh](https://www.iroh.computer/) — QUIC with NAT hole-punching, relay fallback, end-to-end
encrypted. The server keeps its identity in its data folder, so the ticket survives restarts: you
**share it once and it keeps working**. There are no accounts: the key *is* the entrance. Dropped
connections reconnect on their own.

An admin key is an administrator credential for its room — it reads keeper-only material and manages
that room's keys, and model/provider settings are server-wide. Hand admin keys only to people you'd
hand your laptop to.

### 4. Play

Type what your character does, in plain language. When something is uncertain, the Keeper calls for
a check and the engine rolls it. Three things are worth knowing on turn one:

```
.r 3d6+2          roll dice yourself     ->  ⚄ Alice 3d6+2 11
.ra spot hidden   make a check           ->  ⚄ Alice 1d100 13 vs 25 -> Success
?                 open the help overlay  (keys and dice)
```

Both command styles work: the Chinese SealDice one (`.ra 侦查`, `.st 力量50`) and the English
Avrae style (`/roll 4d6kh3`). The full player walkthrough — keys, panels, success tiers, `.recap` —
is **[docs/play.md](docs/play.md)**; every command your table has is listed in the room itself
(`.help`, or F7 in the terminal client), and all of the engine's are in
[the protocol's command table](docs/protocol.md#68-the-engines-commands).

---

## How a turn actually works

A Loreweaver table has **four actors**. Only one of them writes fiction, and the one that owns the
numbers is not a model.

```
   you type ───────────────────────────────────────────────────────────────────────────────────────┐
                                                                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  KP · the Keeper         model, every turn   narration, NPC voices, rulings, what happens next   │
│  engine                  code, always        dice, sheets, clocks, trackers, validation,         │
│                                              permissions — and every projection below            │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                                   │
   the reply streams to the table ─────────────────────────────────────────────────────────────────┤
                                                                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Scribe · 书记官         small model,        reconciles the ledger against what was narrated,    │
│                          every turn          whispers judgment calls into the KP's next turn,    │
│                                              and classifies the turn's story beat                │
│  Director · 演出导演     model, on beats     title cards, letters, clippings, audio cues,        │
│                                              generated art — what the table sees                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The **Scribe** exists because of something that went wrong in a real playtest. A strong storytelling
model ran an entire module without once updating the game's state: every tracker sat at its starting
value while the story raced three days ahead. You cannot leave the bookkeeping to a model's good
intentions, so it got a quiet helper of its own. The Scribe only proposes; the engine checks the
numbers and pulls anything out of range back in. Re-running the same module with it, the trackers
kept up with the story and the table rolled several times as many dice.

The **Director** is the newest of the four and the one kept on the shortest leash. Everything it
produces is seen by players, so it is built the way an NPC is built: all it is given is the same
player's-eye view of the story that the players get, plus the module's presentation kit. It cannot
leak what it was never told.

### Every secret leaves by one door

All room content — lore, NPCs, sheets, pregens, trackers, notes — is a `Document` in one table.
Every document type registers a `project(document, viewer)` hook, and **every outbound surface goes
through it**. There is one path out, not five, which is the main reason we trust it.

| viewer | sees |
|---|---|
| the Keeper | the full document — it has to know the mystery to run it |
| a player | the projection: no secret lore, no NPC agendas, no keeper-only trackers, no unexposed variable leaves |
| an NPC / the Director | only its own record and sheet, assembled from nothing else |

One set of tests exists purely to catch leaks: each one names a particular secret and fails if it
ever comes back out of `project()`. Another forbids `gateway/` and `net/` from reading a stored
document whole. What none of this proves: that the main Keeper, having been shown a secret so it can run the mystery, never says it out loud. That is
behaviour, and it is [measured separately](#where-this-actually-stands).

---

## What's in the box

**Rule systems are data, not code.** A rule system is one YAML file: what a character sheet looks
like, how derived stats are computed, which tiers a check can land on, what subsystems exist, which
dot-commands it answers to, and what all of it is called in each language. The bundled
CoC 7e / D&D 5e / WoD systems are ordinary rule packs in that same format (`rulepacks/`), compiled
into the server; the engine itself holds no CoC rules. Check resolution is a small declarative DSL
over the dice engine:

```yaml
resolution:
  roll: 1d100
  target: skill
  ranks:
    - {id: crit,    when: "roll == 1",              success: true, critical: true}
    - {id: extreme, when: "roll <= target / 5",     success: true}
    - {id: hard,    when: "roll <= target / 2",     success: true}
    - {id: regular, when: "roll <= target",         success: true}
    - {id: fail}
```

Dice pools (`7d10>=8`), fudge dice (`4dF`) and exploding dice (`5d6!`) are built into the dice
engine, so a system that counts successes is data too. In 2.x, anything the DSL couldn't express
handed off to a sandboxed script; 3.0 does not run that script lane and refuses a rule pack that
needs one. A module that needs house rules ships a *patch*: `extends: coc7` and only the lines it
changes.

**The card split (拆卡).** A SillyTavern "heavy card" fuses two things Loreweaver keeps apart: the
*character* (persona, sheet, memories) and the *world* (hook scripts, variable schemas, executable
templates). When a player imports the character half, the world machinery is **taken out by the importer
itself** — and the summary you get back lists exactly what was left behind. World machinery reaches a room only through
the room admin's own world import (*Import a world card* in the terminal client, or
`.import world …`), because it reprograms the whole table. Imported variable trees stay off player
panels until the room admin exposes them (`.var expose`). And the switches a card's frontend scripts
used to throw are yours to flip at the table: `.lore enable <title>`, or
`.lore bind <title> | <condition>` to let a variable decide — without ever editing the card.

**Campaign memory that survives the context window.** Play is recorded as chronicle documents. Once the
assembled prompt passes 60% of the model's context window, the oldest records are folded in batches
into a running summary of the campaign until it is back under 40%. The last four turns are never
folded — a scene still being played isn't history yet — and, when an embedding model is configured,
folded records go into the search index, so a detail from session 3 can still be found in
session 12. Players get `.recap` — the same story, with keeper spoiler annotations structurally
removed by the projection contract.

**A presentation layer, not just a chat log.** Modules can draw their own table. A module emits
ready-made blocks (meters, badges, choices, images). A pack can declare named panels wired to live
views, shown or hidden by value with `visible_when`, docked in a sidebar, tray or modal — and the
server, not the client, decides who is allowed to see each one. A page panel is real HTML for a rich
client's sandboxed frame, and it must declare a fallback made of the same blocks (or say outright
that it has none); no client runs pages yet, so the terminal client draws the fallback. Above all of that sit the Stage Director's
performance templates — `title_card`, `letter`, `clipping`, `image`, `text` — which a rich client
draws as a letter or a title card and a terminal client prints as a few lines. The author writes one
version either way.

**Three audio layers.** `bgm`, `ambience` and `sfx` are separate lanes with their own play/stop/fade
state, replayed on join. A pack ships its audio; the room admin cues it by hand, or the Director does it
on a beat.

**Self-hosted, serverless in the ops sense.** There is no cloud, no account system, no reverse
proxy, no certificate. The server is a process on your machine; friends dial a ticket over p2p QUIC.
Your campaign database, your module files, your keys, your media — all local.

**A whole campaign travels as one file.** Modules, skills, rule packs, cards, panels, a presentation
kit and media bundle into a single `.lwpack` zip:

```bash
bun server/src/cli/main.ts pack my-campaign/             # -> <id>-<version>.lwpack + its sha256
bun server/src/cli/main.ts install gh:owner/repo --yes   # or a local path, or an https URL
```

Installs print a trust card first — what the pack contains, whether it runs code and which modules,
the rule systems, skills, cards and panels it adds, how many megabytes of assets, and what it ignores
— and validate the whole pack before writing anything; without `--yes` that card is all you get.
A module is real code that runs in the server's process, so a pack is installed by whoever runs the
server, or by a room admin from the table (`.pack install`); installing enables nothing until an
admin enables it in a room. Git releases are the registry: there is no central store to submit to,
and nobody (us included) sits between an author and their readers.

---

## Where this actually stands

**Solid.** The deterministic engine: dice, check tiers, sheets and derived stats, rule validation on
every path that writes a number, the clock, permissions, the one place documents are filtered before
they go out, packs and their integrity checks, the protocol. More than 4,900 server tests plus about
400 client and SDK tests run fully offline, with a scripted model and seeded dice — no network, no
keys. Building the single-file server runs its own self-test: a real turn, end to end, over a
scripted model.

**Measured, not proven.** Whether a *live* model behaves is a different question, and green CI must
not be read as answering it. A live-model run (`server/eval/playtest.ts`) seats scripted players at
a real model; a second real-model judge reads everything the table saw this turn against the world's
keeper-only material (a legitimately earned reveal is not a leak, and an unreachable judge counts as
a leak), every turn is checked for dice-first misses, and every tool call is logged with its
arguments and result. It is run by hand, one session at a time, and there is no nightly run for 3.0
yet. Results are per model and per run, not a standing guarantee.

**Young.** Networked multiplayer is comfortable for a table of friends but has rough edges. 3.0 has
no published release yet, and the desktop client
([companion repo](https://github.com/1A7432/loreweaver-studio)) cannot connect to it until its own
move to 3.0 is done. The flagship module is in development. The forward plan, the open design
questions, and where help is most wanted: **[docs/roadmap.md](docs/roadmap.md)**.

---

## For developers

```bash
bun install                                         # once, at the repository root (one workspace)
bun server/src/cli/main.ts serve                    # the p2p server; prints its ticket, and an admin key the first time
bun server/src/cli/main.ts key main player Alice    # another key for the room `main` (with the server stopped)
```

`serve` prints one JSON line when it is ready — `{"ok":true,"version":"3.0.0","ticket":"endpoint…","notes":[…]}`,
plus `"first_key"` on a fresh data directory — and runs until interrupted. Plug in a real model by
copying `.env.example` to `.env` (Bun reads it from the directory you start in):

```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=high
```

The server speaks three wires: OpenAI-compatible Chat Completions, Anthropic's Messages API and
OpenAI's Responses API. `openai`, `anthropic`, `deepseek`, `openrouter` and `moonshot` are presets;
any other endpoint works by giving its base URL. Switch models mid-game with
`.model set <provider> [model]` — no restart. **Model capability matters a lot**: the Keeper does
everything through tool calls, and budget models tend to say "you succeed" without ever rolling. See
**[docs/operating.md](docs/operating.md)** for the model, quota and prompt-cache guide.

**Tests, all offline:**

```bash
cd server && bun run check            # type check + the server's tests
cd sdk && bun run check               # the module SDK
cd clients/protocol && bun test       # protocol package
cd clients/tui && bun run check       # terminal client
cd server && bun run build            # the single-file server, then its self-test
```

**Layout:**

```
server/src/   infra < core < agent < gateway < net, plus cli/ and worker/
              infra     store · config · i18n · llm · media · packs · recall
              core      deterministic engine: dice, rule packs, sheets, documents, packs, panels
              agent     the Keeper's turn, its tools and prompt, the NPC / Scribe / Director / fold lanes
              gateway   rooms, commands, packs in a room, the word filter
              net       Iroh p2p + sessions, the keystore
              worker    module code: one worker per room
sdk/          the module SDK          clients/   protocol · tui
```

Layer contracts, the iron rules, and how to add a rule pack / provider / tool / client:
**[AGENTS.md](AGENTS.md)**.

**Building a client or a bot?** The protocol is open and versioned:
**[docs/protocol.md](docs/protocol.md)** (3.0). Typed frames, a decoder and a reference client
session are in [`clients/protocol`](clients/protocol), published to npm as
[`loreweaver-protocol`](https://www.npmjs.com/package/loreweaver-protocol), whose `major.minor`
tracks the protocol version; the 3.0 package is not on npm yet.

**Writing a module?** A module is a TypeScript file shipped in a pack; the contract and a test host
are in **[sdk/README.md](sdk/README.md)**.

**Running a persistent server?** Most tables run p2p off a laptop; for a 24/7 game, see
**[docs/deploy.md](docs/deploy.md)** (systemd unit, keys, backups, trust boundaries).

## Standards

The formats Loreweaver reads are specified on their own, in **[docs/lwf/](docs/lwf/README.md)**:
the Loreweaver World Format (LWF). It covers the `.lwpack` container (with bundled modules), cards
and the world/character split, rule packs, skills, and module panels — the pack and panel formats as
3.0 drafts, the rest as LWF 2.0; the wire protocol is its sixth part. This engine is the reference
implementation. [loreweaver-dsh](https://github.com/1A7432/loreweaver-dsh) is a second, independent
implementation of the rule pack format, checked against tables exported from this engine. The spec
text is licensed CC BY 4.0.

## Documentation map

| For | Read |
|---|---|
| Players | [docs/play.md](docs/play.md) — five-minute start, keys, dice, panels, recaps |
| Module authors | [docs/authoring.md](docs/authoring.md) — build a `.lwpack` from zero, with a real module as the worked example |
| Module code | [sdk/README.md](sdk/README.md) — the module SDK: events, effects, views, commands, tests |
| Room admins & operators | [docs/operating.md](docs/operating.md) — models, quota, caching, backups, reset |
| Server operators | [docs/deploy.md](docs/deploy.md) — always-on deployment, keys, trust boundaries |
| Card authors | [docs/cards.md](docs/cards.md) — what imports, what runs, what differs from SillyTavern |
| Extension contract | [docs/plugins.md](docs/plugins.md) — the full layered specification |
| Client authors | [docs/protocol.md](docs/protocol.md) — the versioned wire protocol |
| Format implementers | [docs/lwf/](docs/lwf/README.md) — the format specification (LWF) |
| Contributors | [AGENTS.md](AGENTS.md) — architecture, iron rules, conventions |
| Design history | [docs/notes/](docs/notes/) — decisions taken and proposals rejected, five lines each; [docs/defensive-patterns.md](docs/defensive-patterns.md) — implementation rules paid for in bugs; specs stay internal until published into [docs/specs/](docs/specs/) |

Every page above except `AGENTS.md`, `sdk/README.md`, the format specification and the design-history records has a Chinese version; the link is at the top of each one.

## Contributing

PRs and issues welcome. Before submitting, get these green: `bun run check` in `server/`, `sdk/` and
`clients/tui/`, `bun test` in `clients/protocol/`, and `bun run build` in `server/`. Respect the
iron rules in [AGENTS.md](AGENTS.md) — above all, every user-facing string comes from a catalog in
both languages, and information isolation is never broken. Rules content must be openly licensed
(SRD / Miskatonic Repository); bring your own modules at runtime. Where help is needed most is listed
in the [roadmap](docs/roadmap.md).

## Security

Self-hosting keeps the engine, campaign database, keys and files under your control. It does **not**
make model traffic local: a remote LLM receives the Keeper's prompt (including keeper-only lore),
relevant history, and the current player input, and a character made from a description or a card
sends that text too. Recall by meaning is off unless you configure an embedding endpoint; one you
configure receives lore entries and chronicle lines. Use a local OpenAI-compatible endpoint such as
Ollama or LM Studio if those prompts must stay on infrastructure you control. Iroh's end-to-end
encryption covers player-to-server transport; that is a separate boundary from the model provider.

API keys an admin sets at run time (`.model`, `.imagegen`) are stored **unencrypted** in the local
SQLite database so they survive a restart. The data directory and its secret files are restricted to
the local owner where the filesystem supports POSIX modes, but this is not a secret vault: protect
the host account, backups, `.env`, `keys.json`, `transport.key`, `loreweaver.db` and any room bundle
exported with `.save`, and never commit them.

There is no account recovery and no central identity service — a random key is the credential,
binding its holder to one room with a player, admin or observer role. Revoke lost keys; treat every
admin key as a trusted administrator for its room and for server-wide model configuration. Full
trust model: [docs/deploy.md](docs/deploy.md#data-flow-and-trust-boundaries).

Found a vulnerability? Open a private security advisory on GitHub, not a public issue.

## License & credits

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Includes **D&D 5e SRD 5.1** (CC-BY-4.0)
material; Cthulhu content only within open / Miskatonic Repository licensing. The dice notation
follows **avrae/d20** (MIT); the Chinese command style, CoC success function and skill alias table
are rewritten with reference to **SealDice** (MIT); the terminal client is built on **OpenTUI**. No
copyrighted adventure text ships in this repository.

Community: [LINUX DO](https://linux.do/).
