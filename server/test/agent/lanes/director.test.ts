import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RoomContext, Services } from "../../../src/agent/context.ts";
import {
  commitDirector,
  commitWarmedImage,
  computeDirector,
  DIRECTOR_LANE,
  type DirectorInput,
  IMAGES_SPENT_KEY,
  LARDER_KEY,
  MAX_AUDIO_CUES,
  readDirectorImageState,
  renderDirectorImage,
} from "../../../src/agent/lanes/director.ts";
import {
  type InstalledKit,
  type KitAsset,
  mergeRoomKit,
  parsePresentationKit,
  type PresentationKit,
  type RoomKit,
} from "../../../src/agent/lanes/presentation.ts";
import { DocumentTypes } from "../../../src/core/documents/model.ts";
import { documentCatalog, RawDocuments } from "../../../src/core/documents/raw.ts";
import { DocumentViews } from "../../../src/core/documents/views.ts";
import { loreEntryDocument, loreEntryDocumentType, LORE_ENTRY_TYPE, newLoreEntry } from "../../../src/core/lore/entries.ts";
import { addNote, EMPTY_NOTES, KEEPER_NOTES_ID, KEEPER_NOTES_TYPE, keeperNotesData, keeperNotesDocument } from "../../../src/core/notes/index.ts";
import { EMPTY_SCENE, SCENE_ID, SCENE_TYPE, sceneData, sceneDocument, setSceneName } from "../../../src/core/notes/scene.ts";
import { createNpc, npcData, npcDocument, NPC_TYPE } from "../../../src/core/npcs/index.ts";
import {
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  moduleVariablesDocument,
  moduleVariablesPayload,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  variableTreeData,
  variableTreeDocument,
} from "../../../src/core/variables/documents.ts";
import { buildSpec, defineVariable, EMPTY_MODULE_VARIABLES, type ModuleVariables } from "../../../src/core/variables/modvars.ts";
import { decodeTree } from "../../../src/core/variables/tree.ts";
import { currentLane, type ScriptedReply, ScriptedLLM } from "../../../src/infra/llm/index.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { type RoomWriter, Store } from "../../../src/infra/store.ts";

const ROOM = "director-room";
const PLAYER_LINE = "I count the lanterns.";
const KEEPER_REPLY = "The tide pulls back and nine lanterns stand along the quay.";
const PLAYER_VARIABLE_LABEL = "Festival day";

// One marker in every Keeper-only place a room can hold.
const SENTINELS = {
  keeperVariableLabel: "SENTINEL-KEEPER-VARIABLE-LABEL",
  keeperVariableValue: "SENTINEL-KEEPER-VARIABLE-VALUE",
  hiddenLeaf: "SENTINEL-UNEXPOSED-LEAF",
  hiddenLeafKey: "SENTINELHIDDENKEY",
  keeperNote: "SENTINEL-KEEPER-NOTE",
  secretLoreTitle: "SENTINEL-SECRET-LORE-TITLE",
  secretLoreContent: "SENTINEL-SECRET-LORE-CONTENT",
  npcSecret: "SENTINEL-NPC-AGENDA",
  npcKnowledge: "SENTINEL-NPC-KNOWLEDGE",
  npcPersona: "SENTINEL-NPC-PERSONA",
} as const;

const ASSETS: Record<string, KitAsset> = {
  "assets/gu.png": { hash: "a".repeat(64), mime: "image/png", size: 100 },
  "assets/tide.mp3": { hash: "b".repeat(64), mime: "audio/mpeg", size: 200 },
};

function kitOf(raw: unknown): PresentationKit {
  const parsed = parsePresentationKit(raw);
  if (!parsed.ok) throw new Error(`${parsed.code} at ${parsed.path}`);
  return parsed.kit;
}

const BASE_KIT = {
  version: 2,
  style: { keywords: { en: "ink wash, 1925 coast", zh: "水墨" }, banned: ["text overlays"], palette: ["#16232e"] },
  subjects: [
    { id: "gu", kind: "npc", name: { en: "Gu Wantang", zh: "顾晚棠" }, ref: "assets/gu.png", prompt: "a woman in a dark coat" },
    { id: "quay", kind: "location", name: "The quay" },
  ],
  audio: [
    { id: "tide", layer: "bgm", asset: "assets/tide.mp3", title: "Tide" },
    { id: "ghost", layer: "sfx", asset: "assets/missing.mp3" },
  ],
};

function roomKit(raw: Record<string, unknown> = BASE_KIT): RoomKit {
  const installed: InstalledKit = { packId: "pack", kit: kitOf(raw), assets: new Map(Object.entries(ASSETS)) };
  return mergeRoomKit([installed], "en").kit;
}

function playerVariables(): ModuleVariables {
  let state = EMPTY_MODULE_VARIABLES;
  for (const input of [
    { id: "festival", kind: "number", labels: { en: PLAYER_VARIABLE_LABEL }, minimum: 1, maximum: 3, default: 1 },
    { id: "culprit", kind: "text", labels: { en: SENTINELS.keeperVariableLabel }, default: SENTINELS.keeperVariableValue, visibility: "keeper" },
  ]) {
    const spec = buildSpec(input);
    if (!spec.ok) throw new Error(spec.problem);
    state = defineVariable(state, spec.spec).state;
  }
  return state;
}

function setup(script: readonly ScriptedReply[] = []) {
  const store = new Store(openDatabase(":memory:"));
  const types = new DocumentTypes()
    .register(moduleVariablesDocument)
    .register(variableTreeDocument)
    .register(sceneDocument)
    .register(keeperNotesDocument)
    .register(loreEntryDocumentType)
    .register(npcDocument);
  const llm = new ScriptedLLM(script);
  let ids = 0;
  const services: Services = {
    store,
    types,
    documents: new RawDocuments(store, types),
    views: new DocumentViews(store, types),
    packs: {} as never,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    clock: { id: () => `id-${++ids}`, now: () => 1_000 },
    report: () => undefined,
  };
  return { store, types, llm, services };
}

/** A room holding every Keeper-only mechanism AND real player-visible content. */
function seed(services: Services): void {
  const writer = services.store.writer(ROOM);
  const { documents } = services;
  documents.put(writer, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(playerVariables()));
  const tree = decodeTree(JSON.stringify({ public: { tide: "low" }, [SENTINELS.hiddenLeafKey]: { truth: SENTINELS.hiddenLeaf } }));
  if (tree === null) throw new Error("tree");
  documents.put(writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(tree, ["public"]));
  const scene = setSceneName(EMPTY_SCENE, "The quay at dusk");
  if (!scene.ok) throw new Error(scene.code);
  documents.put(writer, SCENE_TYPE, SCENE_ID, sceneData(scene.data));
  const notes = addNote(EMPTY_NOTES, "plot", SENTINELS.keeperNote, null);
  if (!notes.ok) throw new Error(notes.code);
  documents.put(writer, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID, keeperNotesData(notes.data));
  const lore = newLoreEntry({ title: SENTINELS.secretLoreTitle, content: SENTINELS.secretLoreContent, secret: true, constant: true }, 0);
  if (!lore.ok) throw new Error(lore.code);
  const stored = loreEntryDocument(lore.data);
  documents.put(writer, LORE_ENTRY_TYPE, "truth", stored.data, stored.meta);
  const npc = createNpc({ name: "Gu Wantang", persona: SENTINELS.npcPersona, secretAgenda: SENTINELS.npcSecret, knowledge: [SENTINELS.npcKnowledge] });
  if (!npc.ok) throw new Error(npc.code);
  documents.put(writer, NPC_TYPE, "gu", npcData(npc.data));
}

function input(services: Services, overrides: Partial<DirectorInput> = {}): DirectorInput {
  return {
    room: ROOM,
    locale: "en",
    beat: "scene_change",
    player: PLAYER_LINE,
    reply: KEEPER_REPLY,
    views: services.views,
    kit: roomKit(),
    images: readDirectorImageState(services.store, ROOM),
    settings: { imagesEnabled: true, maxImages: 2, pregenPerBeat: 2 },
    ...overrides,
  };
}

function contextFor(services: Services, writer: RoomWriter): RoomContext {
  return { services, room: ROOM, turn: writer.turn, writer, locale: "en", pack: null, variant: null, who: { member: null, character: null }, random: {} as never };
}

const QUIET = JSON.stringify({ blocks: [], audio: [], image: null, prepare: [] });

describe("isolation", () => {
  test("the Director's prompt carries no Keeper-only material", async () => {
    const { services, llm } = setup([QUIET]);
    seed(services);
    let lane: string | undefined;
    const spy = new ScriptedLLM((messages, options) => {
      lane = currentLane()?.lane;
      return llm.chat(messages, options).then((result) => result.content);
    });
    const proposal = await computeDirector(input(services), spy);
    expect(proposal.status).toBe("ok");
    expect(lane).toBe(DIRECTOR_LANE);
    const prompt = JSON.stringify(spy.calls);
    for (const [where, marker] of Object.entries(SENTINELS)) expect({ where, leaked: prompt.includes(marker) }).toEqual({ where, leaked: false });
    // Positive controls: without these the assertions above would pass on an empty prompt.
    expect(prompt).toContain(PLAYER_LINE);
    expect(prompt).toContain(KEEPER_REPLY);
    expect(prompt).toContain(PLAYER_VARIABLE_LABEL);
    expect(prompt).toContain("public.tide");
    expect(prompt).toContain("The quay at dusk");
  });

  test("the control on the control: the markers are reachable at Keeper grade", () => {
    const { services } = setup();
    seed(services);
    const everything = JSON.stringify(services.documents.all(ROOM));
    for (const marker of Object.values(SENTINELS)) expect(everything).toContain(marker);
  });

  test("the Director's source never names a Keeper-grade surface", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../src/agent/lanes/director.ts")).text();
    const code = source.replace(/\/\/.*$/gm, "");
    for (const token of ["KEEPER", "raw.ts", "RawDocuments", "services.documents", "services.views", "services.models", "./scribe.ts", "keeper_notes", "npcs/"]) {
      expect({ token, named: code.includes(token) }).toEqual({ token, named: false });
    }
    // And it positively reads through the player projection.
    expect(code).toContain("playerViewer(input.locale)");
  });
});

describe("the kit", () => {
  test("validation is strict", () => {
    expect(parsePresentationKit({ version: 1 })).toEqual({ ok: false, code: "bad_version", path: "version" });
    expect(parsePresentationKit({ version: 2, extra: true })).toEqual({ ok: false, code: "unknown_key", path: "extra" });
    expect(parsePresentationKit({ version: 2, subjects: [{ id: "Bad Id", kind: "npc", name: "x" }] })).toMatchObject({ ok: false, code: "bad_slug" });
    expect(parsePresentationKit({ version: 2, subjects: [{ id: "a", kind: "npc", name: "x", ref: "../etc/passwd" }] })).toMatchObject({ ok: false, code: "bad_path" });
    expect(parsePresentationKit({ version: 2, templates: ["letter", "letter"] })).toMatchObject({ ok: false, code: "duplicate" });
    expect(parsePresentationKit({ version: 2, generation: "sometimes" })).toMatchObject({ ok: false, code: "bad_value" });
    expect(parsePresentationKit({ version: 2, style: { palette: Array(9).fill("red") } })).toMatchObject({ ok: false, code: "too_many" });
  });

  test("merging drops a cue whose sound the pack does not ship; templates intersect; one pack_only silences generation", () => {
    const assets = new Map(Object.entries(ASSETS));
    const merged = mergeRoomKit(
      [
        { packId: "a", kit: kitOf({ ...BASE_KIT, templates: ["letter", "text", "image"] }), assets },
        { packId: "b", kit: kitOf({ version: 2, generation: "pack_only", templates: ["text", "image", "clipping"] }), assets },
      ],
      "zh",
    );
    expect(merged.kit.cues.map((cue) => cue.id)).toEqual(["tide"]);
    expect(merged.problems).toEqual([{ code: "cue_asset_missing", packId: "a", id: "ghost" }]);
    expect(merged.kit.templates).toEqual(["text", "image"]);
    expect(merged.kit.generates).toBe(false);
    expect(merged.kit.style).toEqual(["水墨"]);
    expect(merged.kit.subjects.find((subject) => subject.id === "quay")?.reference).toBeNull();
  });
});

describe("the Director's output", () => {
  test("undeclared cues, disallowed templates and model-written pictures are dropped", async () => {
    const { services, llm } = setup([
      JSON.stringify({
        blocks: [
          { kind: "letter", body: "Come to the quay.", from: "G." },
          { kind: "clipping", headline: "Lanterns", body: "Nine of them." },
          { kind: "image", hash: "f".repeat(64) },
          { kind: "title_card", title: "" },
          "nonsense",
        ],
        audio: [{ cue: "tide", action: "play" }, { cue: "ghost" }, { cue: "thunder", action: "play" }],
      }),
    ]);
    const kit = roomKit({ ...BASE_KIT, templates: ["letter", "text"] });
    const proposal = await computeDirector(input(services, { kit }), llm);
    expect(proposal.blocks).toEqual([{ kind: "letter", body: "Come to the quay.", from: "G." }]);
    expect(proposal.dropped.blocks).toBe(4);
    expect(proposal.audio.map((cue) => cue.cue.id)).toEqual(["tide"]);
    expect(proposal.dropped.audio).toBe(2);
    const prompt = llm.calls[0]?.[0]?.content ?? "";
    expect(prompt).toContain('"kind": "letter"');
    expect(prompt).not.toContain('"kind": "clipping"');
  });

  test("at most two cues", async () => {
    const { services, llm } = setup([JSON.stringify({ audio: [{ cue: "tide" }, { cue: "tide", action: "stop" }, { cue: "tide" }] })]);
    const proposal = await computeDirector(input(services), llm);
    expect(proposal.audio).toHaveLength(MAX_AUDIO_CUES);
  });

  test("pack_only: the author's art is shown, nothing is generated or warmed", async () => {
    const { services, llm } = setup([JSON.stringify({ image: { subject: "gu", prompt: "her face" }, prepare: ["gu"] })]);
    const proposal = await computeDirector(input(services, { kit: roomKit({ ...BASE_KIT, generation: "pack_only" }) }), llm);
    expect(proposal.image).toMatchObject({ kind: "show", outcome: "pack_only", asset: ASSETS["assets/gu.png"] });
    expect(proposal.prepare).toEqual([]);
    expect(llm.calls[0]?.[0]?.content).toContain("allows NO image generation");
  });

  test("a subject with no reference is never generated", async () => {
    const { services, llm } = setup([JSON.stringify({ image: { subject: "quay" } })]);
    expect((await computeDirector(input(services), llm)).image).toEqual({ kind: "none", outcome: "ref_missing" });
  });

  test("the image budget: generate, book, serve from the larder, then decline", async () => {
    const ask = JSON.stringify({ image: { subject: "gu", prompt: "on the quay" }, prepare: ["gu", "quay"] });
    const { services, store, llm } = setup([ask, ask, ask]);
    const context = contextFor(services, store.beginTurn(ROOM));

    const first = await computeDirector(input(services), llm);
    expect(first.image.kind).toBe("generate");
    if (first.image.kind !== "generate") return;
    expect(first.image.prompt).toBe("a woman in a dark coat. on the quay. ink wash, 1925 coast. palette: #16232e. avoid: text overlays");
    // The subject being generated now is not warmed again; one without a reference never is.
    expect(first.prepare).toEqual([]);
    const made: KitAsset = { hash: "c".repeat(64), mime: "image/png", size: 7 };
    const rendered = await renderDirectorImage(first.image, {
      readAsset: async () => new Uint8Array([1, 2, 3]),
      generate: async (request) => {
        expect(request.reference.mime).toBe("image/png");
        return { bytes: new Uint8Array([9]), mime: "image/png" };
      },
      storeImage: async () => made,
    });
    expect(rendered).toEqual({ status: "generated", subject: first.image.subject, asset: made });
    const commit = commitDirector(context, first, rendered, { clock: services.clock });
    expect(commit.status === "committed" && commit.spent).toBe(true);
    expect(store.stateGet(ROOM, IMAGES_SPENT_KEY)).toBe(1);

    const second = await computeDirector(input(services), llm);
    expect(second.image).toMatchObject({ kind: "show", outcome: "larder", asset: made });

    commitWarmedImage(context, first.image.subject, made);
    const spent = readDirectorImageState(store, ROOM);
    expect(spent.spent).toBe(2);
    const third = await computeDirector(input(services, { images: { spent: 2, larder: new Map() } }), llm);
    expect(third.image).toMatchObject({ kind: "show", outcome: "budget", asset: ASSETS["assets/gu.png"] });
  });

  test("a failed generation falls back to the reference and books nothing", async () => {
    const { services, store, llm } = setup([JSON.stringify({ image: { subject: "gu" } })]);
    const context = contextFor(services, store.beginTurn(ROOM));
    const proposal = await computeDirector(input(services), llm);
    if (proposal.image.kind !== "generate") throw new Error("expected a generate plan");
    const rendered = await renderDirectorImage(proposal.image, {
      readAsset: async () => new Uint8Array([1]),
      generate: async () => {
        throw Object.assign(new Error("down"), { code: "transient" });
      },
      storeImage: async () => null,
    });
    expect(rendered).toMatchObject({ status: "fallback", code: "transient", asset: ASSETS["assets/gu.png"] });
    const commit = commitDirector(context, proposal, rendered, { clock: services.clock });
    expect(commit.status === "committed" && commit.spent).toBe(false);
    expect(commit.status === "committed" && commit.event?.data).toEqual({
      blocks: [{ kind: "image", hash: ASSETS["assets/gu.png"]?.hash, mime: "image/png", size: 100, caption: "Gu Wantang" }],
    });
    expect(store.stateGet(ROOM, IMAGES_SPENT_KEY)).toBeNull();
  });

  test("malformed output and a dead model degrade to a status", async () => {
    const { services, llm } = setup(["no json here", JSON.stringify({ blocks: "x", audio: 3, image: "gu", prepare: {} }), { error: new Error("boom") }]);
    const statuses = [];
    for (let index = 0; index < 3; index++) {
      const proposal = await computeDirector(input(services), llm);
      statuses.push(proposal.status);
      expect(proposal.blocks).toEqual([]);
      expect(proposal.image).toEqual({ kind: "none", outcome: "none" });
    }
    expect(statuses).toEqual(["unparsed", "ok", "model_failed"]);
  });

  test("a room with no kit makes no call", async () => {
    const { services, llm } = setup([]);
    const proposal = await computeDirector(input(services, { kit: mergeRoomKit([], "en").kit }), llm);
    expect(proposal.status).toBe("no_kit");
    expect(llm.calls).toHaveLength(0);
  });
});

describe("the commit", () => {
  const STAGED = JSON.stringify({ blocks: [{ kind: "text", text: "Nine lanterns.", style: "quote" }], audio: [{ cue: "tide", action: "play" }] });

  test("the staging is logged under the scheduled turn; audio comes back as signals", async () => {
    const { services, store, llm } = setup([STAGED]);
    const scheduled = contextFor(services, store.beginTurn(ROOM));
    const proposal = await computeDirector(input(services), llm);
    store.beginTurn(ROOM);
    const commit = commitDirector(scheduled, proposal, null, { clock: services.clock });
    if (commit.status !== "committed") throw new Error("stale");
    expect(commit.event).toMatchObject({ kind: "blocks", turn: 1, data: { blocks: [{ kind: "text", text: "Nine lanterns.", style: "quote" }] } });
    expect(commit.audio).toEqual([{ id: expect.any(String), action: "play", layer: "bgm", hash: ASSETS["assets/tide.mp3"]?.hash, mime: "audio/mpeg", title: "Tide", loop: true }]);
  });

  test("after a reset or an undo the commit is stale and writes nothing", async () => {
    const { services, store, types, llm } = setup([STAGED, STAGED]);
    const first = contextFor(services, store.beginTurn(ROOM));
    const proposal = await computeDirector(input(services), llm);
    store.reset(ROOM, "story", documentCatalog(types));
    expect(commitDirector(first, proposal, null, { clock: services.clock })).toEqual({ status: "stale" });
    expect(store.eventsAfter(ROOM, 0, 100)).toEqual([]);

    store.beginTurn(ROOM);
    const late = contextFor(services, store.beginTurn(ROOM));
    const again = await computeDirector(input(services), llm);
    store.undoTo(ROOM, 1);
    expect(commitDirector(late, again, null, { clock: services.clock })).toEqual({ status: "stale" });
    expect(commitWarmedImage(late, roomKit().subjects[0] as never, { hash: "d", mime: "image/png", size: 1 })).toBe("stale");
    expect(store.eventsAfter(ROOM, 0, 100)).toEqual([]);
    expect(store.stateGet(ROOM, LARDER_KEY)).toBeNull();
  });
});
