*English · [中文](operating.zh.md)*

# Running a table

*For the person hosting: choosing models, keeping the bill sane, and not losing a campaign.*

This is about **operating a game**. If you want to stand up an always-on server — systemd, keys on
disk, the trust model — that is [deploy.md](deploy.md), and the two are meant to be read together.

---

## 1. Models

Loreweaver talks to a model on **five lanes**, and they do very different jobs. Getting the sizes
right is the single biggest lever on both quality and cost.

| Lane | Runs | Default | Wants |
|---|---|---|---|
| **Keeper** (KP) | every turn | `TRPG_LLM__*` | the strongest model you're willing to pay for |
| **NPCs** | each time the Keeper gives an NPC its own voice | the Keeper's client | a good writer; it sees only that NPC's record |
| **Scribe** (书记官) | every turn, after the reply | the Keeper's client | a small, cheap, fast model |
| **Stage Director** (演出导演) | on story beats only | the Keeper's client | the same model as the Keeper — beats are rare and taste is the job |
| **Memory** | when the chronicle folds | the Keeper's client | a model that summarizes faithfully |

Each lane other than the Keeper's takes the same settings under its own prefix: `TRPG_NPC__*`,
`TRPG_SCRIBE__*`, `TRPG_DIRECTOR__*`, `TRPG_MEMORY__*`. A lane that names only a model (or a
reasoning effort) keeps the Keeper's endpoint and key; a lane that names a provider or a base URL is
a separate endpoint and needs its own key. The room admin's **Model** screen shows every lane, and
which ones are "same as the Keeper".

### The Keeper

```dotenv
TRPG_LLM__PROVIDER=deepseek
TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro
TRPG_LLM__REASONING_EFFORT=max
```

**Do not cheap out here.** The Keeper does everything through tool calls — rolling, reading sheets,
writing trackers, advancing the clock. Strong instruction-following models roll real dice and stay on
the module; budget models narrate "you succeed" without ever calling the check tool and drift off the
scenario. In our own testing this has been the most reliable difference between a good session and a
bad one.

`openai`, `anthropic`, `deepseek`, `openrouter` and `moonshot` are presets. Any other endpoint works
by naming it and giving its address — `TRPG_LLM__PROVIDER=<a name of yours>` plus
`TRPG_LLM__BASE_URL` — over one of three wires (`TRPG_LLM__WIRE`): `openai-compatible` (Chat
Completions, the default), `anthropic` (the Messages API) or `openai-responses` (OpenAI's Responses
API).

**Set the context window** for a model the server does not know: `TRPG_LLM__CONTEXT_WINDOW`. The
server knows the windows of the models it was checked against; for any other it assumes 32,000
tokens and says so when it starts (`context_window_unknown`). That number is what the chronicle fold
measures against, so a wrong one makes the room summarize far too early or too late.

Switching is hot — no restart, mid-session is fine:

```
.model                                     what each lane uses now (only you see it)
.model list [provider]                     the providers this server knows; with one, its models
.model set <provider> [model] [key=…] [base_url=…] [wire=…] [effort=…] [context=N] [lane=…]
                                           switch a lane (the Keeper's by default)
.model key <key> [lane=…]                  save a key for the provider the lane uses now
.model reset [lane]                        back to the server's own settings
.imagegen                                  the image-generation endpoint (only you see it)
.imagegen set <provider> [model] [size] [key=…] [base_url=…]
.imagegen off                              stop generating pictures
```

The model settings are **server-wide**: every room follows them. Keys are remembered **per
provider**, so switching back to one you've used before doesn't re-ask, and every answer shows a key
only masked. The next turn uses the new model; a turn in flight finishes on the one it started with.
Admin clients can do all of this from the **Model** screen instead, where a key is typed into a
hidden field — the safer way, since a mistyped command word turns the line into speech at the table.

### The Scribe — small model, real job

The Scribe is on by default and runs one extra call after every Keeper turn, outside the room's lock,
so nobody waits for it. It reconciles the module's trackers against what was actually narrated
(evidence-quoted; it cannot write a tracker it cannot cite), whispers judgment calls into the
Keeper's *next* turn ("a day seems to have passed", "that horror beat may have warranted a sanity
check"), writes the campaign's chronicle line for the turn, and classifies the turn's story beat for
the Director.

Unset `TRPG_SCRIBE__*` fields reuse the Keeper's client — correct, but it means paying flagship prices
for clerical work, on every single turn. Give it its own small model:

```dotenv
TRPG_SCRIBE__PROVIDER=deepseek
TRPG_SCRIBE__CHAT_MODEL=deepseek-v4-flash
TRPG_SCRIBE__API_KEY=sk-…
TRPG_SCRIBE__REASONING_EFFORT=low
```

`TRPG_SCRIBE__ENABLED=false` turns it off. Before you do: the reason it exists is that a live
playtest watched a strong narrative model run an entire module without touching the state layer
once — trackers frozen at their defaults while the fiction sprinted three days ahead. With the Scribe
on, the same module's trackers moved with the story. Bookkeeping does not survive on model
discipline.

### The Director — optional, and three things have to agree

The Stage Director stages story beats: title cards, letters, newspaper clippings, audio cues, and
generated art. It defaults to the **Keeper's** model, which is the opposite of the Scribe's advice —
beats are rare and the job is taste.

**It only wakes up if a pack asks for it**: it runs only in a room that has enabled a pack with a
presentation kit. A table with no such pack never wakes one and is never charged for it. Image
generation additionally needs all three of these to agree:

1. `TRPG_DIRECTOR__IMAGES` (on by default),
2. a configured image-generation endpoint — `TRPG_IMAGEGEN__*` in `.env`, or `.imagegen set` at
   runtime (or *Set the picture maker…* on the Model screen),
3. the pack's own kit — and if its author wrote `generation: pack_only`, that is the author's call,
   and nothing you set on your side overrides it.

```dotenv
# TRPG_DIRECTOR__ENABLED=true
# TRPG_DIRECTOR__CHAT_MODEL=          # unset = the Keeper's client
# TRPG_DIRECTOR__IMAGES=true
# TRPG_DIRECTOR__MAX_IMAGES=24        # pictures one story may generate
# TRPG_DIRECTOR__PREGEN_PER_BEAT=2
```

Past `MAX_IMAGES` the Director keeps staging with pack art and pictures already made, and simply
stops spending. Separately, the Keeper's own picture tool is held to 10 pictures per room per hour.

### Local models

Point the Keeper at a local OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, …) when prompts must
not leave your machine: a name of your own in `TRPG_LLM__PROVIDER`, its address in
`TRPG_LLM__BASE_URL`, any non-empty `TRPG_LLM__API_KEY` if the endpoint ignores keys, and its
`TRPG_LLM__CONTEXT_WINDOW`. Do the same for every lane you gave an endpoint of its own. This is the
only configuration in which keeper-only lore and player input stay on infrastructure you control —
self-hosting the *server* does not by itself make model traffic local.

---

## 2. Quota, latency and the token bill

### Read the HUD

The top bar of the terminal client carries the last turn's figures:

```
● · last turn ↑2.0k ↓120 · cache 75%
```

- **`↑` / `↓`** — the tokens the Keeper read and wrote on the most recent turn. Watch `↑` across a
  session: it grows with the story and should drop back when the chronicle folds (below).
- **`cache`** — the share of that prompt served from the provider's prompt cache. Higher is cheaper
  and faster. A healthy long session sits high; a number that keeps collapsing means the prompt
  prefix is being invalidated every turn.

### Why the prompt is laid out the way it is

The Keeper's prompt is deliberately split into a **stable head** and a **volatile tail**. Identity,
rule-system expertise, interaction style, the world card's directives, enabled skills, the modules'
command catalogue and the rolling campaign summary go first and change rarely; lore, live state, open
threads, recalled records and anything else that moves goes last. On providers with explicit prompt
caching, the boundary between them becomes a cache breakpoint.

The campaign summary sits up front even though it does change, because it only ever changes when a
fold runs — and a fold also stops replaying the turns it absorbed, which costs that turn's cache
anyway. Every other turn it is read straight from the cache.

The practical consequence for you: **anything that changes the head invalidates the whole cache**.
Switching models, enabling or disabling a skill or a pack, or importing a world mid-session all
legitimately do that — just expect the next turn to be a cache miss, and don't do them idly every few
turns.

### When the provider throttles you

Every model call retries a 429 or an overloaded response with bounded, jittered backoff: three
attempts in all, waits of up to 20 seconds. A throttled turn gets **slower, never dead**. When a
provider says *how long* to wait, the retry waits that long, up to 60 seconds; a longer hint ends the
retries instead of holding the room. If turns slow down often, the table is outrunning your plan's
rate limit. The first fix is not a bigger plan — it is giving the Scribe (and the Director, if you run
one) their own smaller model and key instead of sharing the Keeper's.

### Campaign memory folds itself

Long campaigns outlive any context window. Play is recorded as chronicle documents, and when the
assembled prompt crosses **60%** of the model's context window, the oldest records fold in batches
into a running summary of the campaign until it is back under **40%**. An emergency ceiling at
**85%** forces a fold before the next call — the ceiling exists so the fold call itself always has
headroom. The last **4** turns are never folded: an in-flight scene is not summarizable history yet.
If the provider refuses a prompt as too long anyway, the server folds and re-sends once — only if the
fold actually freed something.

Ratios, not absolute token counts, so every window size behaves the same:

```dotenv
# TRPG_CHRONICLE__ENABLED=true
# TRPG_CHRONICLE__FOLD_TRIGGER=0.60
# TRPG_CHRONICLE__FOLD_FLOOR=0.40
# TRPG_CHRONICLE__FOLD_EMERGENCY=0.85
# TRPG_CHRONICLE__LAG_TURNS=4
# TRPG_CHRONICLE__SUMMARY_MAX_CHARS=4000
```

The defaults sit deliberately near the aggressive end of where coding agents compact, because
narration summarizes far more gracefully than code and a game re-sends its context every single turn
— cost, latency and context rot all scale with how full you keep it.

You can read it as the admin:

```
.chronicle             list the records
.chronicle summary     the rolling story-so-far
.chronicle threads     open loops: planted foreshadowing, armed consequences
.chronicle note <text> add a keeper-side annotation
.recap                 what the PLAYERS see: the same story, spoiler annotations removed
```

`.chronicle` answers only you, because it can carry keeper annotations; `.recap` is the projected,
player-safe view of the same documents.

**Small-window models:** only the foldable portion shrinks. If your fixed sections — the system
prompt, the world card, the skills — already exceed the floor on a small-context model, folding does
its best and the room stays full. That is a model/content sizing problem, not a fold bug; the fix is
a bigger window or less content in the head.

### Where the tokens actually go

Roughly, per turn: one Keeper call and one more for each round of tool calls (large, mostly cached
prefix; at most 21 calls in a turn), one call for each NPC the Keeper voices, one Scribe call (small
model, small prompt), and on beats only, one Director call. Folds are occasional. If the bill
surprises you, check in this order: (1) is the Scribe on the Keeper's model? (2) is `cache` low? (3)
was the fold trigger raised, or the context window set too large?

---

## 3. Not losing the campaign

### What's where

Everything lives in the server's data directory: `TRPG_DATA_DIR`, by default `./data` under the
directory the server was started in. A server started by *Host locally & play* keeps it in
`<local server folder>/data` — `~/.loreweaver/data` by default.

| Thing | Lives in | Treat like |
|---|---|---|
| Campaign state (every room), model settings and keys set from chat | `loreweaver.db` | the campaign — and a password file |
| Access keys | `keys.json` | a password file |
| The server's identity (the ticket) | `transport.key` | keep it, or the ticket changes |
| Pictures, sounds, report pages | `media/` | the campaign |
| Installed packs | `packs/<id>/<version>/` | re-installable |

### Backups

The dependable backup is the blunt one: stop the server, copy the whole data directory, start it
again.

A room can also be saved as one file. `.save` (`Ctrl+Shift+S` in the terminal client, or *Save the
room to a file* in its menu) stores the whole room on the server as a file only admins can fetch,
and the client downloads it to `~/.loreweaver/saves` — a private file, because it holds every secret
of the room. *Restore the room from a save file* uploads a save and replaces the room with it; every
member's connection then ends and comes back to the room as it now is. A save holds the room's
documents, state and log, **not its files**: pictures shared at the table, uploaded sounds and report
pages are not in it, and a restore removes the ones the room had. The copy of the data directory is
the only backup that holds everything.

### Undo and reset — starting over without re-provisioning

`.undo [turns]` rewinds the whole room — the story, and every command that ran after the turn began
— by one turn or more, as far back as `TRPG_STORE__UNDO_DEPTH` (default 4).

Reset restarts a campaign **in place**, keeping the keys, live connections and room settings
(language, house rules, enabled skills), so nobody has to be re-invited. Three scopes, each armed
first and then confirmed:

```
.reset            the story and progress only; characters stay
.reset chars      the story and the characters
.reset all        everything, the room's media included
.reset confirm    carry out the armed reset — within 60 seconds
```

**No backup is taken** — take one first if you might want it. Every client receives a `reset`
event, which also clears its scrollback, so a fresh start looks fresh on every screen.

### Updating

3.0 has no self-update. To update a server run from a checkout: stop it, `git pull`, `bun install`,
start it again. The ticket does not change. A client and a server must share the protocol's major
version: a client that is too old or too new is refused with a message saying which side is behind.

---

## 4. A short operating checklist

Before a session:

- Read the server's ready line: `model_not_configured`, `context_window_unknown` or `recall_off` in
  its `notes` mean what they say.
- `.model` — the right provider, and a key that still works.
- `.pack`, `.panels`, `.skill` — the module's pack, its panels and its keeper skills are actually
  **enabled**, not just installed.
- Copy the data directory if last session mattered.

During:

- Glance at `↑` and `cache` once in a while. `↑` should sawtooth, not climb forever.
- A command's answer goes to whoever ran it; only events — narration, dice, staging — reach the
  table. If keeper-grade text (`.npc show`, `.chronicle`, `.var`) ever lands in the table's log,
  that's a bug worth reporting.
- `.npc` is your hand on the room's cast: list it, `show <name>` for the full record (persona, secret
  agenda, what that NPC knows), `delete <name>` when the Keeper improvised one you do not want.
- `.bot off` mutes the Keeper while you sort something out; `.bot on` brings it back.

After:

- `.report` shows the session's scoreboard.
- `.report html` sends the whole session as one self-contained web page to the asking client (any
  player may ask for their own copy); `.report html reveal` is the admin's edition, which also prints
  what was hidden from the players — delivered to your connection only. The terminal client saves
  both under `~/.loreweaver/reports`.
- `.chronicle` / `.recap` — check the ledger actually matches what happened. If a tracker is stale or
  running *ahead* of the fiction, that's the exact failure class the Scribe was built to catch, and
  it is worth an issue.

---

## Related

| Topic | Document |
|---|---|
| Always-on deployment, systemd, keys, trust boundaries | [deploy.md](deploy.md) |
| Every setting, with defaults | [`.env.example`](../.env.example) · [deploy.md](deploy.md#configuration) |
| What players see and type | [play.md](play.md) |
| Building a module for your table | [authoring.md](authoring.md) · [the module SDK](../sdk/README.md) |
| Content moderation (off by default, and why) | [deploy.md](deploy.md#content-moderation) |
