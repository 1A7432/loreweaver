// What the person running the server does from the shell: hand out a key, bring a world
// card into a room. Each opens the data directory the way the server does and returns data
// with stable codes; `main.ts` prints it.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { Role } from "loreweaver-protocol/v3";

import { importWorld } from "../agent/card_import.ts";
import type { LaneModels } from "../agent/context.ts";
import { indexLoreEntries } from "../agent/recall.ts";
import { servicesOn } from "../agent/services.ts";
import { CardError, parseCard } from "../core/card/index.ts";
import { SeededRandom } from "../core/random.ts";
import { builtInPacks, RulePackRegistry } from "../core/rulepacks/index.ts";
import type { Settings } from "../infra/config.ts";
import { systemClock } from "../infra/ids.ts";
import { type LLMClient, LLMError } from "../infra/llm/index.ts";
import { KeystoreError } from "../net/keystore.ts";
import { keystoreIn, openData } from "./compose.ts";

export const ROLES: readonly Role[] = ["admin", "player", "observer"];

export type KeyMinted = { readonly ok: true; readonly key: string; readonly id: string } | { readonly ok: false; readonly code: string };

/** A new access key for `room`. Its value is returned once, here. */
export function mintKey(settings: Settings, room: string, role: Role, name: string): KeyMinted {
  try {
    const minted = keystoreIn(settings.dataDir).mint({ room, name, role });
    return { ok: true, key: minted.key, id: minted.info.id };
  } catch (error) {
    if (error instanceof KeystoreError) return { ok: false, code: error.problem };
    throw error;
  }
}

/** No operator command calls a model. */
const NO_MODEL: LLMClient = {
  chat: () => Promise.reject(new LLMError({ code: "unknown", retryable: false })),
};
const NO_MODELS: LaneModels = { keeper: NO_MODEL, npc: NO_MODEL, scribe: NO_MODEL, director: NO_MODEL, memory: NO_MODEL };

export type WorldCardImported =
  | { readonly ok: true; readonly code: string; readonly name: string; readonly lore: number; readonly variables: number; readonly indexed: number; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly detail?: string };

/**
 * Import a card file as `room`'s world — the admin's action, done from the shell (a client
 * does the same over the byte channel: an upload with purpose `import`, then `import`).
 * The new lore entries are embedded for recall when embeddings are configured.
 */
export async function importWorldCard(settings: Settings, room: string, file: string): Promise<WorldCardImported> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch {
    return { ok: false, code: "unreadable_file" };
  }
  let card: ReturnType<typeof parseCard>;
  try {
    card = parseCard(bytes, basename(file));
  } catch (error) {
    if (error instanceof CardError) return { ok: false, code: "bad_card", detail: error.code };
    throw error;
  }
  const { store, recall } = openData(settings);
  try {
    const problems: string[] = [];
    const services = servicesOn({
      store,
      packs: new RulePackRegistry(builtInPacks()),
      models: NO_MODELS,
      clock: systemClock,
      report: (_room, text) => {
        problems.push(text);
      },
    });
    const writer = store.writer(room);
    const context = {
      services,
      room,
      turn: writer.turn,
      writer,
      locale: settings.locale,
      pack: null,
      variant: null,
      who: { member: null, character: null },
      random: new SeededRandom(`${room}:${writer.epoch}:${writer.turn}:import`),
    };
    const result = importWorld(context, card, { importedBy: null });
    if (!result.ok) return { ok: false, code: result.code };
    let indexed = 0;
    const warnings = [...result.warnings.map((warning) => `${warning.code}:${warning.count}`), ...problems];
    if (recall !== undefined && result.index.length > 0) {
      const outcome = await indexLoreEntries(recall, context, result.index);
      indexed = outcome.indexed;
      for (const problem of outcome.problems) warnings.push(`recall_${problem.code}`);
    }
    return { ok: true, code: result.code, name: result.name, lore: result.lore.written, variables: result.variables.declarations, indexed, warnings };
  } finally {
    store.close();
  }
}
