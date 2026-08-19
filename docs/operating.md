*English · [中文](operating.zh.md)*

# Running a table

*For the person hosting: choosing models, keeping the bill sane, and not losing a campaign.*

This is about **operating a game**. If you want to stand up an always-on server — systemd, keys on
disk, the trust model — that is [deploy.md](deploy.md), and the two are meant to be read together.

---

## 1. Models

Loreweaver can run **three** model clients at once, and they do very different jobs. Getting the
sizes right is the single biggest lever on both quality and cost.

| Actor | Runs | Default | Wants |
|---|---|---|---|
| **Keeper** (KP) | every turn | `TRPG_LLM__*` | the strongest model you're willing to pay for |
| **Scribe** (书记官) | every turn, after the reply | reuses the Keeper's client | a small, cheap, fast model |
| **Director** (演出导演) | on story beats only | reuses the Keeper's client | the same model as the Keeper — beats are rare and taste is the job |

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

A note on `REASONING_EFFORT`: on thinking models, don't set a temperature alongside it. Thinking mode
ignores temperature and a low value degrades the reasoning trace — omit it and let the provider
default.

Most vendors work through the OpenAI-compatible path plus a preset:

```console
$ .model list
Providers — OpenAI-compatible: deepseek, fireworks, groq, lmstudio, mistral, moonshot, ollama,
openai, openrouter, together, vllm, xai, zhipu; native: anthropic, gemini; subscription: chatgpt,
gpt-subscription, supergrok. Any OpenAI-compatible endpoint works by pointing base_url at it.
Subscription providers need `.model login` first.
```

Switching is hot — no restart, mid-session is fine:

```
.model                          show the current provider/model (private to you)
.model set <provider> [model]   switch
.model key <api_key>            set the current provider's key
.model login chatgpt            device-code OAuth for a ChatGPT subscription
.model login supergrok          the same for SuperGrok
.model reset                    drop the runtime override, back to .env
```

Keys are remembered **per provider**, so switching back to one you've used before doesn't re-ask. A
new `base_url` is never paired with an older key: supply the matching key on the same request, or the
endpoint gets an empty one. Keeper clients can do all of this from the model screen instead.

### The Scribe — small model, real job

The Scribe is on by default and runs one extra call after every Keeper turn — on every channel,
the offline `--cli` loop included (there it runs inline before the prompt returns; only the
Director stays hub-only, since everything it stages is wire frames a hubless channel cannot
deliver). It reconciles the
module's trackers against what was actually narrated (evidence-quoted; it cannot write a tracker it
cannot cite), whispers judgment calls into the Keeper's *next* turn ("a day seems to have passed",
"that horror beat may have warranted a sanity check"), and classifies the turn's story beat for the
Director.

Blank `TRPG_SCRIBE__*` fields reuse the main client — correct, but it means paying flagship prices
for clerical work, on every single turn. `--doctor` will tell you when you're doing that:

```console
$ uv run python -m app --doctor
Loreweaver doctor
Version: 1.0.1.dev17+g74c9efa
Mode: source
Locales: en (29 files), zh (29 files)
Rulepacks: coc7 (resolution: dsl +6 variants; subsystems: sanity_check, skill_growth, spend_luck,
opposed_check, random_madness), dnd5e (resolution: dsl; subsystems: opposed_check), wod (resolution: dsl)
KP skills: image-gen, mature-mode, module-forge, romance-relationships, rule-forge, skill-forge, svg-mapmaker (7)
Data dir: ./data
NOTE: the Scribe is paying flagship prices for ledger work (xai / grok-4.5). It runs one extra call
after every AI-KP turn. Point TRPG_SCRIBE__* at a small, cheap model — see .env.example.
OK: all checks passed
```

Give it its own small model:

```dotenv
TRPG_SCRIBE__PROVIDER=deepseek
TRPG_SCRIBE__CHAT_MODEL=deepseek-v4-flash
TRPG_SCRIBE__API_KEY=sk-…
TRPG_SCRIBE__REASONING_EFFORT=low
```

`TRPG_SCRIBE__ENABLED=0` turns it off. Before you do: the reason it exists is that a live playtest
watched a strong narrative model run an entire module without touching the state layer once —
trackers frozen at their defaults while the fiction sprinted three days ahead. With the Scribe on,
the same module's trackers moved with the story. Bookkeeping does not survive on model discipline.

> `--doctor` reports the *bundled* catalogs — locales, built-in rulepacks, built-in skills — plus the
> resolved data dir. Packs installed into the data dir are not listed there; check those in-room with
> `.panels` and `.skill`.

### The Director — optional, and three things have to agree

The Stage Director stages story beats: act cards, letters, newspaper clippings, map pins, audio cues,
and generated art. It defaults to the **main** model, which is the opposite of the Scribe's advice —
beats are rare and the job is taste.

**It only wakes up if a module asks for it**: it runs only in a room whose enabled module ships a
`ui/presentation.yaml`. A table with no such module never wakes one and is never charged for it.
Image generation additionally needs all three of these to agree:

1. `TRPG_DIRECTOR__IMAGES=1`,
2. a configured `TRPG_IMAGEGEN__*` endpoint,
3. the module's own kit — and if its author wrote `generation: pack_only`, that is the author's
   call, and nothing you set on your side overrides it.

```dotenv
# TRPG_DIRECTOR__ENABLED=1
# TRPG_DIRECTOR__CHAT_MODEL=          # blank = the main Keeper client
# TRPG_DIRECTOR__IMAGES=1
# TRPG_DIRECTOR__MAX_IMAGES=24        # per ROOM lifetime, not per session
# TRPG_DIRECTOR__PREGEN_PER_BEAT=2
```

`MAX_IMAGES` is a lifetime cap per room (rooms are long-lived campaigns). Past it the Director keeps
staging with pack art and already-generated subjects and simply stops spending.

### Local models

Point `TRPG_LLM__PROVIDER` at `ollama` or `lmstudio` when prompts must not leave your machine. This
is the only configuration in which module text, keeper-only lore and player input stay on
infrastructure you control — self-hosting the *server* does not by itself make model traffic local.

---

## 2. Quota, latency and the token bill

### Read the HUD

The top bar of every client carries two numbers that tell you almost everything:

```
● online · ctx 34% · cache 71%
```

- **`ctx`** — how full the Keeper's context window was on the most recent turn. Watch it climb across
  a session; you should see it fall back on its own (section below). If it never falls, something is
  wrong with the fold.
- **`cache`** — the share of that prompt served from the provider's prompt cache. Higher is cheaper
  and faster. A healthy long session sits high; a number that keeps collapsing means the prompt
  prefix is being invalidated every turn.

### Why the prompt is laid out the way it is

The system prompt is deliberately split into a **stable head** and a **volatile tail**. Identity,
system expertise, interaction style, the module knowledge pool, enabled skills and the rolling
campaign summary go first and change rarely; retrieved world lore, open threads, live trackers and
anything else that moves goes last. On providers with explicit prompt caching, the boundary between
them becomes a cache breakpoint.

The campaign summary sits up front even though it does change, because it only ever changes when a
fold runs — and a fold also stops replaying the turns it absorbed, which costs that turn's cache
anyway. Every other turn it is read straight from the cache.

The practical consequence for you: **anything that changes the head invalidates the whole cache**.
Switching models, enabling or disabling a skill, or importing a module mid-session all legitimately
do that — just expect the next turn to be a cache miss, and don't do them idly every few turns.

### When the provider throttles you

Every provider path retries a 429 or an overloaded response with bounded, jittered backoff. A
throttled turn gets **slower, never dead**. Watch the server log for `LLM throttled` lines; if you
see them often, the table is outrunning your plan's rate limit. The first fix is not a bigger plan —
it is giving the Scribe (and the Director, if you run one) their own smaller model and key instead of
sharing the Keeper's.

### Campaign memory folds itself

Long campaigns outlive any context window. Play is recorded as chronicle documents, and when the
assembled prompt crosses **60%** of the model's context window, the oldest records fold in batches
into a running summary of the campaign until it is back under **40%**. An emergency ceiling at
**85%** forces a fold before the next call — the ceiling exists so the fold call itself always has
headroom. The last **4** turns are never folded: an in-flight scene is not summarizable history yet.

Ratios, not absolute token counts, so every window size behaves the same:

```dotenv
# TRPG_CHRONICLE__FOLD_TRIGGER=0.60
# TRPG_CHRONICLE__FOLD_FLOOR=0.40
# TRPG_CHRONICLE__FOLD_EMERGENCY=0.85
# TRPG_CHRONICLE__LAG_TURNS=4
# TRPG_CHRONICLE__SUMMARY_MAX_CHARS=4000
```

The defaults sit deliberately near the aggressive end of where coding agents compact, because
narration summarizes far more gracefully than code and a game re-sends its context every single turn
— cost, latency and context rot all scale with how full you keep it.

You can drive it by hand:

```
.chronicle             list the records                    -> No chronicle records yet.
.chronicle summary     the rolling story-so-far            -> No campaign summary exists yet — it is created by the first fold.
.chronicle threads     open loops: planted foreshadowing, armed consequences
.chronicle fold        fold now, at whatever fullness you're at
.chronicle edit <text> replace the summary — it is an ordinary editable document
.chronicle note <text> add a keeper-side annotation
.recap                 what the PLAYERS see: the same story, spoiler annotations removed
```

`.chronicle` replies are unicast to the caller because they can carry keeper annotations; `.recap` is
the projected, player-safe view of the same documents.

**Small-window models:** only the foldable portion shrinks. If your fixed sections — module plus
system prompt — already exceed the floor on a small-context model, folding does its best and the room
stays full. That is a model/module sizing problem, not a fold bug; the fix is a bigger window or a
smaller module.

### Where the tokens actually go

Roughly, per turn: one Keeper call (large, mostly cached prefix), one Scribe call (small model, small
prompt), and on beats only, one Director call. Folds are occasional and use the main client. If the
bill surprises you, check in this order: (1) is the Scribe on the main model? (2) is `cache` low? (3)
is `ctx` sitting high because the fold trigger was raised?

---

## 3. Not losing the campaign

### What's where

| Thing | Lives in | Treat like |
|---|---|---|
| Campaign state (all of it) | `<data_dir>/loreweaver.db` | the campaign |
| Media blobs | `<data_dir>/media/<room>/` | the campaign |
| Installed packs | `<data_dir>/packs/<id>@<version>/` | re-installable |
| Access keys | `keys.toml` (or `--keys` / `TRPG_TUI_KEYS`) | a password file |
| Provider credentials | inside the SQLite DB, **unencrypted** | a password file |
| Room backups | `<data_dir>/room_backups/` | a password file — they contain raw keys |

`TRPG_DATA_DIR` moves the first three. The keystore path is independent of it.

### Backups

From a Keeper client, *Rooms & invites* has **Export room backup** and **Import room backup**. A
backup is a server-side JSON snapshot confined to `<data_dir>/room_backups/`; leaving the path blank
auto-names it. It contains room state, vector data, self-contained media blobs — **and the room's raw
access keys**. Protect it exactly like `keys.toml`, and never put one in a public repo or a chat.

Import can remap a snapshot to a different room name, which is how you clone a campaign for testing.

The blunt instrument still works and is worth having: stop the server, copy the whole data directory,
start it again.

### Reset — starting over without re-provisioning

Reset restarts a campaign **in place**, keeping the keystore, bindings, live connections and room
settings (language, house rules, enabled skills), so nobody has to be re-invited. Three scopes:

```console
$ .reset
This will permanently clear the story and progress only (keeping your characters, the module, lore
and media). Room settings (language, house rules) and connections survive. Send `.reset confirm`
within 120s to proceed.

$ .reset all
This will permanently clear EVERYTHING — characters, the module, lore, media and story. Room settings
(language, house rules) and connections survive. Send `.reset confirm` within 120s to proceed.
```

- `.reset` — story and progress only. Characters, module, lore and media stay.
- `.reset chars` — also rolls new characters. The module stays.
- `.reset all` — erases everything.

Each needs `.reset confirm` within 120 seconds. **No backup is taken** — take one first if you might
want it. Clients receive a state frame marked `reset`, which also clears their local chat scrollback,
so a fresh start looks fresh on every screen.

If you want the room *gone* rather than restarted, the Keeper screen's **Delete full room** takes a
backup first by default and then removes keys, room state and vectors.

### Self-update

A Keeper updates the server from *Rooms & invites* — no SSH. The screen shows the server and client
versions and offers **Update server** when the client is newer. Pressing it runs the server's **own**
configured command (`TRPG_TUI__UPDATE_COMMAND`, default `git pull --ff-only && uv sync`) and then
re-execs the process into the new code — **same PID, so the Iroh ticket does not change** and nobody
needs a new invite. Clients blink and reconnect.

```dotenv
TRPG_TUI__UPDATE_COMMAND=git pull --ff-only && uv sync    # default (git checkout)
# TRPG_TUI__UPDATE_COMMAND=                               # blank -> button hidden, feature off
```

The security property that makes this acceptable: a client can only ask the server to run *its own*
configured command, never supply one. The Keeper key is the trust boundary, same as for `.model`.

From your own machine, `loreweaver update` reinstalls the client and then does the same server update
through your saved keeper connection, so one command keeps both in step;
`loreweaver update --client-only` skips the server half.

**Pinning.** The installer follows the newest published release, and development builds are published
as ordinary releases — so "latest" means newest, not newest stable. Set `TRPG_RELEASE_TAG=<tag>`
in the environment that runs the installer to hold a table on a known build, or fetch a specific
release's own installer, which pins itself. `TRPG_SERVER_RELEASE_TAG` pins only the one-click server.

---

## 4. A short operating checklist

Before a session:

- `uv run python -m app --doctor` — catalogs load, data dir is where you think, and no Scribe cost
  warning.
- `.model` — the right provider, and a key that still works.
- `.panels` / `.skill` — the module's panels and its keeper skill are actually **enabled**, not just
  installed.
- Take a backup if last session mattered.

During:

- Glance at `ctx` and `cache` once in a while. `ctx` should sawtooth, not climb forever.
- If replies get slow, check the log for `LLM throttled` before blaming the model.
- Keeper-only replies (`.model`, `.lore`, `.chronicle`, `.var`, `.npc`) are unicast to you by design
  — if you ever see one land in the room's log, that's a bug worth reporting.
- `.npc` / `.companion` are your hand on the room's cast: list it, `show <name>` for the full record
  (persona, secret agenda, what that NPC knows), `delete <name>` when the Keeper improvised one you
  do not want. Deleting leaves any character sheet in place.
- `.panel` reads a module's panels as text — useful on a terminal, and the fastest way to see what a
  player's panel is actually showing them.

After:

- `.report` exports a session report — the scoreboard on its own, or `.report full` for the keepsake:
  every dice roll with its result, and the table's whole conversation.
- `.chronicle` / `.recap` — check the ledger actually matches what happened. If a tracker is stale or
  running *ahead* of the fiction, that's the exact failure class both playtests were built to find,
  and it is worth an issue.

---

## Related

| Topic | Document |
|---|---|
| Always-on deployment, systemd, keys, trust boundaries | [deploy.md](deploy.md) |
| Every setting, with defaults | [`.env.example`](../.env.example) · [deploy.md](deploy.md#configuration) |
| What players see and type | [play.md](play.md) |
| Building a module for your table | [authoring.md](authoring.md) |
| Content moderation (off by default, and why) | [deploy.md](deploy.md#content-moderation) |
