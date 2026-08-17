*English · [中文](authoring.zh.md)*

# Authoring a Loreweaver module

*From an empty directory to an installable `.lwpack`, with a real module as the worked example.*

This is the hands-on tutorial. The specification — every field, every limit, every trust rule —
is [plugins.md](plugins.md); when the two disagree, that one is right. What you get here is the
order to do things in, and real files rather than invented ones.

**The worked example** is 《汐浦送灯》 (*Xipu: The Lantern Sending*) — a real module, a 1925
coastal-town mystery, played twice end to end by live models. Its own files are not published here
(publishing a solved mystery spoils it), so treat the paths below as the shape of a pack rather than
something to clone; every snippet is quoted in full, so this page stands on its own.

---

## 0. The shape of a module

One directory. One manifest. Everything else is optional.

```
xipu-songdeng/
  pack.yaml                     the manifest — the only required file
  cards/
    shipu.lorecard.json         the module itself: lore, cast, trackers, hooks
    chaomai-st.json             a SillyTavern card, imported as-is
  rulepacks/
    coc7-xipu.yaml              a PATCH on CoC 7e: one skill, one night ladder, one madness table
    chaozhan.yaml               a whole standalone mini-system, pure data
  lorebooks/
    yuyan.json                  a standalone lorebook
  skills/
    yingchao-zhuchi/
      SKILL.md                  how the Keeper should RUN this module (procedure, not story)
      hooks.js                  sandboxed turn-lifecycle behaviour
  ui/
    panels.yaml                 the table's instruments
    presentation.yaml           the Stage Director's creative brief
    dengzhen/                   a tier-2 panel: a real HTML/JS page
  assets/
    *.png *.mp3                 handouts, portraits, music
```

A minimal manifest is six fields:

```yaml
id: harbour-bell            # lowercase slug; names the packs/<id>@<version> install dir
version: 0.1.0              # semver
name:
  en: The Harbour Bell
  zh: 港钟
description:
  en: A one-shot for two to four investigators.
  zh: 一个 2-4 人的单本。
authors: [ada]
license: CC-BY-4.0
contents:
  cards: [cards/harbour-bell.lorecard.json]
```

```console
$ uv run python -m app --pack harbour-bell/
Packed harbour-bell@0.1.0 -> …/harbour-bell/harbour-bell-0.1.0.lwpack
   sha256: caeb3bc8e949a887b1c9b64dcf8565413c8120ab7ef1a07658f585c93410cd98
📦 The Harbour Bell — harbour-bell@0.1.0
   A one-shot for two to four investigators.
   by ada · license: CC-BY-4.0
   contains: 0 skill(s), 0 rulepack(s), 1 card(s), 0 lorebook(s), 0 UI panel(s), 0 asset(s) (0.0 MB) · hooks code: no · EJS templates: no
Contains 1 WORLD card(s) — module machinery (hooks/variables/EJS); the keeper imports them with `.import <file> world`.
```

That last line is worth pausing on, and section 1 explains it. Note also what you did *not* write:
no file list, no hashes, no trust declaration. Those are computed at build time, and install
recomputes them and refuses a mismatch — so a hand-assembled archive cannot understate what it
ships.

---

## 1. The module document: `*.lorecard.json`

A Loreweaver-native card is a flat JSON object. It is the module's own format, so it keeps the
things a SillyTavern card has no safe place for: keeper-only lore, typed trackers, a claimable cast,
per-entry conditions, stable ids, hook scripts.

```json
{
  "format": "loreweaver.card",
  "format_version": 1,
  "name": "汐浦送灯",
  "description": "一九二五年，浙东沿海渔镇汐浦。十二年一度的迎潮节为期三日……",
  "scenario": "调查员一行乘晚船抵达汐浦，入住望潮客栈，正逢迎潮节前夜。",
  "tags": ["调查", "民俗恐怖", "coc7", "三日祭"],
  "opening":  "…",
  "alternate_openings": ["…"],
  "author_notes": "…",
  "worldbook": [ … ],
  "variables":  [ … ],
  "pregens":    [ … ],
  "hooks":      [ "on('variables_changed', …)" ]
}
```

### Top level, field by field

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | must be the literal `"loreweaver.card"` |
| `format_version` | yes | `1`. Older documents upgrade through registered migrations; anything newer than the running build is refused cleanly rather than half-read |
| `name` | yes in practice | the module's name |
| `description` | | the pitch — what this is |
| `personality` | | for a character card; a module usually leaves it empty |
| `scenario` | | the situation at turn zero |
| `tags` | | free-form strings |
| `opening` | | the module's opening text |
| `alternate_openings` | | other ways in |
| `dialogue_examples` | | voice samples, for a character card |
| `author_notes` | | notes to the Keeper that are not lore |
| `worldbook` | | the lore entries — see below |
| `variables` | | typed trackers — see below |
| `pregens` | | the claimable cast — see below |
| `hooks` | | JavaScript sources, or `{code: "…"}` objects |

Caps that matter: 512 worldbook entries, 128 KB per entry, 256 variables, 8 pregens. Passing one is
fatal. *Entry-level* junk is different — a malformed lore row or an unusable variable spec is
skipped and reported as a warning, so one bad row never costs you the whole import.

### `worldbook[]` — what the author wrote

```json
{
  "id": "xipu-town",
  "title": "汐浦镇概览",
  "content": "汐浦倚山面海，一条石板长街自码头通到山脚灯官祠。要处五所：望潮客栈…",
  "keys": ["汐浦", "镇", "街", "码头", "地图"],
  "category": "lore",
  "secret": false,
  "constant": true,
  "priority": 10,
  "enabled": true
}
```

| Field | Meaning |
|---|---|
| `id` | **stable, author-owned**, and worth setting. With the pack id it forms the cross-pack handle `<pack-id>#<entry-id>` — how a serialized module's second installment points at the shared world's canonical entries instead of copying them. Keep it stable across versions |
| `title` | shown to the Keeper; defaults to `Untitled Lore` |
| `content` | the entry text. Required — an empty one is skipped with a warning |
| `keys` / `secondary_keys` | activation keywords. Secondary keys gate the entry: `selective_logic` picks `and_any` (default) / `and_all` / `not_any` / `not_all` |
| `secret` | **keeper-only.** Honored only on a keeper import; a player import drops it outright, so marking an entry secret can never widen anyone's visibility |
| `constant` | always-on. Forced off for uploaded files — an always-on entry would inject itself into every prompt regardless of keywords |
| `condition` | an expression; rides in as an `@@if` decorator. Longer than 500 characters and it will never fire, and you get a warning saying so |
| `priority`, `enabled`, `probability` (0–100, rolled by real code), `case_sensitive`, `match_whole_words`, `scan_depth`, `position` (`before`/`after`), `sticky`, `cooldown`, `delay` | SillyTavern World Info trigger semantics, imported and honored |

**Write your secrets as `secret: true` entries, not as prose the Keeper is asked to keep quiet
about.** That flag is the thing the projection layer enforces.

### `variables[]` — trackers the engine owns

```json
{"id": "祭典日",   "kind": "number", "labels": {"en": "Festival Day", "zh": "祭典日"},
 "default": 1, "minimum": 1, "maximum": 3, "visibility": "player"},
{"id": "仪式警觉", "kind": "number", "labels": {"en": "Rite Alert", "zh": "仪式警觉"},
 "default": 0, "minimum": 0, "maximum": 5, "visibility": "keeper"}
```

`kind` is `number` / `bool` / `text` / `enum`. `visibility: player` puts it on the party panel;
`visibility: keeper` means it **never reaches a player transport at all** — filtered inside the
engine, not hidden by the client. Bounds are enforced on every write, including writes the model
asks for. Ids can be CJK.

This is the difference between a tracker and a note: a tracker is state the engine validates,
keeps in range, stores and filters. Declare the things your ending depends on.

### `pregens[]` — a cast players can claim

```json
{"name": "顾晚棠", "concept": "沪上小报记者，为'渔镇民俗'专栏而来",
 "notes": "侦查/图书馆见长,嘴快,潮汐学5"}
```

Optionally `skills: {"侦查": 70}` to override the system defaults. Sheets are built downstream from
the target system's defaults plus those overrides — deterministically, no model involved. Players
run `.pc claim 顾晚棠`; claims are exclusive and a release restores the pristine sheet.

### `hooks[]` — behaviour, not text

```js
on('variables_changed', (e) => { emitPanel('xipu-songdeng/dengzhen', {writes: e.writes}); });
```

Sandboxed JavaScript on the turn lifecycle. The full API is in [hooks.md](hooks.md). One trap is
worth repeating here because a live playtest lost a whole session's meter to it:

```js
// WRONG — the interpreter is rebuilt every turn, so this reads 1 forever, in silence.
on('turn_start', () => { globalThis.__turns = (globalThis.__turns || 0) + 1; … })

// RIGHT — durable state belongs to the engine; the hook asks for it.
on('turn_start', () => {
  incvar('潮感', 1);
  emitUI([{kind: 'meter', label: '潮感', value: Number(getvar('潮感')) || 0, min: 0, max: 40}]);
});
```

### Why your module is a "world card"

Look again at the build output: `Contains 1 WORLD card(s)`. You never declared that. The build
*detected* it, because the card ships hooks, typed variables, secret lore or EJS — anything that
reprograms a shared table.

The consequence is the **card split (拆卡)**, and it is the one design rule that will surprise you
if you come from SillyTavern:

- **`.import <file> pc|companion`** — anyone may do this. It takes the character half only. World
  machinery is *removed by the importer itself*, and the reply lists what went:

  ```console
  Imported "潮脉盘" as your player character (coc7-xipu). Key stats: STR 50, CON 45, …
  World machinery was left out of this character import: 0 hook script(s), 1 variable declaration(s),
  0 template block(s), 0 keeper-only entr(y/ies). Module content is keeper-imported: `.import <card file> world`.
  ```

- **`.import <file> world`** — keeper only, and deliberately *not* a model tool. This is how a module
  actually lands:

  ```console
  Imported "汐浦送灯" as world content: 16 lore entries (keeper trust), 0 variable declaration(s) seeded,
  1 hook script(s) installed.
  Typed variables: 3 tracker(s) defined from the native bundle.
  Cast registered (3): 顾晚棠, 白榆生, 陈九鲤 — players claim with `.pc claim <name>`.
  ```

Write for that boundary. Anything that changes how the whole table works belongs on the world side,
and the Keeper is the one who admits it.

---

## 2. House rules: patch a system, don't fork it

Your module needs one extra skill and a nastier fumble band after dark. That is not a new rule
system; it is a patch. `extends:` deep-merges your file over the parent — child wins, mappings merge
recursively, an explicit `null` deletes an inherited key, and lists replace wholesale.

`rulepacks/coc7-xipu.yaml`, in full:

```yaml
extends: coc7
names: [coc7-xipu, 汐浦规则]      # what resolves to this system
set_keys: [xipu]                  # what `.xipu` etc. select
defaults:
  潮汐学: 5                        # one new skill, starting at 5
alias:
  潮汐学: [tidology, tide lore, 观潮, 潮学]
display:
  en:
    潮汐学: Tidology              # presentation only — never affects resolution
resolution:
  variants:
    xipu_night:                   # the festival-night house ladder
      ranks:
        - {id: crit,    when: "roll == 1", success: true, critical: true, tier: 5}
        - {id: fumble,  when: "roll == 100", fumble: true, tier: 0}
        - {id: extreme, when: "roll <= target && roll <= floor(raw_target / 5)", success: true, tier: 4}
        - {id: hard,    when: "roll <= target && roll <= floor(raw_target / 2)", success: true, tier: 3}
        - {id: regular, when: "roll <= target", success: true, tier: 2}
        - {id: fumble,  when: "roll >= 93 && target < 50", fumble: true, tier: 0}
        - {id: fumble,  when: "roll >= 98", fumble: true, tier: 0}
        - {id: fail,    tier: 1}
subsystems:
  random_madness:
    tables:
      xipu:
        display: {en: Xipu festival madness, zh: 汐浦狂乱}
        aliases: [汐浦, xipu]
        entries:
          - 潮声入耳：调查员耳中潮声不退，旁人说话都像隔着一层水。
          - 灯影追随：调查员坚信有一盏无人提的灯在身后跟着自己。
          # …
commands:
  xipu: {action: make_char}                        # `.xipu` creates a character in THIS system
  chaokuang: {tool: random_madness, args: {table: xipu}}   # `.chaokuang` draws from the table above
```

Three things this buys you, all verified from a terminal:

```console
$ .xipu
Created coc7-xipu character: Adventurer

$ .rule
Current house-rule ladder: 0
Available: dg, rule1, rule2, rule3, rule4, rule5, xipu_night

$ .rule xipu_night
House-rule ladder set to xipu_night

$ .ra 潮汐学
Check Tidology: target 5 (effective 5), roll 13 -> Failure
```

Note the last line: the skill is Chinese in the data, English on the screen, because `display` is
presentation and the canonical key is identity. A pack never has to choose a language.

> **A namespace nuance worth knowing.** Inside a `difficulties.*.target` expression, `target` is the
> RAW value; inside a rank's `when:` expression, `target` is the difficulty-adjusted one — which is
> why the ladders above compare against both `target` and `raw_target`.

**A patch needs its own id.** Discovery never lets a user file shadow a built-in, so you cannot
"redefine coc7"; you define `coc7-xipu` and your module plays that.

---

## 3. A whole system, as data

Sometimes the mechanic is genuinely new. 潮占 — the lantern-diviner's tide oracle — is a
success-counting d10 pool with nothing d100 about it, and it is one file:

```yaml
names: [chaozhan, 潮占]
set_keys: [chaozhan]
defaults: {}
resolution:
  version: 1
  roll: "{deng}d10>=7"          # a pool: roll `deng` d10s, count 7+
  target: none
  compare: ">="
  params:
    deng: {min: 1, max: 9, default: 3}
  ranks:
    - {id: nichao,   when: "successes == 0 && ones >= 2", fumble: true, tier: 0}
    - {id: gongming, when: "successes >= 3 && ones == 0", success: true, critical: true, tier: 3}
    - {id: yingchao, when: "successes >= 1", success: true, tier: 2}
    - {id: mochao,   tier: 1}
  margin: successes
  variants:
    miji:                        # the third-night inner rite, graded harder
      ranks:
        - {id: nichao,   when: "ones >= 1 && ones >= successes", fumble: true, tier: 0}
        - {id: gongming, when: "successes >= 4 && ones == 0", success: true, critical: true, tier: 3}
        - {id: yingchao, when: "successes >= 2", success: true, tier: 2}
        - {id: mochao,   tier: 1}
labels:
  en: {nichao: [Adverse Tide], gongming: [Resonance],
       yingchao: {display: Favorable Tide, markers: []},
       mochao:   {display: Silent Tide,    markers: []}}
  zh: {nichao: [逆潮], gongming: [共鸣],
       yingchao: {display: 应潮, markers: []},
       mochao:   {display: 默潮, markers: []}}
expertise:
  en: "# Tide Divination (潮占)\nThe lantern-diviner reads the festival tide…"
  zh: "# 潮占\n灯官问潮：点起一至九盏灯掷占，数应答之水。"
```

**The DSL in one paragraph.** `roll` is a dice expression; the engine rolls it, seeded and logged.
`ranks` is an ordered ladder of pure conditions — first match wins, and the last entry with no
`when:` is the fallback. Available names are a closed set: `roll` (the total), `dice` (the natural
dice, indexable as `dice1`, `dice2`, …), `target` (difficulty-adjusted), `raw_target` (before
difficulty), `modifier`, and `successes` / `ones` for pools. The flags `success` / `critical` / `fumble` are
declared *by you*: the engine and the AI only ever read those flags and the `tier` ordinal, never
your rank id, which is why a system can invent its own names for things without breaking anything
downstream. `expertise` is what the Keeper is told about how to run it.

**Pool params** (`deng` here) are supplied by the Keeper's check tool, which is how ritual scenes
call for a five-lantern casting. The player-facing dot-command reads its argument as a skill
name, so a pool system's parameters are the Keeper's to set, not a player's.

**Typos fail at build, not at the table.** Referenced names are extracted statically, so a
short-circuiting `&&` cannot hide a misspelling until someone's first check three sessions in:

```console
$ uv run python -m app --pack harbour-bell/
Pack build failed: rulepack bell: rulepack 'bell': resolution.ranks[0].when references unknown name(s) ['rol']
```

**Deleting the file deletes the system** — that is the acceptance test for "rules are data", and it
holds for the bundled packs too:

```
with coc7 : ['coc7', 'dnd5e', 'wod']
deleted   : ['dnd5e', 'wod']
load coc7 : ValueError unknown rulepack: coc7
```

If the DSL genuinely cannot express your system, `resolution: {script: resolver.js}` drops to a
QuickJS sandbox: the engine pre-rolls the declared dice and hands values in, your script returns a
verdict, the engine checks it and holds it in range. Randomness and state never leave the engine, and the
trust card discloses that your pack ships a script.

---

## 4. Panels: the table's instruments

`ui/panels.yaml`, declared as `contents.panels`. Up to 16 panels per pack. Here is the whole
festival module's panel file, and it covers every mechanism you need:

```yaml
panels:
  - id: jieqing-richeng
    title: {en: Festival Schedule, zh: 节庆日程}
    slot: sidebar              # sidebar | tray | modal
    audience: all              # all | player | keeper — resolved SERVER-side
    blocks:
      - {kind: stat,  label: {en: Festival Day, zh: 祭典日}, value: {$var: 祭典日}}
      - {kind: meter, label: {en: Tokens, zh: 信物}, value: {$var: 信物}, min: 0, max: 3}
      - {kind: divider}
      - {kind: text, text: {en: "Day 1 greet · Day 2 air · Day 3 send",
                            zh: "初一迎灯 · 初二曝灯 · 初三送灯"}}
      - {kind: text, style: warning, visible_when: "祭典日 >= 3",
         text: {en: "Tonight the lanterns go out on the tide. What you have counted is what you have.",
                zh: "今夜送灯。数到的就是数到的。"}}

  - id: shouzhong-wu
    title: {en: In Hand, zh: 手边物}
    slot: tray
    audience: all
    blocks:
      - {kind: image, src: ui/dengzhen/canlye.png,
         caption: {en: "Lantern manual, torn page", zh: 灯谱残页},
         alt: {en: "A brush-drawn array of nine lanterns, one of them unlit"}}
      - {kind: text, style: quote, text: {en: "Count them yourself.", zh: 自己数一数。}}

  - id: dengzhen
    title: {en: Lantern Array, zh: 灯阵图}
    slot: modal
    audience: all
    entry: ui/dengzhen/index.html                                  # tier 2
    assets: [ui/dengzhen/index.html, ui/dengzhen/app.js, ui/dengzhen/canlye.png]
    fallback:                                                       # mandatory
      - {kind: text, text: {en: "The lantern array chart is best viewed in a rich client;
                                the keeper will describe it.", zh: "灯阵图请在富客户端查看；终端下由守密人描述。"}}
      - {kind: badge, label: {en: "Nine lanterns", zh: "九灯之阵"}, tone: info}
```

**Block kinds:** `meter`, `stat`, `badge`, `text`, `divider`, `choices`, `image`, plus the
performance templates `letter`, `clipping`, `map_pin`, `title_card`. All declarative. A rich client
styles a `letter` as stationery; a terminal client prints the same fields as lines. You never write
markup, and you never have to write two versions.

**Live values:** any scalar field may be `{$var: <id>}` against the viewer's own `state.variables`.
When in doubt it shows nothing: if the variable is absent or hidden *for that viewer*, the **whole
block** is omitted. A panel can never widen visibility.

**A handout is one `image` block**, not a hand-written page. `src` is a pack-relative path; the build
folds it into the content-addressed asset pipeline and the manifest carries the hash. You never write
hashes, and a panel can only point at a picture its own pack ships.

**`visible_when` — value gates.** `{$var}` can only express "hide when absent"; `visible_when`
expresses "hide until day 3". It is evaluated **client-side**, because values move at runtime and no
server-side per-viewer filter could keep up. That makes every client an implementation of the same
grammar, so the grammar is tiny on purpose:

- comparisons `=== !== == != >= <= > <`; logic `&& || !` (or the words `and` / `or` / `not`);
- literals: numbers, quoted strings, `true` / `false` / `null` / `undefined`;
- bare dotted paths (CJK included), each looked up as a variable **id**; absent reads as `null`.
- **Refused at build time:** arithmetic, any function call including `getvar()`, bracket indexing.
  Each is somewhere two clients could quietly disagree, and a silent disagreement about visibility is
  a spoiler. Need `day >= -1`? Write `day < 0` the other way round.

Two rules to author by:

1. **A player panel's `visible_when` may only name player-visible variables.** The condition string
   ships with your pack, so every viewer's client holds it — naming a keeper-only tracker leaks its
   *name* even though its value never arrives. (It genuinely never does: hidden variables are dropped
   before evaluation, so the block simply never shows.)
2. **Undecidable means hidden.** A condition that errors, or that a client cannot evaluate, hides its
   block. Write conditions that read correctly when the variable is missing.

**Tier 2** is real HTML/JS/CSS in a locked-down iframe, for an interactive map or a bespoke sheet. It
must declare every asset it ships and an explicit tier-1 `fallback` (or `fallback: null`, which
text-first clients render as one "available in the rich client" line). A panel acts as the player
viewing it: inbound it sees only that viewer's filtered data; outbound, a `roll` intent runs through
the real dice engine as that player.

A keeper admits panels to a room — install is not enable:

```console
$ .panels
Installed panel packs:
[off] xipu-songdeng — 4 panel(s)

$ .panels enable xipu-songdeng
Enabled UI panels from pack: xipu-songdeng
```

---

## 5. The presentation kit: giving your module a Stage Director

Panels are the instruments. The **presentation kit** is the creative brief for the actor that plays
them. The Stage Director wakes on story *beats* — a scene changing, an act turning over, a handout
appearing, a critical spike — and decides what the table sees and hears. It never narrates, never
rolls, and never reads keeper knowledge: its whole input is the projected player-visible stream plus
this file. It cannot leak what it never receives.

`ui/presentation.yaml`, declared as `contents.presentation`, one per pack:

```yaml
version: 2
generation: allow            # or `pack_only` — your veto, see below
style:
  keywords:
    zh: "水墨淡彩, 靛青与赭石, 一九二五年浙东渔镇, 湿冷海雾, 纸本质感"
    en: "ink wash with muted color, indigo and ochre, 1925 coastal Zhejiang fishing town, damp sea fog, paper grain"
  banned: [text overlays, modern clothing, photographic realism, visible light sources beyond lanterns]
subjects:
  - id: gu-wantang
    kind: npc                                     # npc | location | item
    name: {zh: 顾晚棠, en: Gu Wantang}
    ref: assets/gu-wantang.png                    # the 定妆 reference image
    prompt: "a woman in her thirties, dark plain jacket over a pale collar, hair damp, standing very still"
  # No ref: nameable in a caption, never drawn.
  - {id: shipu,   kind: location, name: {zh: 石埠, en: The stone quay}}
  - {id: zhu-deng, kind: item,    name: {zh: 主灯, en: The head lantern}}
audio:
  - {id: chao-yong, layer: bgm,      asset: assets/chao-yong.mp3, title: 潮涌}
  - {id: ye-wu,     layer: ambience, asset: assets/ye-wu.mp3,     title: 夜雾港湾}
  - {id: jing-xian, layer: sfx,      asset: assets/jing-xian.mp3, title: 惊弦}
```

Three rules carry the image discipline, and the first two are structural — not requests a model can
ignore:

- **Ref-mandatory (定妆).** A subject with no `ref` is never generated. Consistency, not plumbing, is
  the hard part of AI art in a module: your reference image and style keywords ride *every* request,
  and a subject you did not license simply cannot be asked for.
- **宁缺毋滥.** `generation: pack_only` is your veto — the Director stages with your own art and
  nothing else. No operator setting overrides it, and in a room running two modules, one `pack_only`
  silences generation for the room.
- **慢菜先备.** The Director warms subjects it expects to want soon, so a beat serves art that was
  cooked during the quiet turns before it. You do not configure this; naming subjects is what makes
  it possible.

The kit rides the same asset pipeline as everything else, and the trust card discloses both the
subject count and whether your module may spend the operator's image budget at all. Rooms opt in with
the *same* `.panels enable <packId>` that admits your panels — presentation is the module dressing
the table, not a second switch. A room whose modules ship no kit never wakes a Director, so this
costs nothing until an author asks for it.

---

## 6. A skill: how to *run* the module

Story goes in the card. Procedure goes in a `SKILL.md` — a Claude-Code-shaped skill, YAML
frontmatter plus Markdown, folded into the Keeper's prompt while the room has it enabled.

```markdown
---
name: 迎潮节主持
description: Procedure guide for running 《汐浦送灯》 — act pacing, rule-system switching,
  festival-night house rules, madness table, ending-gate enforcement, and session-zero setup.
---

# 迎潮节主持（模组运行程序）

故事内容以导入的世界卡为准。本技能只管程序。

## 规则切换纪律
- 日常检定：coc7。**入夜后**切 `.rule xipu_night`，天亮切回 `.rule 0`——切换时给一句环境暗示，不解释规则。
- 理智：真正的恐怖暴露才掷。疯狂发作用汐浦狂乱表（`.chaokuang`）。

## 结局门（硬性，缺门不发）
C 断锚 = 信物满 3。玩家硬闯缺门结局时，在 fiction 内让门本身拦住。
```

Optional frontmatter: `allowed-tools` (gates the room's toolset to a list), `name-zh` /
`description-zh` (localized display), `metadata.systems`, `metadata.content-rating`. A sibling
`hooks.js` is active while the skill is enabled. The Keeper enables it per room:

```console
$ .skill enable yingchao-zhuchi
Enabled KP skill: yingchao-zhuchi
```

**Write procedure, not prose.** The best line in the example above is *"切换时给一句环境暗示，不解释
规则"* — it tells the Keeper what to do at a specific moment. Atmosphere belongs in the lore; this
file is a runbook.

---

## 7. Build, install, publish

### Build

```console
$ uv run python -m app --pack xipu-songdeng/
Packed xipu-songdeng@1.0.0 -> …/xipu-songdeng-1.0.0.lwpack
   sha256: 8c34dd524911a6f1def97fff57a51f1e9d455e695f32668053e5c5302fd51e0e
📦 Xipu: The Lantern Sending — xipu-songdeng@1.0.0
   A 1925 coastal-town mystery for the Tide-Greeting Festival — three days, nine lanterns, one chosen guest.
   by loreweaver-playtest · license: MIT
   contains: 1 skill(s), 2 rulepack(s), 2 card(s), 1 lorebook(s), 4 UI panel(s), 9 asset(s) (0.3 MB) · hooks code: yes · EJS templates: no
Contains 2 WORLD card(s) — module machinery (hooks/variables/EJS); the keeper imports them with `.import <file> world`.
   presentation kit: 5 picturable subject(s) — the Stage Director MAY generate images (each call spends your image-provider budget)
```

`--out <file>` picks the filename; `--json` adds a machine-readable line for CI:

```json
{"ok": true, "id": "xipu-songdeng", "version": "1.0.0", "sha256": "8c34dd52…",
 "trust": {"skills": 1, "rulepacks": 2, "cards": 2, "lorebooks": 1, "assets": 9,
           "asset_bytes": 282853, "has_hooks": true, "has_ejs": false,
           "has_rules_script": false, "world_cards": 2, "panels": 4,
           "presentation": 5, "imagegen": true}}
```

Two properties worth relying on: the build validates everything through the **real engine parsers**
(a bad skill, rulepack or card means no pack, not a broken install later), and it is
**byte-deterministic** — sorted entries, fixed timestamps, stable manifest dump — so the same source
tree always produces the same sha256. Publish that digest and people can check it.

### Install

```console
$ uv run python -m app --install ./xipu-songdeng-1.0.0.lwpack --yes
📦 Xipu: The Lantern Sending — xipu-songdeng@1.0.0
   …
   contains: 1 skill(s), 2 rulepack(s), 2 card(s), 1 lorebook(s), 4 UI panel(s), 9 asset(s) (0.3 MB) · hooks code: yes · EJS templates: no
Installed xipu-songdeng@1.0.0.
   skills: yingchao-zhuchi — a keeper enables one in-room with .skill enable <id>
   rulepacks: chaozhan, coc7-xipu — discoverable. They do not become the room's system by themselves: create a character on that system (the pack must declare a make_char word) or name the system on import.
   cards/lorebooks/assets: 2/1/9 file(s) under <data_dir>/packs/xipu-songdeng@1.0.0 — import in-room with .import <file> / .module
World cards (keeper-imported via `.import <file> world`): cards/shipu.lorecard.json, cards/chaomai-st.json
```

Without `--yes` the trust card is printed and confirmation is asked for; a non-interactive run
requires the flag. Install verifies **before** writing anything: every content file re-parses through
the real parsers, every asset's bytes must match its manifest sha256, the archive may contain nothing
undeclared, entry names are checked against path traversal, symlinks are rejected, and counts and
sizes are hard-capped. The trust block is re-derived from the archive with the same detectors and a
mismatch is refused.

**Install is not enable.** Skills and rulepacks become discoverable; a room still opts in
(`.skill enable`, `.panels enable`, `.import … world`). A rulepack does not become the
room's system on install — create a character on that system (the pack must declare a
`make_char` word) or name the system on import. That layering is the whole trust model:
nothing a pack ships starts running because it arrived on disk.

### Publish

Git releases *are* the registry. There is no central store, no submission, no gatekeeper — and
nothing about your distribution that anyone else can revoke.

1. Tag a release in your own repository.
2. Attach the `.lwpack` as a release asset. (Publishing its sha256 in the release notes lets people
   verify the byte-deterministic build themselves.)
3. Players install it by reference:

```bash
uv run python -m app --install gh:owner/repo          # newest release
uv run python -m app --install gh:owner/repo@v1.2.0   # a pinned one
uv run python -m app --install https://example.com/my-module.lwpack
```

The reference is resolved through the anonymous GitHub API to that release's `*.lwpack` asset — and
says so plainly when there isn't one:

```console
$ uv run python -m app --install "gh:1A7432/loreweaver@v1.0.0" --yes
Could not resolve the pack ref: release for 'gh:1A7432/loreweaver@v1.0.0' has no .lwpack asset
```

**Dependencies are flat and vendored.** A pack ships everything it needs; there is no inter-pack
resolution. `engine:` declares *minimum* versions only (`protocol`, `server`), and an unmet minimum
refuses the install with a clear message rather than half-working.

**Serializing a module?** Give every worldbook entry a stable `id` from installment one. Later
installments reference `<pack-id>#<entry-id>` instead of copying the shared world, and the engine
tracks provenance (`meta.source`) per document so an update can tell an owner-edited document from
one that should follow the pack.

---

## 8. Testing your module before anyone else plays it

**The dev room — edit the source, the room follows.** The fastest loop skips packing
entirely: point the server at your source directory and mount it into a sandbox room.

```bash
TRPG_DEV__SOURCE_ROOT=~/my-packs uv run python -m app --serve --keys /tmp/lw-keys
# then, as the room's keeper:
#   .dev mount ~/my-packs/my-module     — imports the module and starts watching
#   (edit any file and save — lore, skills, rulepacks and panels reload live;
#    edited entries replace their old text, deleted ones leave, and your room's
#    variable values survive every reload)
#   .dev reload / .dev status / .dev unmount
```

Mounts are confined under `TRPG_DEV__SOURCE_ROOT`, and with it unset the surface is
off — set it only on your own dev box. A dev mount serves panels and the presentation
kit straight from source (skipping the build-time caps), so `--pack` remains the
gate a release must pass.

**The scripted pipeline** — no key, no network, real dice:

```bash
uv run python -m app --pack my-module/                 # does it even build?
TRPG_DATA_DIR=/tmp/lw-test uv run python -m app --install ./my-module-0.1.0.lwpack --yes
TRPG_DATA_DIR=/tmp/lw-test uv run python -m app --cli --script my-run.txt
```

`--script` feeds one command per line to the offline CLI, which runs the whole real pipeline with a
scripted Keeper and seeded dice — no API key, no network. A run file that checks the wiring end to
end:

```
.xipu
.rule
.rule xipu_night
.st
.ra 潮汐学
```

```console
Created coc7-xipu character: Adventurer
Current house-rule ladder: 0
Available: dg, rule1, rule2, rule3, rule4, rule5, xipu_night
House-rule ladder set to xipu_night
Adventurer: 力量 45, 敏捷 60, 体质 60, 体型 65, 外貌 45, 智力 55, 意志 45, 教育 85, 幸运 50, DB 0, …
Check Tidology: target 5 (effective 5), roll 13 -> Failure
```

(The CLI rate-limits itself like any other player, so keep run files short or split them.)

Then check the room-level wiring — panels register, skills enable, the world card lands, the cast
appears:

```
.panels enable <your-pack-id>
.skill enable <your-skill-id>
.import <data_dir>/packs/<id>@<version>/cards/<your-card>.lorecard.json world
.pc list
```

And when it is time for a real model, **play it twice and write down what went wrong.** The first
run of this module found that a strong narrative model never touched the state layer at all — which
is why the Scribe exists; the second found the opposite failure, plus a handful of channel leaks.
Both were more useful for being written down while they still stung.

---

## Where to look next

| Topic | Document |
|---|---|
| The full extension spec — every field, limit and trust rule | [plugins.md](plugins.md) |
| Importing from SillyTavern: what runs, what differs | [cards.md](cards.md) |
| The hooks API, events, effect buffer, failure semantics | [hooks.md](hooks.md) |
| What panels and blocks look like on the protocol | [protocol.md](protocol.md) |
| Operating a table with your module on it | [operating.md](operating.md) |
