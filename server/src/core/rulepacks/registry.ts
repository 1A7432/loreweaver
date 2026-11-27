/**
 * A set of loaded rule packs, and resolving a system name to one of them.
 *
 * An explicit value a caller builds (built-ins first, then installed packs) — never
 * process-wide state. Nothing changes it but `adopt`: a running server that installs a pack
 * builds the new set the same way and swaps it in, in one step, for every holder at once. A system resolves by its id, any declared `names:` entry or
 * any `set_keys:` entry, compared as stat names are (trimmed, case-folded, `_` read as a
 * space, full-width `：（）` as ASCII, whitespace collapsed). The FIRST pack to claim a
 * name keeps it, so with built-ins added first a later pack cannot take a built-in's name.
 */

import { foldCase, normalizeAlias, stripSpace } from "../sheets/text.ts";
import { RulePackError } from "./errors.ts";
import type { RulePack } from "./types.ts";

export class RulePackRegistry {
  #packs: ReadonlyMap<string, RulePack>;
  #names: ReadonlyMap<string, string>;

  /** Throws `RulePackError` (`DUPLICATE_ID`) when two packs share an id. */
  constructor(packs: Iterable<RulePack> = []) {
    const byId = new Map<string, RulePack>();
    const names = new Map<string, string>();
    for (const pack of packs) {
      if (byId.has(pack.id)) throw new RulePackError("DUPLICATE_ID", pack.id, "(root)", "the registry already holds a pack with this id");
      byId.set(pack.id, pack);
      for (const name of [pack.id, ...pack.names, ...pack.setKeys]) {
        const key = normalizeAlias(name);
        if (key !== "" && !names.has(key)) names.set(key, pack.id);
      }
    }
    this.#packs = byId;
    this.#names = names;
    Object.freeze(this);
  }

  /** A new registry with `packs` added after these (an existing id is a `DUPLICATE_ID`). */
  with(...packs: RulePack[]): RulePackRegistry {
    return new RulePackRegistry([...this.#packs.values(), ...packs]);
  }

  /**
   * Take `other`'s packs in place of these, in one step: how a running server takes in a
   * pack installed while it runs — the services, the rooms and every view holding this
   * registry see the new set at once.
   */
  adopt(other: RulePackRegistry): void {
    this.#packs = other.#packs;
    this.#names = other.#names;
  }

  /** The pack with exactly this id, or null. */
  get(id: string): RulePack | null {
    return this.#packs.get(id) ?? null;
  }

  /** The pack a system name (id, `names:`, `set_keys:`) stands for, or null. */
  resolve(name: string): RulePack | null {
    const id = this.#names.get(normalizeAlias(name));
    return id === undefined ? null : (this.#packs.get(id) ?? null);
  }

  /** Every pack id, in the order the packs were added. */
  ids(): readonly string[] {
    return Object.freeze([...this.#packs.keys()]);
  }

  /** Every pack, in the order they were added. */
  packs(): readonly RulePack[] {
    return Object.freeze([...this.#packs.values()]);
  }

  /**
   * The pack whose `commands:` binds `word` to character creation — the entry point into
   * a system, so it resolves across packs regardless of a room's system. The first pack
   * declaring it wins: an `extends:` patch inherits its base's words, and an inherited
   * word routes to the base.
   */
  makeCharacterPack(word: string): RulePack | null {
    const key = commandWord(word);
    for (const pack of this.#packs.values()) {
      const binding = pack.commands.get(key);
      if (binding?.kind === "action" && binding.action === "make_char") return pack;
    }
    return null;
  }
}

/** A command word as packs key them: trimmed and case-folded. */
export function commandWord(word: string): string {
  return foldCase(stripSpace(word));
}
