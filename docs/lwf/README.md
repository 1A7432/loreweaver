# Loreweaver World Format (LWF)

**The open format family for runnable AI-RPG worlds.**

An LWF world is not a chat persona and not a PDF module. It is a complete, portable,
*executable* adventure: rules, lore, characters, typed game state, sandboxed logic and,
optionally, its own table interface. All of it is packaged as one verifiable file that
any conforming runtime can install and run.

This directory is the **normative specification**. It lives in the repository of the
[Loreweaver engine](../../README.md), the **reference implementation**, so that a
format change and its implementation land in the same commit. The format is still
specified independently so that other runtimes, players
and authoring tools can implement it: a format with one implementation is a save file,
and a format with several is a standard.

## Documents

| Document | Scope | Status |
|---|---|---|
| [SPEC.md](SPEC.md) | Umbrella: terminology, conformance classes, security floor, versioning | **2.0 (stable)** |
| [formats/pack.md](formats/pack.md) | The `.lwpack` container: manifest v2, inventory, trust block, determinism, install; also presentation kit, presets, prep scripts | **2.0 (stable)** |
| [formats/cards.md](formats/cards.md) | SillyTavern V2/V3 cards, the native `*.lorecard.json` bundle, the world/character split (拆卡), lore overlays, information isolation | **2.0 (stable)** |
| [formats/rulepacks.md](formats/rulepacks.md) | Rule systems as data: check resolution, sheets, derived stats, subsystems, the rules-script lane, `extends:` | **2.0 (stable)** |
| [formats/skills-hooks.md](formats/skills-hooks.md) | `SKILL.md` skills, the `hooks.js` event API, templates and macros | **2.0 (stable)** |
| [formats/panels.md](formats/panels.md) | Module UI panels: `ui/panels.yaml`, templates, the panel wire contract, the client sandbox | **1.0 (stable)** |
| Wire protocol | Client↔server frames. A constituent standard whose canonical home is the engine's [`docs/protocol.md`](../protocol.md); types on npm as [`loreweaver-protocol`](https://www.npmjs.com/package/loreweaver-protocol) | **2.4 (stable)** |

LWF 1.0 (2026-07-30) was a draft that was never published. 2.0 supersedes it; see
[SPEC.md §5](SPEC.md).

## Implementations

| Implementation | Covers |
|---|---|
| [Loreweaver engine](../../README.md) | Reference implementation of every document here (Faithful runtime, SPEC.md §3). |
| [loreweaver-dsh](https://github.com/1A7432/loreweaver-dsh) | A second, independent implementation of the **rulepack** format, written as plugins for a different agent harness. It reads the same rulepack files the reference reads and is checked against vector tables exported from the reference ([rulepacks.md §16](formats/rulepacks.md)). |

## Design lineage

LWF deliberately **adopts existing conventions instead of inventing parallel ones**:

- SillyTavern's `chara_card_v2`/`v3` cards and lorebook shapes are accepted as
  constituent upstream formats, with a defined decomposition
  (see [cards](formats/cards.md)).
- Skills follow the Claude Code `SKILL.md` shape.
- Distribution uses plain Git releases. There is deliberately **no central registry**
  and no account system anywhere in the format.

## Stability promise

A document marked **stable** changes only additively within its major version. Existing
fields never change meaning, required fields are never added, and a valid artifact never
becomes invalid. Breaking changes require a new major version and a migration note. See
[SPEC.md §5](SPEC.md).

## Proposing changes

Open an issue or a pull request against the engine repository, touching `docs/lwf/`. A
change to a stable document must state whether it is additive.

## License

This specification (everything under `docs/lwf/`) is licensed [CC BY 4.0](LICENSE).
Implementations carry their own licenses; the Loreweaver engine's code is MIT.
