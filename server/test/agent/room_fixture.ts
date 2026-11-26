// A room with lore and variables, and a `RoomContext` over it, for the tests of the lore
// step and the effects applier.
import type { RoomContext, Services } from "../../src/agent/context.ts";
import { DocumentTypes } from "../../src/core/documents/model.ts";
import { RawDocuments } from "../../src/core/documents/raw.ts";
import { DocumentViews } from "../../src/core/documents/views.ts";
import {
  LORE_ENTRY_TYPE,
  loreEntryDocument,
  loreEntryDocumentType,
  type LoreEntryInput,
  loreOverlayDocumentType,
  loreTimersDocumentType,
  newLoreEntry,
} from "../../src/core/lore/index.ts";
import { SeededRandom } from "../../src/core/random.ts";
import {
  buildSpec,
  defineVariable,
  EMPTY_MODULE_VARIABLES,
  fromPlain,
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  moduleVariablesDocument,
  moduleVariablesPayload,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  variableTreeData,
  variableTreeDocument,
  type VarMap,
} from "../../src/core/variables/index.ts";
import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { type RoomWriter, Store } from "../../src/infra/store.ts";

export const ROOM = "fixture-room";

export function setup(): { readonly store: Store; readonly services: Services } {
  const store = new Store(openDatabase(":memory:"));
  const types = new DocumentTypes()
    .register(loreEntryDocumentType)
    .register(loreOverlayDocumentType)
    .register(loreTimersDocumentType)
    .register(variableTreeDocument)
    .register(moduleVariablesDocument);
  const llm = new ScriptedLLM([]);
  const services: Services = {
    store,
    types,
    documents: new RawDocuments(store, types),
    views: new DocumentViews(store, types),
    packs: {} as never,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    clock: { id: () => "x", now: () => 0 },
    report: () => undefined,
  };
  return { store, services };
}

export function contextFor(services: Services, writer: RoomWriter): RoomContext {
  return {
    services,
    room: writer.room,
    turn: writer.turn,
    writer,
    locale: "en",
    pack: null,
    variant: null,
    who: { member: null, character: null },
    random: new SeededRandom("fixture"),
  };
}

/** Store a lore entry under `id`. */
export function addLore(services: Services, writer: RoomWriter, id: string, input: LoreEntryInput): void {
  const made = newLoreEntry(input, 0);
  if (!made.ok) throw new Error(`fixture entry ${id}: ${made.code}`);
  const { data, meta } = loreEntryDocument(made.data);
  services.documents.put(writer, LORE_ENTRY_TYPE, id, data, meta);
}

export function putTree(services: Services, writer: RoomWriter, plain: Record<string, unknown>): void {
  services.documents.put(writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(fromPlain(plain) as VarMap, []));
}

/** One declared number module variable `id` (0..max). */
export function putModuleVariable(services: Services, writer: RoomWriter, id: string, max: number): void {
  const spec = buildSpec({ id, kind: "number", labels: { en: id }, minimum: 0, maximum: max, default: 0 });
  if (!spec.ok) throw new Error(spec.problem);
  const state = defineVariable(EMPTY_MODULE_VARIABLES, spec.spec).state;
  services.documents.put(writer, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(state));
}
