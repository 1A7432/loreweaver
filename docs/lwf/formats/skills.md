# LWF: skills (`SKILL.md`)

**Version 3.0 · draft.** This is a breaking revision of skills 2.0 (see §5): a skill is
prompt text and a list of tools it unlocks, nothing else. The 2.x event hooks
(`hooks.js`) and the templates section moved out: hooks are not run in 3.0, and templates
in lore are specified in [cards.md](cards.md) §7. Reference implementation, in the
Loreweaver engine: `server/src/core/skills/` (the parser, the registry, enabling in a
room), `server/src/agent/tools/catalog.ts` (which tools a skill unlocks) and the built-in
skills under `skills/`.

A skill is a block of instructions for the runtime's Keeper that a room admin switches on
for one room: a play style, a content agreement, a capability. It follows the Claude Code
`SKILL.md` shape.

## 1. The skill directory

A skill is a directory whose name is the skill **id**: a lowercase slug,
`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (`SKILL_ID_PATTERN`; 1–64 characters, no leading
or trailing `-`), else `bad_id`. It holds `SKILL.md` (`no_skill_file` otherwise). A
`hooks.js` beside it is not run: the skill loads, with the warning `hooks_ignored`. Inside a
pack, the directory is listed under `contents.skills` and its last path segment is the id
([pack.md](pack.md) §4).

## 2. `SKILL.md`

The file is UTF-8 text of at most 100,000 code points (`MAX_SKILL_FILE_CHARS`). A leading
byte-order mark is ignored.

- The first line MUST be `---` (spaces around it allowed; `no_front_matter` otherwise). The
  front matter runs to the next line that is `---`; without one the file is refused
  (`unclosed_front_matter`).
- The front matter is YAML ([SPEC.md](../SPEC.md) §4; `yaml`, with the YAML error code and
  line) and MUST be a mapping (`not_a_mapping`); an empty front matter is an empty
  mapping. Unknown keys are ignored.
- The rest of the file, with leading and trailing blank lines removed, is the **body**: at
  most 20,000 code points (`MAX_SKILL_BODY_CHARS`). While the skill is enabled in a room,
  the body is part of the Keeper's prompt there, in the order skills were enabled.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | text, ≤ 100 | the id | Display name. |
| `description` | text, ≤ 2,000 | `""` | When to enable the skill; shown to the room admin. |
| `name-<lang>`, `description-<lang>` | text, same caps | — | Localized display text; `<lang>` is 2–3 lowercase letters (`name-zh`). At most 16 languages each (`MAX_SKILL_LOCALES`). A blank value is ignored. The English fields are the fallback. |
| `allowed-tools` | list of text | `[]` | Tool names the skill unlocks while enabled (§3). At most 32 (`MAX_ALLOWED_TOOLS`), each 1–64 (`MAX_TOOL_NAME_CHARS`); duplicates are dropped. |
| `metadata.scope` | text | `room` | `room` is the only defined value; any other value loads with the warning `unknown_scope`, and the skill is a room toggle anyway. |
| `metadata.systems` | list of text | `[]` | The rule-system ids the skill is written for: informative. At most 16, each ≤ 64. |
| `metadata.content-rating` | text, ≤ 32 | `""` | Lower-cased. `mature` or `explicit` declares mature content (§3). |

Text values are trimmed. A value of the wrong type is refused (`bad_field`, with the key's
path), one over its cap is refused (`too_long`, `too_many`); nothing is cut to fit.
`metadata`, when present, MUST be a mapping.

### 2.1 Example

```markdown
---
name: Harbor guide
name-zh: 港口向导
description: Enable when the table plays in the harbor town.
description-zh: 在港口小镇游玩时开启。
allowed-tools: [generate_image]
metadata:
  scope: room
  systems: [coc7]
---
# Harbor guide

The tide rules the town. Mention it when a scene changes, and let the bell ring at high water.
```

## 3. What an enabled skill does

- **Its body** joins the Keeper's prompt in that room (§2).
- **Its tools.** A runtime marks some of its Keeper tools **gated**: a gated tool is offered
  to the Keeper only in a room where an enabled skill lists its name under
  `allowed-tools`. A name that matches no gated tool unlocks nothing and is not an error:
  tool names are the runtime's vocabulary. The reference's gated tools are
  `generate_image`, `adjust_relationship`, `set_relationship` and `get_relationships`.
- **Mature content.** While an enabled skill declares `mature` or `explicit`, a runtime MAY
  lift the room's output word filter; the reference does.

## 4. Installing, naming and enabling

- **Where skills come from.** The runtime's built-in skills and the skills of installed
  packs. The reference ships `mature-mode`, `romance-relationships` and `image-gen`.
- **First claim keeps an id.** Built-ins claim their ids first, then installed packs in
  install order. A later skill with a taken id is not loaded — a built-in is never replaced
  — and the runtime names it at install and at start ([pack.md](pack.md) §8). A runtime
  holds at most 256 skills (`MAX_SKILLS`).
- **Install ≠ enable.** A skill is active in a room only after the room admin enables it
  there (the reference's `skill enable <id>` / `skill disable <id>`). A room may enable a
  built-in skill or a skill of a pack enabled in that room; enabling a pack enables none
  of its skills, and disabling it disables them. A room enables at most 32 skills at once
  (`MAX_ENABLED_SKILLS`; `too_many_skills`); an unknown id is `skill_not_available`.
- **A room setting.** The enabled set survives every reset: it is an agreement of the
  people at the table (mature content, images), not campaign content.
- **A skill that does not parse** refuses its pack (`skill_invalid`, with the skill error
  code and path), before anything is installed. An installed pack that no longer validates
  when the server starts is skipped with a note, its skills with it.

## 5. From skills 2.0

- A skill's `hooks.js` is not run. A pack that ships one installs without it (the file is
  reported as ignored); event logic belongs in a pack module ([pack.md](pack.md) §3).
  Nothing replaces the hook API itself (events, `denyTool`, private state, module actions,
  `emitUI`, `emitPanel`): a module answers through the module SDK's effects instead.
- The templates and macros of 2.0 §7 are now [cards.md](cards.md) §7. Subset-mode rendering
  and the kill switch that disabled hooks and full templates together are gone.
- New in 3.0: explicit caps on every field, refused rather than cut; localized display text
  for any language (`name-<lang>`), not only `zh`.
