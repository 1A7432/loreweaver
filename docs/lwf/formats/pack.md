# LWF: the `.lwpack` container

**Version 3.0 · draft.** Manifest schema `manifest_version: 3`. This is a breaking
revision of pack 2.0 (see §10): a pack now carries **modules** (code, bundled at build
time), a 2.x `hooks.js` is no longer run, and the generated `files` and `trust` blocks
are gone from the manifest. A runtime that implements 3.0 refuses `manifest_version: 1`
and `2`.
Reference implementation, in the Loreweaver engine: `server/src/infra/zip.ts` (the
archive), `server/src/core/packs/` (manifest, whole-pack validation, trust card), `server/src/core/panels/`
(panels files),
`server/src/cli/packs.ts` (build, the shell's commands), `server/src/gateway/pack_install.ts` (install, load) and `server/src/gateway/packs.ts`
(enabling in a room).

A pack is **one ZIP archive** with the suffix `.lwpack`. At its root is a manifest,
`pack.yaml`, and beside it the files the manifest names. It is how content reaches a
server: modules, rule systems, skills, cards, panels, a presentation kit and the pictures
and sounds they use, as one unit that a runtime validates before writing anything.

An author works in a **source tree**: a directory with a `pack.yaml`, module sources in
TypeScript or JavaScript, and the content files. A **builder** turns the tree into the
archive. The archive's manifest is the author's, with one change: each module's `entry`
names the bundled file instead of the source (§3).

## 1. A complete small pack

```
harbor/                      the source tree
├── pack.yaml
├── src/
│   ├── tally.ts             a module, and a helper it imports
│   └── line.ts
├── skills/harbor-guide/SKILL.md
├── rules/harbor-rules.yaml
├── cards/drowned.json       a world card
├── cards/sailor.json        a character card
├── presentation.yaml
├── ui/panels.yaml           panels, and one panel's page
├── ui/chart.html
├── art/cover.png
├── art/quay.png
└── sound/bell.ogg
```

```yaml
manifest_version: 3
id: harbor
version: 1.0.0
name: { en: Harbor, zh: 港口 }
description: A small harbor town.
authors: [Ada]
license: CC-BY-4.0
engine: { protocol: "3.0" }
modules:
  - { id: tally, entry: src/tally.ts }
contents:
  skills: [skills/harbor-guide]
  rulepacks: [rules/harbor-rules.yaml]
  cards:
    - { path: cards/drowned.json, kind: world, notes: Import as the world. }
    - { path: cards/sailor.json, kind: character }
  presentation: [presentation.yaml]
  panels: [ui/panels.yaml]
assets:
  - { path: art/cover.png, title: Cover }
```

`loreweaver pack harbor` writes `harbor-1.0.0.lwpack`. Inside it, `pack.yaml` says
`entry: modules/tally.js`, and `modules/tally.js` is `src/tally.ts` with `src/line.ts`
folded in. `src/` itself is not in the archive. The kit's picture and sound are in the
archive although only `art/cover.png` is listed under `assets` (§6).

## 2. The manifest

The manifest is YAML, read as [SPEC.md](../SPEC.md) §4 says (no anchors or aliases, no
duplicate keys, no `__proto__` key). Its root MUST be a mapping. Top-level keys this document does not define are **ignored** and
reported (§8); every nested object is **closed**: an unknown key in it is an error.

| Field | Req | Meaning |
|---|---|---|
| `manifest_version` | yes | The integer `3`. Missing, `1`, `2` or a later version is refused, each with its own code. |
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,63}$`. Names the install directory. |
| `version` | yes | `MAJOR.MINOR.PATCH` (each 1–6 digits), with at most one suffix: a pre-release `-…` or a build tag `+…` (1–32 of `[0-9A-Za-z.-]`). |
| `name` | yes | A non-empty string (read as English) or a mapping with `en` and/or `zh`. At most 2,000 characters per language. |
| `description` | yes | As `name`. |
| `authors` | no | A list of at most 32 non-empty strings, each at most 200 characters. |
| `license` | yes | An SPDX id or a short name, at most 200 characters. |
| `engine` | no | Minimum versions (§7). Closed: `protocol` and `server` only. |
| `modules` | no | At most 16 module entries (§3). |
| `contents` | no | A mapping from content kind to its entries (§4). |
| `assets` | no | At most 512 asset records (§6). |

Text is counted in Unicode code points. **A value over its cap is refused, never cut.**

**Paths.** Every path in the manifest is relative and `/`-separated. It is unsafe, and
refused, when it is empty or longer than 512 characters; has a segment longer than 255
characters; contains a backslash, a NUL or any control character; is absolute; starts
with a drive letter such as `C:` or contains any other colon; has an empty, blank, `.` or
`..` segment; has a segment ending in a dot or a space; or has a segment that is a
Windows device name (`con`, `nul`, `com1`, `lpt1`, … with or without an extension). The
same rule applies to archive entry names (§5) and to every file an install writes. No
path may be `pack.yaml`.

**One file, one role.** A file is named at most once across module entries, content
entries and assets. Two names that are one file on a case-insensitive filesystem (after
Unicode NFC normalisation and case folding) count as the same file.

## 3. Modules

A module is content code: the rules a pack does not trust the Keeper to keep by itself
(a tracker, a clock, a command the players can type, a private status view). It is
written against `loreweaver/module` (the module SDK) and runs in the room's worker
thread of a runtime that enabled its pack. Each entry is:

| Key | Req | Meaning |
|---|---|---|
| `id` | yes | `^[a-z][a-z0-9_]{0,63}$`, unique in the pack. It MUST equal the `id` the module passes to `defineModule`: the module's commands and views are named `<id>/<name>`. |
| `entry` | yes | In a source tree: the module's source file, `.ts`, `.mts`, `.tsx`, `.js`, `.mjs` or `.jsx`. In an archive: the bundled `.js` file. |
| `options` | no | A JSON object, at most 16 KiB as the UTF-8 bytes of its JSON text: what the module's `create` and `load` receive as `init.options` (absent: `{}`). It lets one module be configured per pack. Over the cap the pack is refused (`options_too_large`); a value that is not a JSON object, or holds a value JSON cannot (a YAML date, a non-finite number), is `bad_field`. A builder keeps it as written. |

**Bundled at build time.** A builder bundles each entry and everything it imports —
the author's other files and any npm packages — into **one** JavaScript file, written as
`modules/<id>.js`, and rewrites `entry` to name it. Nothing is installed when a pack is
installed: there is no `package.json` step, so a pack carries its dependencies. One
import is left as an import: `loreweaver/module`, which the runtime answers with the SDK
it was built with, so a module never carries its own copy. Node built-ins stay imports
too.

A validator MUST refuse an archive whose module entry is not a `.js` file
(`module_not_bundled`), is missing, is over 16 MiB, or is not UTF-8.

**Trust.** A 3.0 runtime runs module code as ordinary code in its own process. There is
no sandbox: a module can use the filesystem, the network and anything its bundle
contains. What the runtime owes is fault isolation — a module that throws or hangs costs
its room a call, not the server. Installing a pack that has modules is therefore the
decision to run its code, and the trust card says so first (§8).

## 4. Content kinds

`contents` accepts exactly these kinds. Each lists at most 64 entries.

| Kind | Entry | Rules |
|---|---|---|
| `skills` | a skill directory | Its last segment is the skill id, a slug; ids are unique in the pack. The directory holds `SKILL.md`, which MUST parse ([skills.md](skills.md) §1–§2). A `hooks.js` beside it is **not run**: it is reported as ignored and not installed. |
| `rulepacks` | a `.yaml` or `.yml` file | Its stem is the rule system's id, a slug, unique in the pack. It MUST compile ([rulepacks.md](rulepacks.md)). |
| `cards` | `{path, kind, notes?}` | §4.1. |
| `presentation` | a `.yaml` or `.yml` file | At most **one**. A presentation kit ([presentation.md](presentation.md)). |
| `panels` | a `.yaml` or `.yml` file | A panels file ([panels.md](panels.md)). At most 16 panels across the pack, ids unique across its files. Each page's HTML and every picture a panel names travel with it, listed under `assets` or not. |

The 2.x kinds `lorebooks`, `presets` and `prep` are refused with the code
`unsupported_kind`; any other unknown kind with `unknown_kind`.

**Rule packs.** `extends:` names a base rule system: first one of the pack's own rule
packs, then one the runtime has built in. A pack cannot extend another pack's rule
system — a pack ships everything it needs. A rule pack that needs the rules-script lane
(`resolution.script`, a `script` subsystem) is refused: that lane is not part of 3.0.

### 4.1 Cards

| Key | Req | Meaning |
|---|---|---|
| `path` | yes | A SillyTavern card (`.png` or `.json`, at most 16 MiB) or a native bundle (`*.lorecard.json`, at most 32 MiB). [cards.md](cards.md) §1–§2. A card that does not parse refuses the pack (`card_invalid`, with the card error code). |
| `kind` | yes | `world` or `character`: what the author says the card is. |
| `notes` | no | Notes for the room admin, a string or `{en, zh}`, at most 2,000 characters per language. |

**The kind is checked against the card.** A validator runs the detection of
[cards.md](cards.md) §3.1 on the card and MUST refuse the pack when it disagrees with
`kind` (`card_kind_mismatch`, with the kind detected). A card that carries any world
machinery — variable declarations, templates, keeper-only entries, hook scripts, a
native bundle's typed variables — is a world card. Hook scripts in a card are counted,
never run.

### 4.2 The presentation kit

A YAML file of at most 128 KiB telling the runtime's presentation layer what the pack's
table may show and play: style, subjects with reference pictures, staging shapes, sound cues.
Its format, its checks and how several packs' kits combine in one room are
[presentation.md](presentation.md). Every picture and sound it names MUST be in the pack and
of the right type (`kit_asset_missing`, `kit_asset_type`), and becomes one of the pack's
assets (§6).

## 5. The archive

A pack archive is a ZIP file with these properties; a runtime refuses one that has
another:

- one disk, a classic end-of-central-directory record: no zip64, no multi-disk;
- entries stored (method 0) or deflated (method 8); no encryption;
- no symbolic-link entries; every name passes the path rule of §2 and is UTF-8 (or plain
  ASCII); no two names that are one file once normalised (§2);
- each local header agrees with its central record, and no two entries overlap;
- every CRC matches.

**Caps.** The archive at most 512 MiB; at most 2,048 entries; one entry at most 128 MiB
uncompressed and all entries together at most 1 GiB; an entry larger than 1 MiB may not
compress better than 100:1. Sizes are enforced **while inflating**: the inflater is
bounded by the size the entry declares, and an entry that inflates to more or less than
it declared is refused, so a header that lies cannot make a reader allocate past the
caps. `pack.yaml` at most 256 KiB, a rule pack at most 512 KiB.

**What may be in it.** `pack.yaml`, and every file the manifest names. Any other file
is handled this way:

- a file named `hooks.js`, anywhere: **ignored** — not run, not installed, reported;
- any other code file (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`, `.jsx`,
  `.wasm`, `.node`, `.sh`, `.bat`, `.cmd`, `.ps1`, `.exe`, `.dll`, `.so`, `.dylib`):
  the pack is **refused** (`undeclared_script`). The only code a pack carries is its
  declared module entries;
- anything else: **ignored** — not installed, reported.

**Determinism.** A builder MUST produce the same bytes from the same source tree. The
reference writes `pack.yaml` first and then every file in ascending path order, stamps
every entry with the ZIP epoch (1980-01-01 00:00) and mode `0644`, deflates at one fixed
level (storing an entry that would not shrink), and writes the module bundles with paths
relative to the source tree. Byte identity between different builders is not required.
A builder reads only the files the manifest names, never through a symbolic link, and
never outside the source tree.

## 6. Assets

An asset is a picture or a sound. The pack's assets are the records under `assets` and,
in addition, every picture and sound its presentation kit names and every picture its
panels name. (A panel page's HTML is not an asset: it is a panel file, [panels.md](panels.md) §7.)
A record is a path or:

| Key | Req | Meaning |
|---|---|---|
| `path` | yes | The file. |
| `mime` | no | If given, it MUST equal the type of the extension (below). |
| `sha256` | no | 64 lowercase hex characters, quoted in YAML. If given, it MUST match the file. |
| `title`, `license` | no | At most 2,000 and 200 characters. |
| `tags` | no | At most 16 strings of at most 64 characters. |

| Extensions | Type | Extensions | Type |
|---|---|---|---|
| `.png` | `image/png` | `.mp3` | `audio/mpeg` |
| `.jpg`, `.jpeg` | `image/jpeg` | `.ogg`, `.oga`, `.opus` | `audio/ogg` |
| `.webp` | `image/webp` | `.wav` | `audio/wav` |
| `.gif` | `image/gif` | `.flac` | `audio/flac` |
| `.svg` | `image/svg+xml` | `.m4a` | `audio/mp4` |
| | | `.aac` | `audio/aac` |

Any other extension is refused (`asset_type`). A picture is at most 8 MiB and a sound at
most 128 MiB (`asset_too_large`), and the bytes MUST start the way their type starts — an
SVG MUST pass the runtime's SVG validator (no scripts, no external references) —
or the pack is refused (`asset_bad_signature`).

## 7. Engine minimums

`engine.protocol` and `engine.server` are minimum versions, never ranges: one to four
dotted integers. The runtime compares `protocol` with the wire protocol it speaks and
`server` with its own version, padding both with zeros and comparing integer by integer;
a suffix on the runtime's own version (`3.0.0-alpha.0`) is ignored. An unmet minimum
refuses the install (`engine_too_old`). There are no dependencies between packs.

## 8. Installing and enabling

**Verify first, write second.** A runtime reads the archive (§5), then validates the
whole pack — every named file present, every module bundled, every rule pack compiling,
every skill and card parsing, every card the kind it says, the kit and its assets — and
checks the engine minimums. Any problem refuses the install with a stable code and the
path it concerns, before a single file is written.

**The trust card.** Before installing, the runtime shows whoever installs it a plain
summary computed from the validated content: the pack's name, id, version, authors and
license; whether it **runs code**, and which modules (id, file, size, digest); the rule
systems it adds and what each extends; its skills, the tools each unlocks and whether it
declares mature content; its cards, each with its kind and the world machinery it
carries; its panels, each with its kind, audience, the views it reads and a page's file
(path, size, digest); the presentation kit; how many assets and bytes; and what was **ignored** (a
`hooks.js`, unnamed files, unknown manifest keys). Being computed, it cannot understate
what the pack ships.

**Who installs, and from where.** In the reference, two callers share one installer, with
the same checks — who may install is the caller's question, what a pack may contain is not:

- **The operator, from the shell.** `loreweaver install <ref>` prints the trust card (as
  JSON) and writes nothing; `loreweaver install <ref> --yes` installs. `--force` replaces
  an installed pack of the same id **and** version with the given archive (without it that
  version is refused); only the shell offers it. Installing from the shell enables nothing
  anywhere. It works with the server stopped; a server that is
  running sees a pack installed (or `loreweaver uninstall`ed) from the shell only when it
  next starts.
- **A room's admin, from chat** (`pack install <ref>`, text form `.pack install <ref>`).
  `<ref>` is a source as in §9 — a local path is a path on the SERVER's disk. The pack is
  installed exactly as from the shell, joins the running server at once (below), and is
  **enabled in that room** together with its skills (those whose id it keeps). The admin's
  answer is the trust card in words, in their language, plus what was left out because an
  id was taken and the import command for each world card it ships (importing one stays a
  step of its own); the table hears one line naming the pack. Uninstalling stays the
  operator's, from the shell. Since a 3.0 module runs as real code in the server's process,
  a room admin who installs a pack decides what code the server runs: a self-hosted
  table's admin is usually its operator too.

**A running server takes in a pack installed from chat.** It is read back from disk and
validated again as at start; it takes its old version's place among the installed packs,
or the last place; the server's rule systems and skills are assembled again by the same
first-claim rule (below) and replace the old set at once. A room that did not enable the
pack is not touched. **Upgrading** a pack that rooms have enabled: every such room reloads
its worker (behind a turn in flight there) and plays the new version from then on — its
modules start from their saved state, its rule system and skills are the new version's.

**Where it lands.** The reference writes the pack's files — exactly the files of the
pack, ignored ones excluded — under `<data>/packs/<id>/<version>/` at their archive paths,
readable by the server's user only, staged in a sibling directory and renamed into place.
It lists the pack in `<data>/packs/index.json` in install order. One version of a pack is
installed at a time: a new version takes the old one's place in the index, and the old
files are removed after; installing the version already installed is refused
(`already_installed`) unless the operator forces it from the shell, and then the new files
take the old ones' place under the same version. Installed packs are validated again when the server starts, and a
pack that no longer validates is skipped with a note.

**Names a pack shares.** A pack's rule systems join the runtime's rule systems for the
whole server; its skills join the runtime's skills. An id is kept by its **first
claimant**: the runtime's built-ins, then the installed packs in install order. A later
pack's rule system or skill with a taken id is not loaded — the earlier one is never
replaced, a built-in least of all — and the runtime names it at install and at start.

**Install ≠ enable.** Installing from the shell changes no room; installing from chat
enables the pack in the installing admin's room only. A room's admin enables an installed
pack in a room (`pack enable <id>`; `pack disable <id>` undoes it), and the choice is a
room setting that survives every reset. For that room only, an enabled pack's modules
load in the room's worker, in the order the packs were enabled; its presentation kit
joins the room's kit, and the pictures and sounds the kit names become the room's
unlisted media, fetchable by that room's members only; its panels join the room's `panels`
view, each on until the admin switches it off (`panels disable <pack>/<panel>`, a room setting
that survives every reset), and the pictures they name and each page's HTML become the room's
unlisted media likewise (a page only admins are listed, fetchable by admins only); its skills can be enabled with
`skill enable <id>` (enabling a pack enables none of them, and disabling it disables
them); and its cards can be imported: `import {pack, card, as}`, where `card` is the
card's path in the pack — a world import stays the admin's. Rule systems need no
enabling: a room chooses one with `rule system <id>`.

## 9. Sources

A pack reference is one of:

- a local path;
- an `https://` URL. Every other scheme is refused, and so is a redirect that leaves
  https;
- `gh:owner/repo[@tag]`: the GitHub releases API gives the release with that tag, or the
  latest release, and the first asset whose name ends in `.lwpack` is downloaded.

A download is capped at the archive cap while it streams. **Git releases are the
registry**: there is no central index, no namespace authority and no account. Publishers
should publish the archive's sha256 beside it, so anyone can rebuild the pack and compare
(§5).

## 10. From pack 2.0

Pack 3.0 is not compatible with 2.0, and a 3.0 runtime refuses a 2.0 pack. To move one:

- set `manifest_version: 3`, and delete the `files` and `trust` blocks a 2.0 builder
  generated — a 3.0 runtime computes the trust card itself;
- write `kind:` on every card entry (2.0 forbade it and stamped it at build time), and drop a
  card entry's overlay: the pack overlay file is not part of 3.0 ([cards.md](cards.md) §11);
- move the logic of each skill's `hooks.js` into a module (§3): the script is no longer
  run;
- drop `lorebooks`, `presets` and `prep` (not part of 3.0);
- rewrite each panels file to panels 3.0 ([panels.md](panels.md) §9): bindings read views,
  a choice runs a command, a page is one self-contained HTML file;
- a rule pack with a rules script does not load in 3.0.
