# Playing Loreweaver — a five-minute start

*For players. If you are the one hosting, read this first anyway — you play too — then
[docs/operating.md](operating.md).*

You do not need to learn a command language to play. Type what your character does, in ordinary
words, and the Keeper takes it from there. Everything below is what makes the table *readable*: how
to roll when you want to, how to tell whether you succeeded, and what all those numbers in the
corner mean.

---

## 1. Get in

Install the client (one line, [see the README](../README.md#1-install-the-client)), run
`loreweaver`, and paste the two things your Keeper sent you:

- a **ticket** — the server's peer-to-peer address, a long string starting with `endpoint`;
- an **invite key** — yours alone, and it is also your identity: there are no accounts and no
  passwords.

Pick a nickname, press Enter. If the connection drops it reconnects on its own and picks up where it
left off, so a flaky café Wi-Fi costs you a few seconds, not the session.

> If the screen looks broken on Windows — mangled borders, wrong colours, no mouse — you are in the
> legacy console host. Run `loreweaver` inside **Windows Terminal** or **WezTerm** instead.

## 2. Make a character

The character screen offers four routes, and they all end in the same place: the rules validate the
sheet, and an invalid one does not get saved no matter where it came from.

| Route | What it does |
|---|---|
| **Auto roll** | rolls attributes by the system's own creation formulas |
| **Manual** | you type the numbers; over-budget stats are blocked as you type |
| **From a description** | write a sentence ("calm doctor investigating disappearances in a foggy port") and the AI drafts a sheet, which the rules then check |
| **Import a card** | a SillyTavern V2/V3 card, PNG or JSON — see [cards.md](cards.md) |

If the Keeper has imported a module with a pre-generated cast, there is a fifth route: claim one.

```
.pc                    list the module's cast and who has claimed whom
.pc claim 顾晚棠        take that character as yours
.pc release            give it back (the sheet resets to pristine)
```

## 3. Six things worth knowing

**Roll your own dice.** `.r` (or `/roll`) takes any dice expression:

```
.r 3d6+2
Roll: 3d6+2 = [4, 4, 1]+2 = 11
```

`4d6kh3` keeps the highest three; `2d20kl1` keeps the lowest; `5d6!` explodes; `7d10>=8` counts
successes. `.rh` rolls the same way but the result comes back only to you.

**Make a check.** `.ra` (`/check`) rolls against a skill on your sheet, resolved by the rule system
your table is running:

```
.ra spot hidden
Check Spot Hidden: target 25 (effective 25), roll 13 -> Success
```

A difficulty word in front raises the bar — the target you must beat shrinks, and the line tells you
so:

```
.ra hard spot hidden
Check Spot Hidden: target 70 (effective 35), roll 13 -> Extreme Success
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
prints a different ladder, in its own vocabulary, because the ladder is data that ships with the
system.

**Failure is a direction, not a wall.** A missed check is supposed to move the story, not stop it.
If you are stuck after a failure, say what you try instead — that is the game working.

**Your sheet.** `.st` shows it; `.st <skill><value>` edits it, if your Keeper allows edits:

```
.st STR60              attribute abbreviations work
.st spot hidden 70     so do spelled-out skill aliases
.st 侦查70              and canonical names
```

Everything you write is validated against the rule system — the engine will refuse a number the
system does not permit, whoever asked for it.

**Catch up on the story.** `.recap` prints the campaign so far, spoiler-free:

```
.recap
```

The recap is a real document the Keeper can edit, and its player view is produced by the same
projection that keeps every other secret out of your client — keeper annotations about what you
*missed* are structurally not in it. Late joiner? This is your on-ramp.

## 4. The screen

```
┌─ ◷ 03:12 · scene · round 2 ────────────────── ● online · ctx 34% · cache 71% ─┐
│                                                                              │
│  the story log — narration, NPC lines, dice results, module handouts         │  ← sidebar:
│                                                                              │    party roster,
│                                                                              │    your resources,
│                                                                              │    module panels
└──────────────────────────────────────────────────────────────────────────────┘
  > type here
```

- The **top bar** carries the in-game clock and scene, the combat round, a connection light, and the
  table's token spend. `ctx` is how full the Keeper's context window is right now — when it climbs,
  the engine folds old history into a summary on its own, so you do not have to care. `cache` is the
  share of the prompt that was served from the provider's prompt cache; higher is cheaper.
- The **sidebar** shows who is at the table (AI companions included), your own vitals as live meters,
  and any panels the module ships — a festival calendar, a tide gauge, a case board. Panels are drawn
  from the same data the server sent you, so nothing appears there that you were not meant to see.
- **Media** — handouts, portraits, maps — arrive inline. Select one and press `o` to open it in your
  system viewer. Some modules hide real clues in pictures; that is intended.

## 5. Keys

| Key | Does |
|---|---|
| `?` | open / close the help overlay |
| `Esc` | back to the menu (from the menu, nothing — the menu is the top level) |
| `PgUp` / `PgDn` | scroll the story log |
| `↑` / `↓` | recall what you typed before |
| `Tab` | cycle focus: input → inline choice buttons → party roster → input |
| `F1`–`F5` | themes: lamplight · df16 · phosphor · amber · paperwhite |
| `F6` | show / hide the sidebar on a narrow terminal |
| `Ctrl+S` | save the session log to a file |
| `Ctrl+L` | clear the on-screen log (the server keeps the campaign) |
| `o` | open the selected image/audio in your system viewer |
| `Ctrl+C` | copy the selection — or quit when nothing is selected. On macOS, select with `Option`-drag and copy with `Cmd+C`; the terminal owns those |

## 6. Commands you might actually want

`.help` lists every command your table has. These are the ones players reach for:

| Command | Does |
|---|---|
| `.r <expr>` | roll dice yourself |
| `.rh <expr>` | roll privately — only you see it |
| `.ra <skill>` | a skill check |
| `.ra hard <skill>` | a check at a raised difficulty |
| `.rav <mine> <theirs>` | an opposed check — `.rav 侦查 隐匿` → `Opposed Spot Hidden roll 13 Success vs Stealth roll 94 Failure: left` |
| `.st` | show your sheet |
| `.st <skill><value>` | edit a stat (validated) |
| `.sc <success>/<failure>` | a sanity check, in systems that have one — `.sc 1/1d6` |
| `.ri` | roll into the initiative order, or show it |
| `.pc` | the module's pre-generated cast |
| `.recap` | the spoiler-free story so far |
| `.report` | export a session report, once the session has something to export |
| `.jrrp` | today's luck, for no mechanical reason whatsoever |

Both dialects work at once: the Chinese SealDice style (`.ra 侦查`, `.st 力量50`, `.sc 1/1d6`) and
the English Avrae style (`/roll 4d6kh3`, `/check`). Use whichever your fingers know. The complete
reference, including everything the Keeper can do, is the
[player command manual](https://1a7432.site/commands-en.html).

## 7. What the AI can and cannot do to you

Worth knowing, because it changes how you play:

- **It cannot fake a roll.** Every check goes through the dice engine. The Keeper narrates the
  result; it does not choose it.
- **It cannot quietly change your sheet.** Every write is validated against the rule system, whoever
  requested it — you, the Keeper, or the model.
- **NPCs do not have X-ray vision.** An NPC or AI companion is built from its own record and sheet
  and nothing else, so it cannot know a secret it was never given. The Keeper itself *is* shown the
  module's secrets — it has to be, to run a mystery — and is instructed not to repeat them. That last
  part is a behavioural constraint, measured by a
  [nightly evaluation](https://github.com/1A7432/loreweaver/actions/workflows/redline-eval.yml), not
  a structural guarantee. If a Keeper ever hands you something it obviously should not have, that is
  a bug worth reporting.
- **The dice do not care about the plot.** You can fail. That is the point.

---

*Next: [running a table](operating.md) · [authoring a module](authoring.md) ·
[the full command manual](https://1a7432.site/commands-en.html)*
