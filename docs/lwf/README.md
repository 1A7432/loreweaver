# Loreweaver World Format (LWF)

**The open format family for runnable AI-RPG worlds.**

An LWF world is not a chat persona and not a PDF module. It is a complete, portable,
*executable* adventure: rules, lore, characters, typed game state, code and, optionally, its
own table interface. All of it is packaged as one verifiable file that a conforming runtime
can install and run.

This directory is the **normative specification**. It lives in the repository of the
[Loreweaver engine](../../README.md), the **reference implementation**, so that a format
change and its implementation land in the same commit. The format is still specified
independently so that other runtimes, players and authoring tools can implement it: a format
with one implementation is a save file, and a format with several is a standard.

## Documents

| Document | Scope | Status |
|---|---|---|
| [SPEC.md](SPEC.md) | Umbrella: terminology, conformance classes, shared rules, security floor, versioning, conformance vectors, migration from 2.0 | **3.0 (draft)** — supersedes 2.0 |
| [formats/pack.md](formats/pack.md) | The `.lwpack` container: manifest 3, bundled modules, the archive rules, assets, the trust card, determinism, installing and enabling | **3.0 (draft)** — supersedes 2.0 |
| [formats/cards.md](formats/cards.md) | SillyTavern V1/V2/V3 cards, the native `*.lorecard.json` bundle, the world/character split (拆卡), the world and character imports, lore entries and their activation, templates and macros, the variable tree and typed variables, the lore overlay, information isolation | **3.0 (draft)** — supersedes 2.0 |
| [formats/rulepacks.md](formats/rulepacks.md) | Rule systems as data: the expression language, dice notation, check resolution, sheets, derived values, character constraints, subsystems, `extends:` | **3.0 (draft)** — supersedes 2.0 |
| [formats/skills.md](formats/skills.md) | `SKILL.md` skills: front matter, the tools a skill unlocks, enabling in a room | **3.0 (draft)** — supersedes 2.0 |
| [formats/panels.md](formats/panels.md) | Panels: panels files, templates bound to views, pages and their fallbacks, instantiation, the client sandbox | **3.0 (draft)** — supersedes 1.0 |
| [formats/presentation.md](formats/presentation.md) | The presentation kit: style, subjects and reference pictures, staging shapes, sound cues | **3.0 (draft)** |

The wire protocol is not part of LWF: it is defined by the engine's
[`docs/protocol.md`](../protocol.md) (protocol 3.0), with types on npm as
[`loreweaver-protocol`](https://www.npmjs.com/package/loreweaver-protocol).

LWF 1.0 (2026-07-30) was a draft that was never published; LWF 2.0 was the first published
version; LWF 3.0 breaks it on purpose. See [SPEC.md §6 and §8](SPEC.md).

## Implementations

| Implementation | Covers |
|---|---|
| [Loreweaver engine](../../README.md) | Reference implementation of every document here (Faithful runtime, SPEC.md §3). |
| [loreweaver-dsh](https://github.com/1A7432/loreweaver-dsh) | A second, independent implementation of the **rule pack** format at version 2.0, written as plugins for a different agent harness, and checked against vector tables exported from the reference ([rulepacks.md §17](formats/rulepacks.md)). |

## Design lineage

LWF deliberately **adopts existing conventions instead of inventing parallel ones**:

- SillyTavern's character cards and character books are accepted as constituent upstream
  formats, with a defined decomposition ([cards](formats/cards.md)); MagVarUpdate's
  `[InitVar]` declarations and update blocks, and ST-Prompt-Template's EJS templates, are read
  as cards that use them expect.
- Skills follow the Claude Code `SKILL.md` shape.
- Distribution uses plain Git releases. There is deliberately **no central registry** and no
  account system anywhere in the format.

## Stability promise

A document marked **stable** changes only additively within its major version: existing
fields never change meaning, required fields are never added, and a valid artifact never
becomes invalid. Every 3.0 document is still a **draft**. Breaking changes require a new major
version and a migration section. See [SPEC.md §6](SPEC.md).

## Proposing changes

Open an issue or a pull request against the engine repository, touching `docs/lwf/`. A format
change and its implementation land in one change; a change to a stable document must state
whether it is additive.

## License

This specification (everything under `docs/lwf/`) is licensed [CC BY 4.0](LICENSE).
Implementations carry their own licenses; the Loreweaver engine's code is MIT.
