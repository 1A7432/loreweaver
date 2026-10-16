# LWF: the `.lwpack` container

**Version 2.0 · stable (additive-only).** Manifest schema `manifest_version: 2`.
Reference implementation: `core/pack.py` (build, verify, install), `infra/pack_source.py`
(reference resolution) and `gateway/pack_install.py` (install doors) in the Loreweaver
engine.

A pack is **one ZIP archive** with the suffix `.lwpack`. It contains a root manifest
`pack.yaml` plus every file the manifest declares, and nothing else. It bundles a whole
work (skills, rulepacks, cards, lorebooks, UI panels, a presentation kit, prompt
presets, prep scripts, media assets) as one verifiable unit.

The manifest exists in two forms:

- the **source manifest**, which an author writes in a source directory;
- the **built manifest**, which a builder writes into the archive. It adds generated
  integrity and disclosure data that an author MUST NOT write.

## 1. Manifest

The manifest is YAML. It MUST be parsed with a safe loader that rejects anchors and
aliases (alias-bomb defense; reference: `core/yaml_safety.py`). The root MUST be a
mapping. Unknown top-level keys are ignored. Every nested object defined in this
document is **closed**: an unknown key in it is an error, unless the object's table says
otherwise.

| Field | Source | Built | Meaning |
|---|---|---|---|
| `manifest_version` | optional | **required** | Integer. When a source manifest omits it, it means the current version, `2`. |
| `id` | required | required | Slug `^[a-z0-9][a-z0-9-]{0,63}$`. Names the install directory `<id>@<version>`. |
| `version` | required | required | `^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$`. At most one suffix: a pre-release (`-…`) or a build tag (`+…`), not both. |
| `name`, `description` | required | required | A non-empty string (stored as `en`), or a mapping with `en` and/or `zh` keys. Other locale keys are dropped. Values are trimmed and truncated to 2,000 characters. |
| `authors` | optional | optional | A list of non-empty strings. Consumers keep at most 32 entries, each truncated to 200 characters. |
| `license` | required | required | An SPDX id or a short name, truncated to 200 characters. |
| `engine` | optional | optional | Minimum versions (§8). Closed: only `protocol` and `server`. |
| `contents` | optional | optional | A mapping from content kind to a list of entries (§2). An unknown kind is an error. |
| `assets` | optional | optional | Media file records (§3). |
| `files` | **forbidden** | **required** | The generated archive inventory (§4.1). |
| `trust` | **forbidden** | **required** | The generated disclosure summary (§4.2). |

**Schema versions.** A consumer MUST refuse a `manifest_version` greater than the
version it implements. It accepts a lower version only through a registered migration
to the current shape. Version 1, the pre-2.0 shape, has no migration and MUST be
refused.

**Paths.** Every path in the manifest is relative and uses `/` as its separator. This
covers content entries, card overlays, assets and `files` records. Every such path MUST
pass the path-safety rule of §6.1.

Reference: `core/pack.py::parse_manifest_text`.

## 2. Content kinds

`contents` accepts exactly the kinds below. Each kind lists at most 64 entries. An entry
MUST NOT appear twice within a kind. A file MUST NOT be declared under more than one
kind, and MUST NOT also be an asset or a card overlay.

| Kind | Entry | Rules |
|---|---|---|
| `skills` | a skill directory | The last path segment is the skill id and MUST be a slug. The directory holds `SKILL.md` (required) and `hooks.js` (optional), and nothing else. `SKILL.md` MUST parse ([skills-hooks.md](skills-hooks.md) §1). `hooks.js` MUST NOT exceed 40,000 characters. |
| `rulepacks` | a `.yaml` or `.yml` file | The file stem is the system id and MUST be a slug. The file MUST parse as a rulepack ([rulepacks.md](rulepacks.md)). The rules-script files it declares are shipped automatically (below). |
| `cards` | a card entry | See §2.1. |
| `lorebooks` | a JSON file | See §2.2. |
| `panels` | a `.yaml` or `.yml` file | A panels file ([panels.md](panels.md)). Panel ids MUST be unique across all of the pack's panels files, and the pack declares at most 16 panels in total. |
| `presentation` | a `.yaml` or `.yml` file | At most **one** per pack. See §2.3. |
| `presets` | a `.json` file | A prompt preset. See §2.4. |
| `prep` | a `.js` file | A prep-plan script. See §2.5. |

**Rules scripts.** A rulepack that declares `resolution.script` or
`subsystems.<name>.script` names a bare filename, with no `/` or `\`. That file lives
next to the rulepack YAML. A builder MUST put it in the archive and in the `files`
inventory without the author listing it, and a verifier MUST refuse an archive that
lacks it. Reference: `core/pack.py::_rulepack_script_files`.

### 2.1 Cards

A card entry is either a path string or a mapping:

| Key | Source | Built | Meaning |
|---|---|---|---|
| `path` | required | required | The card file, at most 16 MiB: a SillyTavern card (PNG or JSON) or a native bundle (`*.lorecard.json`). See [cards.md](cards.md) §1–§2. |
| `notes` | optional | optional | Install notes for the room admin: a string or an `{en, zh}` mapping, at most 2,000 characters per locale. |
| `overlay` | optional | optional | The path of a lore-overlay file that annotates this card ([cards.md](cards.md) §7). |
| `kind` | **forbidden** | **required** | `character` or `world`, stamped by the builder from payload detection. |

- **The card kind is detected, never declared.** A builder MUST set `kind` to `world`
  when the card carries world machinery under the predicate of [cards.md](cards.md) §4,
  and to `character` otherwise. A source manifest that declares `kind` MUST be refused.
  A verifier MUST re-run detection on the archived card, and MUST refuse the archive if
  the stamped kind differs from the detected one.
- **Native bundles are sniffed by content.** A file is parsed as a native bundle when it
  is a JSON object whose `format` is `"loreweaver.card"`, whatever its name. Its typed
  variable specs count as variable declarations for detection.
- **Overlays.** A declared overlay MUST parse with the overlay parser, both at build time
  and at verification. A structural error fails the build. An overlay entry title that
  the card does not carry is only a build **warning**. An overlay is annotation, never
  machinery: it cannot change a card's detected kind.

Reference: `core/pack.py::_parse_card_entry`, `_validate_card_bytes`,
`_enforce_card_kind`, `_validate_card_overlay`.

### 2.2 Lorebooks

A lorebook file is UTF-8 JSON (a BOM is tolerated), at most 4 MiB, in one of these
shapes:

- `{entries: [...]}` or `{entries: {...}}`, the SillyTavern world-info shapes;
- a bare list of entries;
- an object without `entries` that carries `character_book` or `data.character_book`.

It MUST contain at least 1 entry and at most 200. Its import semantics are those of
[cards.md](cards.md) §6. Reference: `core/pack.py::_validate_lorebook_bytes`.

### 2.3 The presentation kit

A presentation kit is a YAML file of at most 128 KiB. It tells a runtime's presentation
layer what a module may show and play. It is closed at every level.

| Field | Req | Meaning |
|---|---|---|
| `version` | yes | MUST be `2`. Version 1 is refused. |
| `generation` | no | `allow` (default) or `pack_only`. |
| `templates` | no | An allowlist drawn from `image`, `title_card`, `letter`, `clipping` and `text`, without duplicates. Empty or omitted means all are allowed. |
| `style` | no | `{keywords?, banned?, palette?}`. `keywords` is a string or an `{en,zh}` mapping. `banned` is a list of at most 24 strings, each at most 400 characters. `palette` is a list of at most 8 strings, each at most 80 characters. |
| `subjects` | no | At most 64 entries `{id, kind, name, ref?, prompt?}`. `id` is a slug and unique. `kind` is `npc`, `location` or `item`. `name` is a string or an `{en,zh}` mapping. `ref` is a path. `prompt` is at most 1,000 characters. |
| `audio` | no | At most 32 entries `{id, layer, asset, title?}`. `id` is a slug and unique. `layer` is `bgm`, `ambience` or `sfx`. `asset` is a path. `title` is at most 400 characters. |

Consumer obligations:

- A subject without a `ref` MUST NOT be sent to image generation. It may still be named.
- `generation: pack_only` MUST disable image generation for the pack. When several
  enabled packs share a room, a single `pack_only` disables it for the whole room, and
  the packs' `templates` allowlists intersect.
- A `ref` MUST be an image asset and an audio `asset` MUST be an audio asset (§3).

Reference: `core/presentation.py::parse_presentation_text`; the room merge policy is in
`gateway/presentation.py`.

### 2.4 Prompt presets

A preset is a SillyTavern completion-preset JSON object of at most 2 MiB. It MUST carry
a non-empty `prompts` array of at most 512 entries. Its install id comes from the file
name: lowercase the stem, collapse every run of characters outside `[a-z0-9]` to one
`-`, trim dashes and cap at 64 characters. A stem that leaves nothing usable becomes
`preset`. If two preset files of one pack derive the same id, the build MUST fail.
Reference: `core/preset.py::parse_st_preset`, `core/preset_store.py::sanitize_preset_id`.

### 2.5 Prep scripts

A prep script is UTF-8 JavaScript of at most 20,000 characters. Build and verification
check only the extension, the size and the encoding: a builder MUST NOT need a
JavaScript runtime to build a pack.

A prep script never runs automatically, only on an explicit room-admin request. It then
runs in a sandbox whose only callable is `plan(tool, args)`, and emits an operation list
within these limits: at most 200 operations, at most 8,000 bytes of arguments per
operation, and 1 s of CPU. The runtime validates the whole list before applying
anything, and applies each operation through its ordinary, permission-checked tool path.
Reference: `core/pack.py::_validate_pack_prep_scripts`, `core/prep_script.py`.

## 3. Assets

An asset record describes one media file.

| Key | Source | Built | Meaning |
|---|---|---|---|
| `path` | required | required | The file. Unique among assets. |
| `sha256` | optional | required | 64 lowercase hex characters. A source value MUST match the file, or the build fails. |
| `size` | ignored | required | The byte size, a non-negative integer. |
| `mime` | optional | required | The media type. When the source omits it, the builder derives it from the extension (table below). |
| `title`, `license` | optional | optional | Strings, truncated to 2,000 characters. |
| `tags` | optional | optional | A list of strings. Consumers keep at most 16, each truncated to 64 characters. |

Unknown keys in an asset record are ignored. A pack declares at most 512 asset records.

**Media types by extension.** A builder MUST map these extensions as shown, so that a
build does not depend on the build machine's media-type database:

| Extensions | Type | Extensions | Type |
|---|---|---|---|
| `.png` | `image/png` | `.mp3` | `audio/mpeg` |
| `.jpg`, `.jpeg` | `image/jpeg` | `.ogg`, `.oga`, `.opus` | `audio/ogg` |
| `.webp` | `image/webp` | `.wav` | `audio/wav` |
| `.gif` | `image/gif` | `.flac` | `audio/flac` |
| `.svg` | `image/svg+xml` | `.m4a` | `audio/mp4` |
| | | `.aac` | `audio/aac` |

Other extensions are builder-defined; the reference falls back to
`application/octet-stream`. In this document an **image asset** is an asset of one of
the five image types above, and an **audio asset** is one of the six audio types.

**Folded assets.** Panels and the presentation kit reference pack files by path. A
builder MUST add an asset record for each such path that the author did not list under
`assets`. That covers every tier-2 panel `assets` path (the entry included), every
tier-1 `image` and `map_pin` `src`, every presentation subject `ref` and every audio
`asset`. The build MUST then check that:

- every `image`/`map_pin` `src` and every subject `ref` is an image asset;
- every audio cue `asset` is an audio asset;
- each tier-2 panel's code payload is at most 2 MiB. The payload is the entry plus every
  asset of type `text/html`, `text/javascript`, `application/javascript` or `text/css`.

A verifier MUST repeat these checks against the built asset records.

Reference: `core/pack.py::_asset_mime`, `build_pack`, `_enforce_panel_code_cap`,
`_enforce_panel_images`, `_enforce_kit_assets`.

## 4. Generated blocks

### 4.1 `files`, the inventory

The built manifest lists **every archive member except `pack.yaml` itself**: content
files, rules scripts, card overlays and assets. Each record is `{path, sha256, size}`,
with the field rules of §3. The list is sorted by path, MUST be non-empty, MUST NOT
repeat a path, and holds at most 2,048 records. Every asset record's `sha256` and `size`
MUST equal those of its inventory record.

### 4.2 `trust`, the disclosure summary

A builder computes the trust block from the content. A verifier MUST recompute it from
the archive with the same detectors, and MUST refuse the archive if any field differs.
A pack therefore cannot understate what it ships.

| Field | Type | Value |
|---|---|---|
| `skills`, `rulepacks`, `cards`, `lorebooks`, `prep_scripts` | int | The number of entries of that kind. |
| `assets`, `asset_bytes` | int | The number of asset records (folded ones included), and the sum of their sizes. |
| `has_hooks` | bool | Some skill ships `hooks.js`, or some card carries at least one hook script ([cards.md](cards.md) §4). |
| `has_ejs` | bool | The text `<%` occurs in some `SKILL.md`, card file or lorebook file, read as UTF-8 with invalid bytes ignored; for a PNG card, also in its decoded card JSON. |
| `has_rules_script` | bool | Some rulepack declares a rules script. |
| `world_cards` | int | The number of cards stamped `kind: world`. |
| `panels` | int | The number of panels across all panels files. |
| `presentation` | int | The number of subjects in the presentation kit, or 0 without a kit. |
| `imagegen` | bool | The kit says `generation: allow` and at least one subject has a `ref`. |
| `presets` | int | The number of presets. |
| `overlays` | int | The number of cards that declare an overlay. |
| `overlay_exposes` | int | The number of variable prefixes that all overlays together publish through `expose`. |

Reference: `core/pack.py::PackTrust`, `build_pack`, `_verify_pack`.

## 5. Determinism

A builder MUST be deterministic: building the same source tree twice with the same
builder MUST produce byte-identical archives, and so the same sha256. The reference
builder:

- writes `pack.yaml` first, then every other member in ascending path order;
- stamps every entry with the ZIP epoch timestamp (1980-01-01 00:00:00) and regular file
  mode `0644`;
- compresses with DEFLATE;
- dumps the manifest as YAML with sorted keys.

Byte identity between different builder implementations is not required.

A builder reads the source tree only through confined paths: a source path MUST NOT be
a symlink, and MUST resolve inside the source directory.

Reference: `core/pack.py::build_pack`, `_source_file`.

## 6. Verification and install

### 6.1 Path safety

An archive entry name or a manifest path is unsafe, and MUST be refused, when it:

- is empty or longer than 512 characters, or has a segment longer than 255 characters;
- contains a backslash, a NUL byte or any other control character below U+0020;
- is absolute, or its first segment is a drive letter such as `C:`;
- has an empty, whitespace-only, `.` or `..` segment.

An archive entry whose ZIP attributes mark it as a symbolic link MUST be refused.
Directory entries (names ending in `/`) are ignored.

### 6.2 Caps

A conforming verifier enforces at least the caps below. A later 2.x revision may raise a
cap, but never lower it.

| Cap | Value |
|---|---|
| Archive file size | 512 MiB |
| Sum of declared uncompressed entry sizes | 1 GiB |
| Archive entries; `files` records | 2,048 |
| `pack.yaml` | 256 KiB |
| Entries per content kind / asset records | 64 / 512 |
| Card file / lorebook file | 16 MiB / 4 MiB |
| Panels per pack / panels file | 16 / 256 KiB |
| Tier-2 code payload per panel | 2 MiB |
| Presentation kit / preset / overlay file | 128 KiB / 2 MiB / 256,000 bytes |
| `hooks.js` and rules scripts / prep scripts | 40,000 / 20,000 characters |

### 6.3 Verification order

**Verify first, write second.** An archive that fails any of the steps below MUST NOT
cause a single filesystem write. The reference runs them in this order:

1. **Container.** The file exists and fits the archive cap. It is a ZIP archive and its
   entry count fits. Every non-directory entry name is safe (§6.1) and is not a symlink.
   The declared uncompressed total fits.
2. **Manifest.** A root `pack.yaml` exists, fits its cap, and parses as a *built*
   manifest (§1): `manifest_version`, `files` and `trust` are present.
3. **Engine minimums** (§8). An unmet minimum refuses the install.
4. **Inventory.** The set of archive members other than `pack.yaml` equals the set of
   `files` paths: nothing undeclared and nothing missing. Every member's bytes are read
   under a hard ceiling of its declared `size`, so reading past it aborts (zip-bomb
   defense). The member's sha256 and size MUST match its record. Every asset record
   MUST agree with its inventory record.
5. **Content.** Every declared file is present and parses with the parsers the builder
   used. This covers skills, rulepacks with their rules scripts, cards (with the kind
   check of §2.1), card overlays, lorebooks, panels (with the pack-level panel rules and
   the code cap), the presentation kit (with its asset type checks), presets and prep
   scripts.
6. **Disclosure.** The recomputed trust block equals the stored one (§4.2).

Reference: `core/pack.py::_open_pack`, `_archive_manifest`, `install_pack`,
`_verify_pack`.

### 6.4 Where things land

After verification, the reference install writes two sets of files.

- **The pack home** `packs/<id>@<version>/`. It receives the verbatim `pack.yaml`, the
  cards, card overlays, lorebooks, panels files, presentation kit, prep scripts and
  assets, at their archive paths. In-room import and enable flows read from here.
- **The discovery directories**, which all packs share:
  - skills land at `skills/<skill-id>/SKILL.md`, plus `hooks.js`;
  - rulepacks land at `rulepacks/<stem>.yaml`, and each rules script at
    `rulepacks/<stem>/<script>`. Two packs that ship a script of the same name therefore
    cannot overwrite each other;
  - presets land at `presets/<preset-id>.json`.

These rules apply:

- **Confinement.** Every write MUST resolve inside its target directory.
- **Atomic pack home.** The pack home MUST be staged and then swapped in, so that an I/O
  failure during extraction never leaves a half-written pack home. Reinstalling the same
  `id@version` replaces its pack home wholesale and never merges. Different versions of
  one pack coexist as separate homes.
- **Built-ins win.** A pack MUST NOT be able to override a runtime's built-in skill or
  rule system. A pack file that has a built-in id still lands, but discovery keeps
  resolving the built-in. A runtime SHOULD tell the installer which ids were shadowed.
- **Shared names.** Discovery files are keyed by id or stem only. If another pack later
  installs a skill with the same id, or a rulepack with the same stem, it replaces the
  earlier file. A runtime SHOULD report such rulepack collisions (reference:
  `core/pack.py::rulepack_stem_collisions`).
- **A skill lands whole.** Installing a skill replaces its whole file set: a file the new
  version does not ship (for example `hooks.js`) MUST be removed, so a stale hook can never
  run under a trust card that says `has_hooks: false`.

### 6.5 Install ≠ enable

Installing makes content **discoverable**. On its own it MUST NOT change the state of
any room: no card is imported, no skill, panel set or preset is enabled, and no rule
system becomes a room's system.

A runtime MAY offer a room-scoped install command that the room admin issues from
inside a room. Such a command names the room as well as the pack, so it MAY also enable
the pack **in that room**. The reference enables the pack's panels, presentation kit and
skills (built-in ids included). When the pack ships exactly one world card, the
reference also imports it. It never chooses between several world cards. This is an
enable action that the room admin takes, not a side effect of installing.
Reference: `gateway/commands/panels.py::_switch_everything_on`; engine decision record
`docs/notes/rejected/pack-install-shadowed-gate.md`.

### 6.6 Disclosure to the operator

A runtime MUST show whoever installs a pack the trust block (§4.2) together with the
pack's name, id, version, authors and license. An interactive install SHOULD show it and
ask for confirmation before it writes anything. An install that the operator or room
admin commanded by typing the exact pack reference MAY report it with the result
instead. Disclosure supports the operator's informed decision: the format gates
integrity, not taste.

## 7. Distribution and references

A pack reference is one of:

- a local path;
- an `https://` URL. Other schemes (`http://`, `ftp://`, `file://`) MUST be refused;
- `gh:owner/repo[@tag]`. It resolves through the GitHub releases API to the release with
  that tag, or to the repository's latest release when no tag is given. From that
  release it takes the first asset whose name ends in `.lwpack`.

A downloaded pack goes through the full verification of §6.3. A runtime may send a
credential with the release-metadata request. If it does, it MUST NOT forward that
credential on a redirect that leaves the host or downgrades to `http`, and MUST NOT
attach it to a URL that the user typed.

**Git releases are the registry.** There is deliberately no central index, no namespace
authority and no account. Publishers SHOULD publish the pack's sha256 next to the
release asset, so anyone can rebuild the pack and compare (§5).

**Pack-relative references.** A runtime MAY accept `<pack-id>/<relative path>` to name a
file inside an installed pack. The reference resolves it against the newest installed
home of that pack: the highest numeric `MAJOR.MINOR.PATCH`, with the full directory name
as the tiebreak. After symlink resolution, the file MUST still be inside that home and
MUST be a regular file. Reference: `core/pack.py::resolve_installed_path`.

**Stable entry handles.** A native bundle's lore entries MAY carry a stable `id`
([cards.md](cards.md) §2). Together with the pack id it forms the handle
`<pack-id>#<entry-id>`, which the reference records as a document's provenance. Authors
SHOULD keep entry ids stable across versions. This document defines only the handle
syntax, not how a runtime resolves a handle.

## 8. Engine minimums

`engine.protocol` and `engine.server` are minimum versions, never ranges. A declared
value MUST match `^\d{1,6}(\.\d{1,6}){0,3}$`. The runtime compares `protocol` with the
wire-protocol version it speaks, and `server` with its own release version. Both sides
are padded with zeros to the same length and compared as integer tuples. The runtime's
own version string MAY carry a development or local suffix; only its leading
dotted-integer prefix is compared. An unmet minimum MUST refuse the install with a clear
message.

There are no inter-pack dependencies: a pack ships everything it needs.

Reference: `core/pack.py::version_at_least`.
