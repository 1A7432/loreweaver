# LWF: the presentation kit

**Version 3.0 · draft.** File schema `version: 2`. Reference implementation, in the
Loreweaver engine: `server/src/core/presentation/kit.ts` (the format and its checks),
`server/src/core/packs/read.ts` (a kit in a pack) and `server/src/agent/lanes/presentation.ts`
(the kits of a room, merged).

A pack's **presentation kit** tells a runtime's presentation layer what the pack's table
should look and sound like, as data: the visual style, the people, places and things it may
picture (each with a reference picture), the staging shapes it may use, and the sounds it may
play. A runtime that has no presentation layer may ignore the kit; one that has one MUST keep
to its restrictions (§3).

## 1. The file

A pack carries at most one kit, listed under `contents.presentation`
([pack.md](pack.md) §4). It is a `.yaml` or `.yml` file of at most 128 KiB
(`MAX_KIT_BYTES`, else `presentation_too_large`), UTF-8, read as YAML
([SPEC.md](../SPEC.md) §4). **Every object is closed**: an unknown key is an error. A kit that
does not parse refuses the pack (`presentation_invalid`, with the problem code and path of
§4).

| Field | Type | Req | Default | Meaning |
|---|---|---|---|---|
| `version` | integer | yes | — | MUST be `2` (`KIT_VERSION`). |
| `generation` | `allow` or `pack_only` | no | `allow` | `pack_only`: the table shows the pack's own pictures and nothing generated. |
| `templates` | list | no | all | The staging shapes allowed: drawn from `image`, `title_card`, `letter`, `clipping`, `text`, without duplicates. Empty or absent: all of them. |
| `style` | mapping | no | — | Closed: `keywords`, `banned`, `palette`. |
| `style.keywords` | text or `{en, zh}` | no | — | The visual style in a few words, ≤ 400 per language (`MAX_KIT_TEXT_CHARS`). |
| `style.banned` | list of text | no | `[]` | Things never to show: at most 24 (`MAX_BANNED`), each 1–400. |
| `style.palette` | list of text | no | `[]` | Colours: at most 8 (`MAX_PALETTE`), each 1–80 (`MAX_PALETTE_CHARS`). |
| `subjects` | list | no | `[]` | At most 64 (`MAX_SUBJECTS`) subjects, §1.1. |
| `audio` | list | no | `[]` | At most 32 (`MAX_AUDIO_CUES`) cues, §1.2. |

*Text or `{en, zh}`*: a plain string is English; a mapping has `en` and/or `zh` (closed), at
least one. Text is trimmed; blank text is refused unless a field says it may be empty; lengths
count code points.

### 1.1 Subjects

| Key | Type | Req | Meaning |
|---|---|---|---|
| `id` | slug | yes | `^[a-z0-9][a-z0-9-]{0,63}$`, unique among the kit's subjects. |
| `kind` | `npc`, `location` or `item` | yes | |
| `name` | text or `{en, zh}` | yes | ≤ 400 per language. |
| `ref` | path | no | The subject's reference picture, a file of the pack. Absent, null or `""`: none. |
| `prompt` | text | no | The subject's own description, ≤ 1,000 (`MAX_SUBJECT_PROMPT_CHARS`); may be empty. |

### 1.2 Audio cues

| Key | Type | Req | Meaning |
|---|---|---|---|
| `id` | slug | yes | As a subject's id, unique among the kit's cues. |
| `layer` | `bgm`, `ambience` or `sfx` | yes | |
| `asset` | path | yes | The sound, a file of the pack. |
| `title` | text | no | ≤ 400; may be empty. |

### 1.3 Paths

A `ref` or `asset` is a pack-relative path of at most 256 code points
(`MAX_ASSET_PATH_CHARS`): not absolute, no backslash, no empty, `.` or `..` segment
(`bad_path`). It MUST name a file in the pack (`kit_asset_missing`) of the right type: a `ref`
an image, an `asset` a sound (`kit_asset_type`; the types are [pack.md](pack.md) §6). The
files a kit names are part of the pack's assets whether or not the manifest lists them, and
are checked like every asset.

### 1.4 Example

```yaml
version: 2
generation: allow
templates: [image, title_card, letter]
style:
  keywords: { en: "ink wash, fog, muted greens", zh: "水墨，雾，灰绿" }
  banned: [gore]
  palette: ["#2f3e36", "#c9b98b"]
subjects:
  - id: quay
    kind: location
    name: { en: The quay, zh: 码头 }
    ref: art/quay.png
    prompt: A wet stone quay at dawn, nets drying on posts.
  - id: harbourmaster
    kind: npc
    name: The harbourmaster
audio:
  - { id: bell, layer: ambience, asset: sound/bell.ogg, title: Harbor bell }
```

## 2. Semantics

- **Reference pictures are mandatory for generation.** A subject without a `ref` may be named
  but MUST NOT be sent to image generation; a subject with one sends the picture with every
  generation of it, together with its `prompt`.
- **`generation: pack_only`** is the author's veto: no generated picture for that pack's
  table.
- **`templates`** restricts the staging shapes the presentation layer may use; `image` is the
  shape a generated picture needs.
- **Audio cues** are the sounds the presentation layer may play for the pack. A runtime that
  lets a room admin play sounds by name SHOULD offer the cues of the packs a room enabled,
  read-only, named `<pack id>/<cue id>` (the reference's room audio library). A cue's `title`
  is shown to the room admin only: a title may tell the story before the table hears it.
- **Media.** When its pack is enabled in a room, the pictures and sounds a kit names become
  that room's unlisted media, fetchable by the room's members only ([pack.md](pack.md) §8).

## 3. Several packs in one room

A room that enabled several packs uses their kits together, in the order the packs were
enabled, at most 16 (`MAX_ROOM_KITS`; later kits are left out and reported):

- one `pack_only` disables generation for the whole room;
- `templates` lists **intersect** (a pack that declares none does not restrict); the
  intersection may be empty, and then no shape is allowed;
- style keywords contribute one line per pack, in the viewer's language (`zh` for a Chinese
  locale when present, else English, else Chinese); `banned` and `palette` are united,
  duplicates dropped;
- a subject or cue id another enabled pack already declared is left out, the first one
  standing (the room audio library of §2 keeps every cue, because it names them by pack).

## 4. What is refused

The kit is refused on the first problem, with its code and the dotted path of the field:
`not_an_object` (the document or a subject, cue or `style` is not a mapping), `unknown_key`,
`missing_key` (`version`, a subject's `id`, `kind`, `name`, a cue's `id`, `layer`,
`asset`), `bad_version`, `bad_value` (a wrong type, a value outside its list, blank text, a
`{en, zh}` mapping with neither), `bad_slug`, `duplicate` (a repeated template or id),
`too_long`, `too_many`, `bad_path`. The pack reader adds `kit_asset_missing` and
`kit_asset_type` (§1.3).
