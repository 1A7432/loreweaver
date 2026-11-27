*English · [中文](play.zh.md)*

# Playing Loreweaver — a five-minute start

*For players. If you are the one hosting, read this first anyway — you play too — then
[Running a table](operating.md).*

You do not need to learn a command language to play. Type what your character does, in ordinary
words, and the Keeper takes it from there. Everything below is what makes the table *readable*: how
to roll when you want to, how to tell whether you succeeded, and what all those numbers in the
corner mean.

---

## 1. Get in

Loreweaver 3.0 has no published release yet, so the client runs from a checkout of the repository
([see the README](../README.md#1-get-the-code)), with [Bun](https://bun.sh) installed:

```bash
cd clients/tui && bun run dev
```

The desktop client's 3.0 version (Loreweaver Studio, branch `v3` of its repository) is not released
yet; this terminal client is the one to use. On the connect screen, paste the two things your room admin sent you:

- a **ticket** — the server's peer-to-peer address, a long string starting with `endpoint`;
- an **access key** — yours alone, and it is also your identity: there are no accounts and no
  passwords.

Pick a nickname, press Enter. If the connection drops it reconnects on its own and picks up where it
left off, so a flaky café Wi-Fi costs you a few seconds, not the session. The connect screen
remembers the servers you used; click one to fill it in again.

> If the screen looks broken on Windows — mangled borders, wrong colours, no mouse — you are in the
> legacy console host. Run the client inside **Windows Terminal** or **WezTerm** instead.

## 2. Make a character

Open **My character** from the main menu. Whatever route a character takes, the rules check the
sheet: a number the system does not allow is brought back into range, and you are told so.

| Route | What it does |
|---|---|
| **New character** | the server rolls one by the rule system's own creation rules; you pick the system and, if you like, a name |
| **Claim a ready-made character** | take one the room offers — a pack's pregens, for example |
| **Import a character card** | a SillyTavern card, PNG or JSON — only the character comes in, see [cards.md](cards.md); the sheet is rolled for the room's rule system, leaning toward the card's persona when a model is configured |
| **From a description** | type `.genchar <description>` ("a calm doctor investigating disappearances in a foggy port"): the model proposes a concept, and the dice and the rule system make the numbers |

The same screen edits the sheet, renames the character, re-derives its vitals, releases it or
deletes it. From the input line, the roster of ready-made characters is:

```
.pc                    list the characters on offer and who plays whom
.pc claim 顾晚棠        take that character as yours
.pc release            give it back
```

## 3. Six things worth knowing

**Roll your own dice.** `.r` (or `/roll`) takes any dice expression:

```
.r 3d6+2
⚄ Alice 3d6+2 11
```

`4d6kh3` keeps the highest three; `2d20kl1` keeps the lowest; `5d6!` explodes; `7d10>=8` counts
successes. `.rh` rolls the same way but the result comes back only to you.

**Make a check.** `.ra` (`/check`) rolls against a skill on your sheet, resolved by the rule system
your table is running:

```
.ra spot hidden
⚄ Alice 1d100 13 vs 25 -> Success
```

A difficulty word in front raises the bar — the target you must beat shrinks, and the line shows the
target you actually rolled against (here with Spot Hidden at 70):

```
.ra hard spot hidden
⚄ Alice 1d100 13 vs 35 -> Extreme Success
```

Skill names accept aliases in both languages: `spot hidden`, `spot`, `notice`, `perception`, `侦查`,
`侦察`, `发现` all reach the same skill.

**Read the result, not the number.** Success tiers come from the rule system's own ladder, not from
a hardcoded table. Under CoC 7e a d100 check grades like this:

| Result | Means |
|---|---|
| Critical Success | the natural 1 |
| Extreme Success | you rolled within a fifth of your skill |
| Hard Success | within half |
| Success | at or under your skill |
| Failure | over it |
| Fumble | 96–100 on a skill under 50, or a natural 100 |

Higher tiers are not just "more successful" — a module can gate a clue behind a *hard* success
specifically. That is why the line prints the tier and not only pass/fail. A different rule system
prints a different set of tiers, with its own names for them, because that table is data shipped with the
system.

**A failed check should move the story, not stop it.** If you are stuck after a failure, say what
you try instead. Being pushed onto a worse plan is the game working, not the game breaking.

**Your sheet.** `.st` shows it; `.st <name>=<value>` edits it:

```
.st 力量=60             = assigns exactly that number
.st HP-=4              -= subtracts, += adds
.st 力量60 敏捷50        the dice-bot form, several at once
```

A value may be dice. Everything you write is checked against the rule system — the engine brings a
number the system does not permit back into range, whoever asked for it, and says so.

**Catch up on the story.** `.recap` prints the campaign so far, spoiler-free:

```
.recap
```

The recap is made from the campaign's chronicle by the same projection that keeps every other
secret out of your client — keeper annotations about what you *missed* are not in there at all.
Just joined a campaign in progress? Start here.

## 4. The screen

```
┌─ joined main · scene ◷ dusk · round 2 ──────── ● · last turn ↑2.0k ↓120 · cache 75% ─┐
│                                                    │ sidebar                          │
│  the story log — narration, NPC                    │ party · your character · scene   │
│  lines, dice results, handouts                     │ trackers · module panels         │
└────────────────────────────────────────────────────┴──────────────────────────────────┘
  > say or command
```

- The **top bar** carries the room, the scene, the in-game clock and the combat round, the state of
  the connection, and the last turn's token figures: `↑` what the Keeper read, `↓` what it wrote, and
  `cache` — the share of the prompt that was served from the provider's prompt cache; higher is
  cheaper.
- The **sidebar** shows who is at the table and the initiative order, your own character, the scene
  and the facts it has established, the trackers you may see, and any panels the module ships — a
  festival calendar, a tide gauge, a case board. Panels are drawn from the same data the server sent
  you, so nothing appears there that you were not meant to see. A panel that needs a richer client
  says so in one line.
- **Pictures** — handouts, portraits — arrive inline. Press `Tab` to reach them, then `Enter` (or
  click one) to view it; a terminal that cannot draw it opens your system's image viewer. Some
  modules hide real clues in pictures; that is intended. `F8` shares a picture of your own with the
  table.
- **Sound** — the room's music, ambience and effects play through a player on your computer (mpv,
  ffplay, afplay, paplay or aplay). `F9` mutes it.

## 5. Keys

| Key | Does |
|---|---|
| `?` | open / close the help overlay |
| `Esc` | back to the menu |
| `PgUp` / `PgDn` | scroll the story log; `PgUp` at the top loads older history |
| `↑` / `↓` | recall what you typed before |
| `Tab` | cycle focus: input → choice buttons → pictures → party roster → panels → input |
| `F1`–`F5` | themes: lamplight · df16 · phosphor · amber · paperwhite |
| `F6` | show / hide the sidebar on a narrow terminal |
| `F7` | the command list — everything you can type, with its usage |
| `F8` | share a picture with the table |
| `F9` | sound on / off |
| `Ctrl+S` | save the session log to a file (`~/.loreweaver/transcripts`) |
| `Ctrl+L` | clear the on-screen log (the server keeps the campaign; `PgUp` at the top shows it again) |
| `Ctrl+C` | copy the selection — or quit when nothing is selected. On macOS, select with `Option`-drag and copy with `Cmd+C`; the terminal owns those |

## 6. Commands you might actually want

`.help` (or `F7`) lists every command your table has. These are the ones players reach for:

| Command | Does |
|---|---|
| `.r <expr>` | roll dice yourself |
| `.rh <expr>` | roll privately — only you see it |
| `.ra <skill>` | a skill check |
| `.ra hard <skill>` | a check at a raised difficulty |
| `.rav <skill>, <other skill>` | an opposed check, in systems that have one |
| `.st` | show your sheet |
| `.st <name>=<value>` | edit a value (checked against the rules) |
| `.sc <success>/<failure>` | a sanity check, in systems that have one — `.sc 1/1d6` |
| `.ri` | show the initiative order; `.ri roll` rolls you into it |
| `.pc` | the characters on offer |
| `.genchar <description>` | a character from a description |
| `.<module>/<command> {…}` | a module's own command, with its arguments as JSON — the command list shows what your table's modules offer |
| `.recap` | the spoiler-free story so far |
| `.report` | the session's scoreboard |
| `.report html` | the whole session as one self-contained web page, sent to **your** client only — the terminal client saves it under `~/.loreweaver/reports` for you to open in a browser |
| `.report html reveal` | admin only: the reveal edition, which also prints what was hidden from the players. Delivered to the admin's connection alone |
| `.jrrp` | today's luck, for no mechanical reason whatsoever |
| `.draw` | draw a card from a shuffled deck |

Both dialects work at once: the Chinese SealDice style (`.ra 侦查`, `.st 力量50`, `.sc 1/1d6`) and
the English Avrae style (`/roll 4d6kh3`, `/check`). Use whichever your fingers know. The complete
reference, including everything the room admin can do, is
[the protocol's command table](protocol.md#68-the-engines-commands).

## 7. What the AI can and cannot do to you

Worth knowing, because it changes how you play:

- **It cannot fake a roll.** Every check goes through the dice engine. The Keeper narrates the
  result; it does not choose it.
- **It cannot quietly change your sheet.** Every write is checked against the rule system, whoever
  requested it — you, the room admin, or the model.
- **NPCs do not have X-ray vision.** An NPC is built from its own record and sheet and nothing else,
  so it cannot know a secret it was never given. The Keeper itself *is* shown the module's
  secrets — it has to be, to run a mystery — and is instructed not to repeat them. That last part is
  a behavioural constraint, measured by live-model play-tests, not a structural guarantee. If a
  Keeper ever hands you something it obviously should not have, that is a bug worth reporting.
- **The dice do not care about the plot.** You can lose, and a lot of the tension comes from that.

---

*Next: [running a table](operating.md) · [authoring a module](authoring.md) ·
[the full command table](protocol.md#68-the-engines-commands)*
