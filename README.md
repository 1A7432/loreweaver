# Loreweaver

**[简体中文 →](README.zh.md)**

<!-- owner 待填：下面三句英雄句是已锁定的旧稿（landing-redesign.md「用户锁定」）。
     若要为这一版换新句子，改这里；正文其余部分不写口号，只写事实。 -->

**"Your favorite character shouldn't live only in a chat window."**

Take them into a full world: dice decide what succeeds, rules keep it honest, and what you live through together leaves marks. You adventure together, fail together, and see the story through to the end.

Neither of you knows the script — **you create the story together.**

Loreweaver is an open-source **engine and open standard for AI-run tabletop RPGs**. You and your friends bring the characters; an AI Keeper reads the module, remembers the world, plays every NPC and guards every clue. What separates it from "chatting with an AI" is that **the dice are real**: checks, damage, sanity and every number on a sheet are rolled and resolved by code, and the model's job is to tell you what that meant. **The AI tells the story. The code keeps the score.**

A world's rules, lore, cast, interface and staging are all plain files in documented formats rather than features baked into the engine, so a world can be packed up and handed to someone else. The server runs on your own machine. Call of Cthulhu 7e and D&D 5e (SRD) ship with it, and English and Chinese are both first-class.

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black) [![protocol](https://img.shields.io/badge/protocol-2.1-informational)](docs/protocol.md)

**Links:** [Homepage](https://1a7432.site) · [Command manual](https://1a7432.site/commands-en.html) · [Play](docs/play.md) · [Author a pack](docs/authoring.md) · [Run a table](docs/operating.md)

> **Honestly:** this is a young project, built mostly by one person working with AI. The deterministic half — dice, rules, sheets, projections — is the solid part, held by more than 2,200 offline tests. How the AI Keeper *behaves* is a separate question: we publish what we measured and promise nothing beyond it. The [status section](#where-this-actually-stands) below says exactly what is proven and what is not.

![Loreweaver demo — a real session in the terminal: p2p connect with an invite key, the module opening replays, the AI Keeper narrates, a Spot Hidden check resolves with real dice](assets/demo-en.gif)

*Real session, real model, real dice — recorded in the terminal client. ([There's also a session played in Chinese.](assets/demo-zh.gif))*

---

## Five minutes to a table

### 1. Install the client

macOS / Linux:

```bash
curl -fsSL https://github.com/1A7432/loreweaver/releases/latest/download/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1 | iex
```

> **Read this before you paste it.** Development builds are published as ordinary GitHub releases,
> so `releases/latest` resolves to the **newest build**, not the newest *stable* one — a
> `release-<version>.dev<N>+g<sha>` tag rather than `v1.0.0`. For a project moving this fast that is the
> right default, but it should be a choice you make knowingly rather than one the word "latest"
> makes for you. To install a specific release instead, fetch that release's own installer — it
> pins itself:
>
> ```bash
> curl -fsSL https://github.com/1A7432/loreweaver/releases/download/v1.0.0/install.sh | bash
> ```
>
> `TRPG_RELEASE_TAG=<tag>` overrides the choice for any installer and pins the one-click server
> download to the same release, so client and server stay in step; `TRPG_SERVER_RELEASE_TAG` pins
> only the server. Behind the Great Firewall, `TRPG_ORIGIN=https://1a7432.site/trpg` uses the mirror
> instead of GitHub. Every archive is verified against its published SHA-256 before anything is
> extracted; a mismatch is fatal and never falls back to a different payload.

Prefer a different location than your user profile? Set `TRPG_HOME` (client) and
`TRPG_LOCAL_SERVER_HOME` (one-click server state, including its `.env`) before installing. On
Windows, run the client in **Windows Terminal** or **WezTerm** — the legacy console host renders
broken borders and swallows mouse input.

### 2. Host

```bash
loreweaver
```

On the connect screen, click the green **Host locally & play**. There is no step two: it downloads
a self-contained server build for your OS (**no Python, no environment setup**), starts it, issues
your Keeper key, and drops you into the main menu as the Keeper.

**No API key needed to taste it.** With no model configured, a Keeper in an empty room sees **Play
sample adventure** — a built-in scripted Keeper runs the included lighthouse scenario through the
real dice and rules pipeline. The server re-checks that the room is empty before loading it, so a
stale menu can never overwrite a campaign. Add a provider on the model screen whenever you're
ready; the running server switches immediately.

### 3. Invite

Your screen now shows two things: a **ticket** (a p2p address) and a **Keeper key**. Open *Rooms &
invites* in the main menu and mint one invite code per friend. They install the client, paste your
ticket and their code, pick a nickname, and they're in.

**No domain, no TLS certificate, no port forwarding.** Connections are peer-to-peer over
[Iroh](https://www.iroh.computer/) — QUIC with NAT hole-punching, relay fallback, end-to-end
encrypted. The ticket is stored locally and survives restarts, so you **share it once and it keeps
working**. There are no accounts: the invite code *is* the entrance. Dropped connections reconnect
on their own.

A Keeper key is an administrator credential for its room — it reads keeper-only material and manages
that room's invites, and model/provider settings are deployment-wide. Hand Keeper keys only to
people you'd hand your laptop to.

### 4. Play

Type what your character does, in plain language. When something is uncertain, the Keeper calls for
a check and the engine rolls it. Three things are worth knowing on turn one:

```
.r 3d6+2          roll dice yourself     ->  Roll: 3d6+2 = [4, 4, 1]+2 = 11
.ra spot hidden   make a check           ->  Check Spot Hidden: target 25 (effective 25), roll 13 -> Success
?                 open the help overlay  (keys, dice, how success tiers read)
```

Both command styles work: the Chinese SealDice one (`.ra 侦查`, `.st 力量50`) and the English
Avrae style (`/roll 4d6kh3`). The full player walkthrough — keys, panels, success tiers, `.recap` —
is **[docs/play.md](docs/play.md)**; the complete command reference is the
[player command manual](https://1a7432.site/commands-en.html).

<p align="center">
  <img src="assets/tui-connect-en.png" width="49%" alt="Connect screen: one-click local hosting, saved servers, ticket login" />
  <img src="assets/tui-character-en.png" width="49%" alt="Character creation: four methods, manual mode validates the point budget live" />
</p>
<p align="center">
  <img src="assets/tui-menu-en.png" width="49%" alt="Keeper main menu: rooms & invites, import module, rule systems, KP skills, model config" />
  <img src="assets/tui-skills-en.png" width="49%" alt="KP skills: toggle play-style packs, or describe one sentence and generate a new one" />
</p>

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
│  Director · 演出导演     model, on beats     act cards, letters, clippings, map pins, audio      │
│                                              cues, generated art — what the table sees           │
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

All room content — lore, NPCs, sheets, pregens, trackers, notes, knowledge pools — is a `Document`
in one table. Every document type registers a `project(document, viewer)` hook, and **every outbound
surface goes through it**. There is one path out, not five, which is the main reason we trust it.

| viewer | sees |
|---|---|
| the Keeper | the full document — it has to know the mystery to run it |
| a player | the projection: no secret lore, no NPC agendas, no keeper-only trackers, no unexposed variable leaves |
| an NPC / companion / the Director | only its own record and sheet, assembled from nothing else |

One set of tests exists purely to catch leaks: each one names a particular secret and fails if it
ever comes back out of `project()`. Another forbids `agent/`, `gateway/` and `net/` from reading a
secrecy field directly. What none of this proves: that the main Keeper, having been shown a secret so
it can run the mystery, never says it out loud. That is behaviour, and it is
[measured separately](#where-this-actually-stands).

---

## What's in the box

**Rule systems are data, not code.** A rule system is one YAML file: what a character sheet looks
like, how derived stats are computed, which tiers a check can land on, what subsystems exist, which
dot-commands it answers to, and what all of it is called in each language. The bundled
CoC 7e / D&D 5e / WoD packs are ordinary packs — delete `rulepacks/coc7.yaml` from a deployment and
CoC is simply gone, with no residue. Check resolution is a small declarative DSL over the dice
engine:

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
engine, so a system that counts successes is data too. Anything the DSL genuinely can't express hands
off to a script in a QuickJS sandbox: the engine rolls the dice first, passes the numbers in, and the
script returns nothing but a verdict — randomness and state never leave the engine. A module that
needs house rules ships a *patch*: `extends: coc7` and only the lines it changes.

**The card split (拆卡).** A SillyTavern "heavy card" fuses two things Loreweaver keeps apart: the
*character* (persona, sheet, memories) and the *world* (hook scripts, variable schemas, executable
templates). When a player imports the character half, the world machinery is **taken out by the importer
itself** — and the summary you get back lists exactly what was left behind. World machinery reaches a room only through
the Keeper's own `.import <file> world`, because it reprograms the whole table. Imported variable
trees stay off player panels until the Keeper exposes them (`.var expose`).

**Campaign memory that survives the context window.** Play is recorded as chronicle documents. Once the
assembled prompt passes 60% of the model's context window, the oldest records are folded in batches
into a running summary of the campaign until it is back under 40%. The last four turns are never
folded — a scene still being played isn't history yet — and folded records go into the search index,
so a detail from session 3 can still be found in session 12. Players get `.recap` — the same story, with
keeper spoiler annotations structurally removed by the projection contract.

**A presentation layer, not just a chat log.** Modules can draw their own table. Hooks emit
ready-made blocks (meters, badges, choices, images). A pack can declare named panels wired to live
variables, shown or hidden by value with `visible_when`, docked in a sidebar, tray or modal — and the
server, not the client, decides who is allowed to see each one. A tier-2 panel is real HTML/JS in a
locked-down iframe, and it must ship a plain-text version alongside. Above all of that sit the Stage
Director's performance templates — `letter`, `clipping`, `map_pin`, `title_card`, `image` — which a
rich client draws as a letter or a title card and a terminal client prints as a few lines. The author
writes one version either way.

**Three audio layers.** `bgm`, `ambience` and `sfx` are separate lanes with their own play/stop/fade
state, replayed on join. A pack ships its audio; the Keeper cues it by hand, or the Director does it
on a beat.

**Self-hosted, serverless in the ops sense.** There is no cloud, no account system, no reverse
proxy, no certificate. The server is a process on your machine; friends dial a ticket over p2p QUIC.
Your campaign database, your module files, your keys, your media — all local.

**Ask for it and it exists.** Describe a rule system, a play style or a scenario on an admin screen
and the Keeper authors it, validates it through the real parsers, and installs it. Everything it
writes is a portable format someone else can read.

**A whole campaign travels as one file.** Skills, rulepacks, cards, lorebooks, panels, presentation
kits and media bundle into a single `.lwpack` zip:

```bash
uv run python -m app --pack my-campaign/        # -> my-campaign-1.0.0.lwpack + its sha256
uv run python -m app --install gh:owner/repo    # or a local path, or an https URL
```

Installs print a trust card first — what the pack contains, whether it ships sandboxed JS, how many
megabytes of assets, whether it may spend your image budget — then verify every declared byte before
writing anything. Git releases are the registry: there is no central store to submit to, and nobody
(us included) sits between an author and their readers.

---

## Where this actually stands

**Solid.** The deterministic engine: dice, check tiers, sheets and derived stats, rule validation on
every path that writes a number, the clock, permissions, the one place documents are filtered before
they go out, packs and their integrity checks, the protocol. More than 2,200 Python tests plus ~370 client tests run fully
offline, with a scripted Keeper and seeded dice — no network, no keys. A self-play test drives the
entire pipeline end to end.

**Measured, not proven.** Whether a *live* model behaves is a different question, and green CI must
not be read as answering it. A [nightly red-line eval](https://github.com/1A7432/loreweaver/actions/workflows/redline-eval.yml)
runs scripted players against a real model and scores every turn for secret leakage and dice-first
misses; threshold violations, provider failures and auth failures all make the run red. Results are
per model and per run, not a standing guarantee.

**Young.** Networked multiplayer is comfortable for a table of friends but has rough edges. The
rich client and the card studio live in a [companion repo](https://github.com/1A7432/loreweaver-studio)
and are earlier than this one. The flagship module is in development. The forward plan, the open
design questions, and where help is most wanted: **[docs/roadmap.md](docs/roadmap.md)**.

---

## For developers

```bash
uv sync --extra ejs                # deps; `ejs` = the QuickJS sandbox that runs imported cards' JS
uv run python -m app --cli         # offline demo Keeper + real dice, no API key needed
uv run python -m app --doctor      # sanity-check locales / rulepacks / skills / data dir
uv run python -m app --serve       # the p2p server; prints a ticket + Keeper key
```

Plug in a real model by copying `.env.example` to `.env`:

```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=high
```

Most vendors work through the OpenAI-compatible path plus a preset; Anthropic and Gemini have native
clients; ChatGPT and SuperGrok subscriptions authenticate over OAuth. Switch models mid-game with
`.model set <provider> [model]` — no restart. **Model capability matters a lot**: the Keeper does
everything through tool calls, and budget models tend to say "you succeed" without ever rolling. See
**[docs/operating.md](docs/operating.md)** for the model, quota and prompt-cache guide.

**Tests, all offline:**

```bash
uv run pytest -q                                  # the offline suite
uv run ruff check core infra agent gateway net adapters app.py lw_versioning.py scripts
uv run python scripts/i18n_lint.py                # no hardcoded user-facing strings
cd clients/protocol && bun test                   # protocol package
cd clients/tui && bun test                        # terminal client
```

**Layout:**

```
core/   deterministic engine        infra/    store · config · i18n · llm · embeddings · vector · providers
agent/  the AI actors + KP tools    gateway/  commands · ops · hub · runner · director
net/    Iroh p2p + session core     adapters/ CLI          clients/ protocol (npm) · tui
```

Layer contracts, the iron rules, and how to add a rulepack / provider / tool / client:
**[AGENTS.md](AGENTS.md)**.

**Building a client or a bot?** The protocol is open and versioned:
**[docs/protocol.md](docs/protocol.md)** (2.1). Typed frames and a reconnecting WebSocket client
ship on npm as [`loreweaver-protocol`](https://www.npmjs.com/package/loreweaver-protocol), whose
`major.minor` tracks the protocol version.

**Running a persistent server?** Most tables run p2p off a laptop; for a 24/7 game, see
**[docs/deploy.md](docs/deploy.md)** (systemd unit, keys, backups, trust boundaries).

## Documentation map

| For | Read |
|---|---|
| Players | [docs/play.md](docs/play.md) — five-minute start, keys, dice, panels, recaps |
| Module authors | [docs/authoring.md](docs/authoring.md) — build a `.lwpack` from zero, with a real module as the worked example |
| Keepers & operators | [docs/operating.md](docs/operating.md) — models, quota, caching, backups, reset, self-update |
| Server operators | [docs/deploy.md](docs/deploy.md) — always-on deployment, keys, trust boundaries |
| Card authors | [docs/cards.md](docs/cards.md) — what imports, what runs, what differs from SillyTavern |
| Hook authors | [docs/hooks.md](docs/hooks.md) — the sandboxed turn-lifecycle API |
| Extension contract | [docs/plugins.md](docs/plugins.md) — the full layered specification |
| Client authors | [docs/protocol.md](docs/protocol.md) — the versioned wire protocol |
| Contributors | [AGENTS.md](AGENTS.md) — architecture, iron rules, conventions |
| Design history | [docs/notes/](docs/notes/) — decisions taken and proposals rejected, five lines each; [docs/defensive-patterns.md](docs/defensive-patterns.md) — implementation rules paid for in bugs; specs stay internal until published into [docs/specs/](docs/specs/) |

Every page above except `AGENTS.md` and the design-history records has a Chinese version; the link is at the top of each one.

## Contributing

PRs and issues welcome. Before submitting, get these green: `uv run ruff check …`,
`uv run python scripts/i18n_lint.py`, `uv run pytest -q`, plus the relevant `bun test`. Respect the
iron rules in [AGENTS.md](AGENTS.md) — above all, every user-facing string goes through i18n, and
information isolation is never broken. Rules content must be openly licensed (SRD / Miskatonic
Repository); bring your own modules at runtime. Where help is needed most is listed in the
[roadmap](docs/roadmap.md).

## Security

Self-hosting keeps the engine, campaign database, keys and files under your control. It does **not**
make model traffic local: a remote LLM receives module text during analysis, the Keeper system
prompt (including keeper-only lore), relevant history, and the current player input. The standard app
uses a local hash embedder; a deliberately wired remote embedding backend would also receive document
chunks. Use a local endpoint such as Ollama or LM Studio if those prompts must stay on infrastructure
you control. Iroh's end-to-end encryption covers player-to-server transport; that is a separate
boundary from the model provider.

Provider API keys and OAuth grants are stored **unencrypted** in the local SQLite database so runtime
configuration survives restart. New secret files and data directories are restricted to the local
owner where the filesystem supports POSIX modes, but this is not a secret vault: protect the host
account, backups, `.env`, `keys.toml`, `keeper-key.txt` and `*.db`, and never commit them.

There is no account recovery and no central identity service — a random key is the credential,
binding its holder to one room with a player or Keeper role. Revoke lost keys; treat every Keeper key
as a trusted administrator for its room and for deployment-wide model configuration. Full trust
model: [docs/deploy.md](docs/deploy.md#data-flow-and-trust-boundaries).

Found a vulnerability? Open a private security advisory on GitHub, not a public issue.

## License & credits

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Includes **D&D 5e SRD 5.1** (CC-BY-4.0)
material; Cthulhu content only within open / Miskatonic Repository licensing. The gateway layer
derives from **hermes-agent** (MIT, © 2025 Nous Research); the dice engine is **avrae/d20** (MIT);
the Chinese command style, CoC success function and skill alias table are rewritten with reference
to **SealDice** (MIT); the terminal client is built on **OpenTUI**. No copyrighted adventure text
ships in this repository.

Community: [LINUX DO](https://linux.do/).
