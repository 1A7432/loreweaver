*English · [中文](authoring.zh.md)*

# Making a Loreweaver pack

*From an empty directory to a pack that is enabled in a room and doing something, then
every kind of content a pack can carry.*

A **pack** is how content reaches a Loreweaver server: one `.lwpack` file (a ZIP archive
with a `pack.yaml` manifest) that can carry modules (code), cards and their lore, a
rule-pack patch, skills for the Keeper, panels, and a presentation kit with pictures and
sounds. The server validates the whole pack before it writes a single file.

This page is the order to do things in. The formats themselves are specified in
[LWF](lwf/SPEC.md): [pack.md](lwf/formats/pack.md) (the manifest, what is refused, the
trust card), [panels.md](lwf/formats/panels.md), [cards.md](lwf/formats/cards.md),
[rulepacks.md](lwf/formats/rulepacks.md) and
[skills.md](lwf/formats/skills.md) §1. When this page and a format document
disagree, the format document is right. The contract around all of it — what may be
extended, and the trust model — is [plugins.md](plugins.md). Cards have their own guide:
[cards.md](cards.md).

**The `loreweaver` command.** Below, `loreweaver` is the server's command: the compiled
binary, or `bun server/src/cli/main.ts` from a checkout of this repository. Commands that
touch installed packs use the server's data directory (`TRPG_DATA_DIR`, default `./data`),
so run them with the same setting as the server. Every command prints one JSON object.

**Words.** The *Keeper* is the AI game master. The *room admin* is a person holding an
admin key for a room. The *operator* is whoever runs the server process.

---

## 1. A first pack

A lantern the table can light: one module with one command. Two files.

```
lantern/
├── pack.yaml
└── src/lantern.ts
```

`pack.yaml`:

```yaml
manifest_version: 3
id: lantern
version: 0.1.0
name: { en: The Lantern, zh: 提灯 }
description: A lantern the table can light.
license: CC-BY-4.0
modules:
  - { id: lantern, entry: src/lantern.ts }
```

`src/lantern.ts`:

```ts
import { defineModule } from "loreweaver/module";

let lit = false;

export default defineModule({
  id: "lantern",
  create() { lit = false; },
  load(snapshot) { lit = (snapshot as { lit: boolean }).lit; },
  save() { return { lit }; },

  on: {
    turnStart(_event, fx) {
      fx.inject(lit ? "The lantern is lit." : "The lantern is dark.");
    },
  },

  commands: {
    light: {
      title: "Light the lantern",
      text: ["light"],
      run(_args, who, fx) {
        lit = true;
        fx.fact({ text: `${who.member?.name ?? "Someone"} lights the lantern.` });
        return { text: "The lantern is lit." };
      },
    },
  },

  views: {
    state: { title: "Lantern", schema: { type: "object" }, for: () => ({ lit }) },
  },
});
```

The module tells the Keeper every turn whether the lantern is lit (`fx.inject`), gives
the players a command (`lantern/light`), and publishes a view (`lantern/state`) that a
panel can read later. Its state survives a server restart through `save` and `load`.

**Build it:**

```sh
loreweaver pack lantern
```

This writes `lantern-0.1.0.lwpack` in the current directory (`--out <file>` to choose)
and prints the build's result: `{"ok":true,"out":…,"sha256":…,"trust":{…}}`. The builder
bundles `src/lantern.ts` and everything it imports into one file, `modules/lantern.js`;
`src/` itself is not in the archive. The same source tree always builds the same bytes.

**Install it.** Either way runs the same checks.

- *From chat*, as the room's admin — the pack is installed on the running server and
  enabled in your room at once. The path is a path on the **server's** disk (an
  `https://` URL or `gh:owner/repo[@tag]` works too):

  ```
  .pack install /path/to/lantern-0.1.0.lwpack
  ```

  The answer is the trust card in words:

  ```
  Installed The Lantern (lantern 0.1.0) on this server.
  It is enabled in this room.
  It runs code on this server, with no sandbox: modules lantern.
  ```

  The table hears one line: *Pack installed and enabled: The Lantern.*

- *From the shell*, as the operator. Without `--yes` the command only prints the trust
  card (as JSON) and writes nothing:

  ```sh
  loreweaver install lantern-0.1.0.lwpack          # the trust card, nothing written
  loreweaver install lantern-0.1.0.lwpack --yes    # installs
  loreweaver packs                                 # lists the installed packs
  ```

  `--force` replaces a pack already installed at the same id **and** version with this
  archive (without it that is refused, `already_installed`): for rebuilding during
  development without raising the version.

  Installing from the shell enables the pack nowhere, and a server that is running sees
  it only when it next starts. Then a room's admin enables it: `.pack enable lantern`.

**Use it.** Any player types:

```
.light
```

The player gets the command's answer (*The lantern is lit.*), the table sees the fact
(*Ada lights the lantern.*), and from the next turn on the Keeper's prompt says the
lantern is lit. `.light` is the text form the command declares (`text: ["light"]`); a form
can also take arguments, such as `"light {hours}"` (one word) or `"say {text...}"` (the
rest of the line) — the grammar is in [sdk/README.md](../sdk/README.md#text-forms). Every
module command can also be typed as its full id followed by a JSON object:
`.lantern/light {"hours": 2}`. Clients also list module commands in the `commands` view,
so `.help` shows it.

## 2. Changing a pack and installing it again

3.0 has no live-reload room and no separate lint command: you rebuild and reinstall. The
builder runs every check a server runs, so a pack that builds also installs (unless the
server is older than the pack's `engine` minimum).

The same version cannot be installed twice (`already_installed`). Two ways round it:

- **Raise the version** (`0.1.1`, or a pre-release such as `0.1.0-dev.2`), build, and
  `.pack install` it again from chat. The new version takes the old one's place on the
  running server, and every room that has the pack enabled reloads its worker and plays
  the new version from then on. Its modules start from their saved state (`load`).
- **From the shell:** `loreweaver install … --yes --force` replaces the installed pack of
  the same id and version with the new archive (or `loreweaver uninstall lantern`, then
  `loreweaver install … --yes`); then restart the server. Replacing and uninstalling are
  the operator's, from the shell only.

## 3. Testing a module

A module is tested with the SDK's test host under `bun test`: the same runner a room's
worker uses, without a server. The SDK is the `sdk/` directory of this repository; it is
not published to npm yet, so a pack's source tree depends on a checkout:

```json
{ "private": true, "devDependencies": { "loreweaver": "file:../loreweaver/sdk" } }
```

(the path to your checkout's `sdk/`). Then `bun install`, and a test beside the module:

```ts
import { expect, test } from "bun:test";
import { createTestHost, who } from "loreweaver/testing";

import lantern from "./lantern.ts";

test("lighting the lantern tells the table", async () => {
  const host = createTestHost(lantern);
  const run = await host.command("light", {}, who("Ada"));
  expect(run.facts.map((fact) => fact.text)).toEqual(["Ada lights the lantern."]);
  expect(await host.view("state", who("Ada"))).toEqual({ lit: true });
});
```

`package.json`, `node_modules/` and test files can live in the source tree: the builder
reads only the files the manifest names. The test host is documented in
[sdk/README.md](../sdk/README.md#testing-a-module).

## 4. Every kind of content

The lantern grows into a small pack with every content kind. Its finished tree:

```
lantern/
├── pack.yaml
├── src/lantern.ts
├── cards/old-quarter.lorecard.json    a world card: lore, a secret, a variable
├── rules/lantern-rules.yaml           a rule-pack patch on CoC 7e
├── skills/lamplighter/SKILL.md        a skill for the Keeper
├── ui/panels.yaml                     a panel
├── presentation.yaml                  the presentation kit
├── art/lantern.png
└── sound/rain.ogg
```

and its manifest:

```yaml
manifest_version: 3
id: lantern
version: 0.2.0
name: { en: The Lantern, zh: 提灯 }
description: { en: A dark quarter and the lantern that lights it., zh: 一片黑街，和照亮它的一盏灯。 }
authors: [You]
license: CC-BY-4.0
engine: { protocol: "3.0" }
modules:
  - { id: lantern, entry: src/lantern.ts }
contents:
  cards:
    - { path: cards/old-quarter.lorecard.json, kind: world, notes: { en: Import as the world., zh: 作为世界导入。 } }
  rulepacks: [rules/lantern-rules.yaml]
  skills: [skills/lamplighter]
  panels: [ui/panels.yaml]
  presentation: [presentation.yaml]
```

The picture and the sound do not need an `assets` entry: everything the kit and the
panels name travels with the pack. List a file under `assets` only to give it a title, a
licence or tags, or to ship a file nothing else names.

### 4.1 Cards and lore

Lore comes into a room in cards: a SillyTavern card (`.png` or `.json`) or Loreweaver's
own `*.lorecard.json`. There is no separate lorebook file in 3.0; a lorebook travels as
a card's `character_book`. Each card entry says what the card is, `world` or
`character`, and the builder checks that against the card itself
(`card_kind_mismatch`): a card with any world machinery — variable declarations,
templates, secret entries, typed variables — is a world card.

`cards/old-quarter.lorecard.json`:

```json
{
  "format": "loreweaver.card",
  "format_version": 1,
  "name": "The Old Quarter",
  "description": "A maze of streets where the gas lamps went out a year ago.",
  "opening": "Fog rolls up from the river. Somewhere ahead, a lantern swings.",
  "worldbook": [
    { "title": "The lamplighters", "keys": ["lamplighter", "lamp"], "content": "The lamplighters' guild still meets on Tallow Street." },
    { "title": "Who put out the lamps", "keys": ["lamps went out"], "secret": true, "content": "The guild master cut the gas to hide what walks at night." }
  ],
  "variables": [
    { "id": "dread", "kind": "number", "labels": { "en": "Dread", "zh": "恐惧" }, "minimum": 0, "maximum": 10, "default": 0 }
  ]
}
```

A card in a pack is not imported by enabling the pack. The room's admin imports it:

```
.import world lantern cards/old-quarter.lorecard.json
```

*Imported the world The Old Quarter: 2 lore entries (1 secret), 0 variable declarations,
1 openings.* The secret entry is the Keeper's; players never see it (`.lore list` shows
them one entry). A player can take a `character` card from an enabled pack as their own
character: `.import character <pack> <card path>`. What each import brings is in
[cards.md](cards.md).

### 4.2 A rule-pack patch

A pack that needs house rules patches a built-in rule system instead of rewriting it.
`rules/lantern-rules.yaml`:

```yaml
extends: coc7
names: [Lantern Rules]
defaults: { Lamplore: 10 }
```

The file's name is the rule system's id (`lantern-rules`). `extends:` deep-merges the
patch over the base (`coc7`, `dnd5e` and `wod` are built in, or another rule pack of the
same pack): mappings merge, lists and scalars replace, `null` deletes. A rule system is
not enabled per pack: once the pack is installed, a room chooses it with
`.rule system lantern-rules`. A rule pack that uses the 2.x rules-script lane
(`resolution.script`, a `script` subsystem) is refused: that lane is not in 3.0. The
format is [rulepacks.md](lwf/formats/rulepacks.md), §14 for `extends:`.

### 4.3 A skill

A skill is text for the Keeper: Markdown it reads while the skill is enabled in a room,
plus optionally a list of tools it unlocks. `skills/lamplighter/SKILL.md`:

```markdown
---
name: Lamplighter
name-zh: 点灯人
description: Run the Old Quarter as a place where darkness is a threat.
description-zh: 把旧城区当成一个黑暗本身就是威胁的地方来主持。
allowed-tools: [generate_image]
---
Darkness in the Old Quarter is never safe. When the lantern is out, describe sounds,
not sights, and call for a Listen check before anything is seen.
```

The directory's name is the skill's id. The tools a skill can unlock are the server's
gated tools: `generate_image`, and `adjust_relationship`, `set_relationship`,
`get_relationships`; unknown names are ignored. `metadata.content-rating: mature`
declares mature content. A room's admin enables a skill with `.skill enable lamplighter`
(`.skill list` shows what the room can enable); installing a pack from chat enables its
skills in that room. Write a skill as how to *run* the pack — pacing, what to withhold,
when to ask for a roll — not as the story; the story is in the cards. A skill is text
only: a `hooks.js` beside `SKILL.md` is not run (the build reports it as ignored). Code
belongs in a module (§4.6). The format is [skills.md](lwf/formats/skills.md)
§1.

### 4.4 Panels

A panel is interface beside the story — a gauge, a tracker, a map — in a client's
sidebar, tray or modal. It shows only what its viewer's **views** hold: built-in views
(`me`, `party`, `scene`, `variables`, `characters`, …) and module views such as
`lantern/state`. `ui/panels.yaml`:

```yaml
panels:
  - id: oil
    title: { en: The lantern, zh: 提灯 }
    slot: sidebar
    views: { lamp: lantern/state }
    blocks:
      - { kind: meter, label: { en: Oil, zh: 灯油 }, value: { $view: lamp.oil }, min: 0, max: { $view: lamp.max } }
      - { kind: image, src: art/lantern.png, caption: { en: The lantern, zh: 提灯 } }
      - kind: choices
        options:
          - { id: light, label: { en: Light it, zh: 点亮 }, command: lantern/light }
        visible_when: "lamp.oil > 0"
```

- `views` maps a short handle to a view name; `{$view: lamp.oil}` reads a path inside it.
  A path that does not resolve drops its block (or, in an optional field, the field).
- A `choices` option runs a command (`command` and optional `args`) as the member who
  clicked it, with that member's rights.
- `visible_when` hides a block; it is presentation, not secrecy — the block still reaches
  every viewer the panel is listed to. What a viewer must not see must not be in their
  views: a module's `for(who, room)` decides that per viewer, and `audience: admin` keeps
  a whole panel to admins.
- `repeat` draws one block per element of a list:
  `{repeat: {each: me.character.resources, as: r, block: …}}`.
- A **page** is one self-contained HTML file (`entry: ui/chart.html`) for rich clients.
  It must declare a template `fallback` (or `fallback: null`), which every other client
  draws instead. No reference client runs pages yet; the terminal client shows the
  fallback.

Every panel of an enabled pack is on; the room's admin switches one off with
`.panels disable lantern/oil` (`.panels` lists them). The module that feeds this panel is
in §4.6. The format is [panels.md](lwf/formats/panels.md).

### 4.5 The presentation kit: pictures and sounds

The kit tells the Stage Director — the lane that stages scenes with pictures and
handouts — what the pack's table should look and sound like. `presentation.yaml`:

```yaml
version: 2
style:
  keywords: { en: "gaslight, fog, ink wash", zh: "煤气灯、雾、水墨" }
subjects:
  - { id: lantern, kind: item, name: { en: The lantern, zh: 提灯 }, ref: art/lantern.png }
audio:
  - { id: rain, layer: ambience, asset: sound/rain.ogg, title: Rain on cobbles }
```

- `subjects` are the people, places and things (`npc`, `location`, `item`) the Director
  may show; `ref` is the pack's own picture of it. `generation: pack_only` forbids
  generating pictures at all; `templates` narrows the handout kinds (`image`,
  `title_card`, `letter`, `clipping`, `text`).
- `audio` cues join the room's audio library as `<pack>/<cue>`, read-only. The room's
  admin plays them: `.ambience play rain` (and `.bgm`, `.sfx`; `.audio list` lists the
  library). A cue's `title` is shown to admins only.
- Quote YAML values that contain commas inside `{ … }`: `{ en: gaslight, fog }` is read as
  two keys, and the build refuses the kit (`unknown_key`).

Pictures are PNG, JPEG, WebP, GIF or SVG (at most 8 MiB); sounds MP3, Ogg, WAV, FLAC,
M4A or AAC (at most 128 MiB). A file's bytes must match its extension. Enabled in a room,
the kit's pictures and sounds become that room's unlisted media: its members can fetch
them, nobody else. The kit's fields are [pack.md](lwf/formats/pack.md) §4.2.

### 4.6 A module

A module is the pack's code: the rules a pack does not trust the Keeper to keep by
itself — a tracker, a clock, a command, a private view. It is written in TypeScript or
JavaScript against `loreweaver/module` and runs in the room's worker thread. The lantern's
module, grown to feed the panel above:

```ts
import { defineModule } from "loreweaver/module";

let oil = 3;

export default defineModule({
  id: "lantern",
  create() { oil = 3; },
  load(snapshot) { oil = (snapshot as { oil: number }).oil; },
  save() { return { oil }; },

  on: {
    turnStart(_event, fx) {
      fx.inject(oil > 0 ? `The lantern burns; ${oil} hours of oil left.` : "The lantern is out.");
    },
  },

  commands: {
    light: {
      title: "Light the lantern",
      description: "Burn an hour of oil.",
      run(_args, who, fx) {
        if (oil === 0) return { text: "No oil left." };
        oil -= 1;
        fx.fact({ text: `${who.member?.name ?? "Someone"} lights the lantern.` });
        return { text: `${oil} hours of oil left.` };
      },
    },
  },

  views: {
    state: {
      title: "Lantern",
      schema: { type: "object", properties: { oil: { type: "integer" } } },
      for: () => ({ oil, max: 3 }),
    },
  },
});
```

What a module can do, in short:

- **Events:** `turnStart` (before the Keeper runs; `fx.inject` adds to this turn's
  prompt), `toolUse` (the Keeper is about to call tools; `fx.deny` refuses one) and
  `replyPhase` (after the reply).
- **Commands**, named `<module>/<name>`, with a role: `player` (default), `admin`, or
  `keeper` — Keeper machinery players never see, run by the Keeper's `run_command` tool
  and by the room's admin to repair what the Keeper got wrong. `keeper: false` marks a
  member's own verb the Keeper never runs (it is left out of the Keeper's command list).
  A command's arguments are checked against its declared `params` before the module is
  called; its `text` forms (`"light {hours}"`) are what members type. A form whose word is
  one of the room's own commands, or a word two enabled modules both claim, is not taken;
  enabling the pack names such forms.
- **Views**, computed per viewer, only for the viewers who asked for them: how private
  information reaches one member.
- **Effects** are requests the engine validates and applies: facts for the table or the
  Keeper (high-importance facts reach the Keeper first), variable writes, dice rolls, UI
  blocks. A module never calls the engine.
- **The room** comes with every call: the turn, the variables, the clock and every member
  of the room. `create` and `load` get `init`: the module entry's `options` from
  `pack.yaml` and a seed for this life of the room.
- **Characters and the clock:** `characters(room)` is read and validated, but nothing
  consumes it yet (seating a member on a module's character is designed separately and
  not built); `clock(room)` claims the room's clock.

A module entry in `pack.yaml` may carry `options`, a JSON object of at most 16 KiB that
its `create` and `load` receive as `init.options` — one module, configured per pack:

```yaml
modules:
  - { id: lantern, entry: src/lantern.ts, options: { oil: 5 } }
```

The module's `id` must equal the manifest entry's `id`. The builder bundles each entry
and any npm packages it imports into one file; `loreweaver/module` stays an import, which
the server answers with its own SDK. The whole contract, the effects table and the limits
are in [sdk/README.md](../sdk/README.md) — read it before writing a module.

**A module is real code.** It runs in the server's process with no sandbox: it can use
the filesystem, the network and anything it bundles. The server isolates faults — a
module that throws or hangs costs its room a call, not the server — but not trust. That
is why the trust card says *It runs code on this server* first (§5).

## 5. Installing, trust and enabling

**The trust card.** Before anything is installed, the server computes a summary of the
validated pack and shows it to whoever installs: the name, id, version, authors and
licence; whether it runs code, and each module's file, size and sha256; the rule systems
and what each extends; the skills and the tools each unlocks, and whether one declares
mature content; the cards with their kind and the world machinery each carries; the
panels with their audience and the views they read; the kit; the asset count and size;
and what was ignored. Being computed from the content, it cannot understate what the pack
ships. The full lantern from chat:

```
Installed The Lantern (lantern 0.2.0) on this server, in place of 0.1.0: rooms that have it enabled now play the new version.
It is enabled in this room.
It runs code on this server, with no sandbox: modules lantern.
rule systems: lantern-rules (extends coc7)
skills: lamplighter (unlocks generate_image)
cards: The Old Quarter (cards/old-quarter.lorecard.json, world)
panels: oil
a presentation kit
2 assets
Its skills are enabled in this room: lamplighter.
Its world card: .import world lantern cards/old-quarter.lorecard.json
```

**Who installs.** The operator, from the shell; or a room's admin, from chat. Both run one
installer with the same checks. Since a module is real code, a room admin who installs a
pack decides what code the server runs; on a self-hosted table the admin is usually the
operator too. An operator who does not want that should give admin keys only to people
they trust with the server.

**Install is not enable.** Installing from the shell changes no room; installing from
chat enables the pack in that admin's room only. In a room, enabling a pack (`.pack enable
<id>`, undone by `.pack disable <id>`; at most 16 per room):

- loads its modules in the room's worker, in the order the packs were enabled (two
  enabled packs cannot both have a module with the same id: `module_id_taken`);
- adds its kit to the room's kit and its audio cues to the room's library;
- adds its panels to the room's `panels` view;
- makes its skills available to `.skill enable` (disabling the pack disables them);
- makes its cards importable with `.import`.

Rule systems are server-wide: a room chooses one with `.rule system <id>`. A pack's rule
system or skill whose id is already taken — by a built-in or by a pack installed earlier —
is not loaded, and the install says so; the earlier one is never replaced.

**Publishing.** Git releases are the registry: attach the `.lwpack` to a GitHub release,
and anyone installs it with `gh:owner/repo` (the latest release) or `gh:owner/repo@v1.0.0`.
Any `https://` URL works too. Publish the archive's sha256 beside it: the build is
deterministic, so anyone can rebuild your source and compare.

## 6. Limits and refusals

A problem refuses the build (and an install) with a stable code and the path it concerns,
before anything is written. The ones authors meet most:

| Code | What it means |
|---|---|
| `manifest_version_unsupported` | The manifest is not `manifest_version: 3` (a 2.x pack). |
| `unsupported_kind` | `contents` has `lorebooks`, `presets` or `prep`, which 3.0 does not have. |
| `unknown_kind`, `unknown_key` | A key the format does not define (every nested object is closed). |
| `missing_file` | The manifest names a file that is not there. |
| `card_kind_mismatch` | A card's `kind` disagrees with what the card is; `detail` is the kind detected. |
| `presentation_invalid`, `panels_invalid` | The kit or a panels file is invalid; `detail` names the problem and its path. |
| `kit_asset_missing`, `panel_asset_missing` | A picture or sound the kit or a panel names is not in the pack. |
| `asset_type`, `asset_bad_signature`, `asset_too_large` | A file of an unknown extension, whose bytes do not match it, or too big. |
| `undeclared_script` | A code file in an archive that is not a declared module entry (a hand-made archive; the builder never packs one). |
| `already_installed` | That version is installed; raise the version (or, from the shell, `install --force`). |
| `options_too_large` | A module entry's `options` is over 16 KiB as JSON text. |
| `engine_too_old` | The server is older than the pack's `engine` minimum. |

Some caps: 16 modules and 16 panels per pack; 64 entries per content kind; one
presentation kit; 512 assets; `pack.yaml` at most 256 KiB, a rule pack 512 KiB, a kit
128 KiB, a page 2 MiB, a card 32 MiB, a bundled module 16 MiB; the archive at most
512 MiB. A value over its cap is refused, never cut. The full tables are
[pack.md](lwf/formats/pack.md) §2–§6 and [panels.md](lwf/formats/panels.md) §8.

## 7. Coming from 2.x

A 2.x pack does not install on 3.0. What changed for an author:

- `manifest_version: 3`; delete the `files` and `trust` blocks a 2.x build generated (the
  server computes the trust card); write `kind:` on every card entry.
- **`hooks.js` is gone.** Turn-lifecycle code, a card's hook scripts, `defineAction`
  actions and `emitUI` / `emitPanel` all become a module (§4.6). A card's hook scripts are counted and
  reported at import, never run.
- **Lorebooks** as a separate content kind are gone: put the entries in a card. **Prompt
  presets**, **prep scripts** and the prep phase have no 3.0 equivalent. A pack's
  `overlay:` file for a card is gone too: the room's admin sets the same switches with
  `.lore` and `.var` ([cards.md](cards.md)).
- **Panels** are panels 3.0: bindings read views, a choice runs a command, a page is one
  self-contained HTML file ([panels.md](lwf/formats/panels.md) §9 maps each 1.0 field).
- **Rule packs** with a rules script do not load.
- There is no forge (generating a skill, rule pack or module from a description), no
  live-reload dev room and no separate lint: build, install, look (§2).
- A native card's `pregens` and AI companions are not in 3.0: a player imports a
  `character` card and `genchar` makes a character from a description. A module's
  `characters()` is read and validated but nothing consumes it yet: seating on a module's
  character is designed separately and not built.

## Where to look next

- [sdk/README.md](../sdk/README.md) — writing and testing a module (in English).
- [cards.md](cards.md) — cards, the world/character split, lore, variables, templates.
- [plugins.md](plugins.md) — what can be extended, and the trust model.
- [LWF](lwf/SPEC.md) — the formats; [protocol.md](protocol.md) §6.8 — every command
  named here, with its Chinese forms.
