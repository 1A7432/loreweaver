import { describe, expect, test } from "bun:test";

import type { Services } from "../../../src/agent/context.ts";
import { MAX_LINE_CHARS, type NpcVoiceRequest, voiceNpc } from "../../../src/agent/lanes/npc_actor.ts";
import { type Document, DocumentTypes, type DocumentType, type Viewer } from "../../../src/core/documents/model.ts";
import { RawDocuments } from "../../../src/core/documents/raw.ts";
import { addNote, EMPTY_NOTES, KEEPER_NOTES_ID, KEEPER_NOTES_TYPE, keeperNotesData, keeperNotesDocument } from "../../../src/core/notes/index.ts";
import { createNpc, type Npc, npcData, npcDocument, type NpcView, NPC_TYPE } from "../../../src/core/npcs/index.ts";
import { currentLane, LLMError, type ScriptedReply, ScriptedLLM } from "../../../src/infra/llm/index.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { Store } from "../../../src/infra/store.ts";

function npc(draft: Parameters<typeof createNpc>[0]): Npc {
  const made = createNpc(draft);
  if (!made.ok) throw new Error(made.code);
  return made.data;
}

function doc(id: string, record: Npc): Document {
  return { type: NPC_TYPE, id, version: 1, data: npcData(record), meta: {}, corrupt: false };
}

const MARTHA = npc({
  name: "Martha",
  publicDescription: "The innkeeper.",
  persona: "A tired widow. OWN-PERSONA-MARKER",
  style: "Clipped. OWN-STYLE-MARKER",
  secretAgenda: "Hide the ledger. OWN-SECRET-MARKER",
  knowledge: ["The cellar door sticks. OWN-FACT-MARKER"],
  disposition: "wary",
});

const HALE = npc({
  name: "Mr. Hale",
  persona: "OTHER-PERSONA-MARKER",
  secretAgenda: "OTHER-NPC-SECRET-MARKER",
  knowledge: ["OTHER-NPC-FACT-MARKER"],
});

function models(llm: ScriptedLLM): Pick<Services, "models"> {
  return { models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm } };
}

function request(overrides: Partial<NpcVoiceRequest> = {}): NpcVoiceRequest {
  return {
    room: "room-1",
    locale: "en",
    document: doc("martha", MARTHA),
    type: npcDocument,
    situation: "The party asks about the cellar.",
    ...overrides,
  };
}

const GOOD = JSON.stringify({ dialogue: "Cellar's shut. Always has been.", action_intent: "Move the ledger tonight.", mood: "guarded" });

function sent(llm: ScriptedLLM): string {
  return (llm.calls[0] ?? []).map((message) => message.content).join("\n");
}

describe("isolation", () => {
  test("the prompt carries this NPC's own record and nothing else in the room", async () => {
    // A real room holding another NPC's secret and the Keeper's notes beside this NPC.
    const store = new Store(openDatabase(":memory:"));
    const types = new DocumentTypes().register(npcDocument).register(keeperNotesDocument);
    const documents = new RawDocuments(store, types);
    const writer = store.writer("room-1");
    documents.put(writer, NPC_TYPE, "martha", npcData(MARTHA));
    documents.put(writer, NPC_TYPE, "hale", npcData(HALE));
    const notes = addNote(EMPTY_NOTES, "plot", "KEEPER-NOTE-MARKER: Martha's husband is alive.", null);
    if (!notes.ok) throw new Error(notes.code);
    documents.put(writer, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID, keeperNotesData(notes.data));

    const llm = new ScriptedLLM([GOOD]);
    const stored = documents.get("room-1", NPC_TYPE, "martha");
    if (stored === null) throw new Error("missing");
    // Even handed an object that can reach the whole store, the lane reads none of it.
    const everything = { ...models(llm), store, documents, types };
    const result = await voiceNpc(everything, request({ document: stored }));
    expect(result.ok).toBe(true);

    const prompt = sent(llm);
    for (const own of ["OWN-PERSONA-MARKER", "OWN-STYLE-MARKER", "OWN-SECRET-MARKER", "OWN-FACT-MARKER", "Martha", "wary"]) expect(prompt).toContain(own);
    for (const foreign of ["OTHER-PERSONA-MARKER", "OTHER-NPC-SECRET-MARKER", "OTHER-NPC-FACT-MARKER", "KEEPER-NOTE-MARKER", "Mr. Hale"]) {
      expect(prompt).not.toContain(foreign);
    }
  });

  test("the record is projected for the NPC as an actor, never at Keeper grade", async () => {
    const seen: Viewer[] = [];
    const spy: DocumentType<NpcView> = {
      ...npcDocument,
      project(document, viewer) {
        seen.push(viewer);
        return npcDocument.project(document, viewer);
      },
    };
    const llm = new ScriptedLLM([GOOD]);
    await voiceNpc(models(llm), request({ type: spy, locale: "zh" }));
    expect(seen).toEqual([{ grade: "player", actorId: "martha", locale: "zh" }]);
  });

  test("a type that withholds the record from its own actor gets no call", async () => {
    const tableOnly: DocumentType<NpcView> = {
      ...npcDocument,
      project: (document) => npcDocument.project(document, { grade: "player", locale: "en" }),
    };
    const llm = new ScriptedLLM([]);
    expect(await voiceNpc(models(llm), request({ type: tableOnly }))).toEqual({ ok: false, code: "not_own_view" });
    expect(await voiceNpc(models(llm), request({ document: { ...doc("martha", MARTHA), type: "lore" } }))).toEqual({ ok: false, code: "wrong_type" });
    expect(await voiceNpc(models(llm), request({ document: { ...doc("martha", MARTHA), data: {}, corrupt: true } }))).toEqual({ ok: false, code: "unreadable" });
    expect(llm.calls).toHaveLength(0);
  });

  test("rendered card texts replace the stored ones; a mismatched or over-long rendering is refused", async () => {
    const llm = new ScriptedLLM([GOOD]);
    await voiceNpc(models(llm), request({ rendered: { persona: "RENDERED-PERSONA", knowledge: ["RENDERED-FACT"] } }));
    const prompt = sent(llm);
    expect(prompt).toContain("RENDERED-PERSONA");
    expect(prompt).toContain("RENDERED-FACT");
    expect(prompt).not.toContain("OWN-PERSONA-MARKER");
    expect(prompt).not.toContain("OWN-FACT-MARKER");
    expect(await voiceNpc(models(llm), request({ rendered: { knowledge: [] } }))).toEqual({ ok: false, code: "rendered_mismatch" });
    expect(await voiceNpc(models(llm), request({ rendered: { style: "x".repeat(501) } }))).toEqual({ ok: false, code: "rendered_too_long" });
  });
});

describe("prompt and call", () => {
  test("the 2.6 prompt in the room's locale, the hints, the npc lane and the effort", async () => {
    let lane: unknown;
    const llm = new ScriptedLLM(() => {
      lane = currentLane();
      return GOOD;
    });
    await voiceNpc(models(llm), request({ locale: "zh", tone: "nervous", target: "Ada", allowedActions: "talk only", effort: "high" }));
    const [system, user] = llm.calls[0] ?? [];
    expect(system?.content.startsWith("你是Martha。")).toBe(true);
    expect(system?.content).toContain("你现在只能采取以下行动：talk only。");
    expect(user?.content).toBe("The party asks about the cellar.\n要求的语气：nervous\n你正在对……说话/回应：Ada");
    expect(llm.requests[0]?.options.reasoningEffort).toBe("high");
    expect(lane).toEqual({ lane: "npc", fields: { room: "room-1", npc: "martha" } });
  });

  test("an empty record falls back to the catalog's placeholders and 'neutral'", async () => {
    const llm = new ScriptedLLM([GOOD]);
    await voiceNpc(models(llm), request({ document: doc("bob", npc({ name: "Bob" })) }));
    const system = llm.calls[0]?.[0]?.content ?? "";
    expect(system).toContain("(no persona notes yet");
    expect(system).toContain("Your attitude to the party: neutral.");
    expect(system).toContain("(nothing yet)");
    expect(llm.requests[0]?.options.reasoningEffort).toBe("medium");
  });

  test("the Keeper's arguments are checked before any call", async () => {
    const llm = new ScriptedLLM([]);
    expect(await voiceNpc(models(llm), request({ situation: "  " }))).toEqual({ ok: false, code: "empty_situation" });
    expect(await voiceNpc(models(llm), request({ situation: "x".repeat(4_001) }))).toEqual({ ok: false, code: "situation_too_long" });
    expect(await voiceNpc(models(llm), request({ tone: "x".repeat(501) }))).toEqual({ ok: false, code: "hint_too_long" });
    expect(await voiceNpc(models(llm), request({ effort: "max" as never }))).toEqual({ ok: false, code: "bad_effort" });
    expect(llm.calls).toHaveLength(0);
  });
});

describe("the reply", () => {
  async function voice(reply: ScriptedReply) {
    return voiceNpc(models(new ScriptedLLM([reply])), request());
  }

  test("the intent is returned apart and never appears in the line", async () => {
    const result = await voice(`Sure, here:\n\`\`\`json\n${GOOD}\n\`\`\``);
    expect(result).toEqual({
      ok: true,
      npc: "martha",
      name: "Martha",
      line: "Cellar's shut. Always has been.",
      intent: "Move the ledger tonight.",
      mood: "guarded",
      degraded: false,
    });
    if (result.ok) expect(result.line).not.toContain("ledger");
  });

  test("plain prose degrades to the line, with no intent and no mood", async () => {
    expect(await voice("  Get out of my inn.  ")).toEqual({ ok: true, npc: "martha", name: "Martha", line: "Get out of my inn.", intent: "", mood: "", degraded: true });
    expect(await voice("[looks away] Fine.")).toMatchObject({ ok: true, line: "[looks away] Fine.", degraded: true });
  });

  test("a broken object is never spoken: it may carry the intent", async () => {
    expect(await voice('{"dialogue": "Hello", "action_intent": "Poison the stew"')).toEqual({ ok: false, code: "unparseable" });
    expect(await voice('Hello there. "action_intent": "Poison the stew"')).toEqual({ ok: false, code: "unparseable" });
    // Valid JSON of another shape is not taken as speech either (2.6 spoke the raw JSON).
    expect(await voice('{"line": "Hello", "plan": "Poison the stew"}')).toEqual({ ok: false, code: "unparseable" });
  });

  test("an intent without a line is a silent action; nothing at all is an empty reply", async () => {
    expect(await voice(JSON.stringify({ dialogue: "", action_intent: "Slip out the back.", mood: "" }))).toMatchObject({ ok: true, line: "", intent: "Slip out the back." });
    expect(await voice(JSON.stringify({ dialogue: "", action_intent: "", mood: "" }))).toEqual({ ok: false, code: "empty_reply" });
    expect(await voice("   ")).toEqual({ ok: false, code: "empty_reply" });
  });

  test("over a cap is refused, never cut", async () => {
    expect(await voice(JSON.stringify({ dialogue: "x".repeat(MAX_LINE_CHARS + 1) }))).toEqual({ ok: false, code: "reply_too_long" });
    expect(await voice(JSON.stringify({ dialogue: "Hi", action_intent: "y".repeat(501) }))).toEqual({ ok: false, code: "reply_too_long" });
  });

  test("stop reasons: a cut-off reply, a refusal, the window", async () => {
    expect(await voice({ content: '{"dialogue": "Hel', stopReason: "output_cap" })).toEqual({ ok: false, code: "output_cap" });
    expect(await voice({ content: "Well, I suppose the cellar", stopReason: "output_cap" })).toEqual({ ok: false, code: "output_cap" });
    expect(await voice({ content: GOOD, stopReason: "output_cap" })).toMatchObject({ ok: true });
    expect(await voice({ content: "", stopReason: "refused" })).toEqual({ ok: false, code: "model_refused" });
    expect(await voice({ content: "", stopReason: "context_window" })).toEqual({ ok: false, code: "context_overflow" });
  });

  test("a failed call is a code, never an exception", async () => {
    expect(await voice({ error: new LLMError({ code: "rate_limited", retryable: true }) })).toEqual({ ok: false, code: "model_failed", llm: "rate_limited" });
    expect(await voice({ error: new LLMError({ code: "context_overflow", retryable: false }) })).toEqual({ ok: false, code: "context_overflow", llm: "context_overflow" });
    expect(await voice({ error: new Error("boom") })).toEqual({ ok: false, code: "model_failed", llm: "thrown" });
  });
});

test("abort: the caller's signal reaches the model, and an aborted call is a code", async () => {
  const controller = new AbortController();
  const llm = new ScriptedLLM(async (_messages, options) => {
    controller.abort();
    options.signal?.throwIfAborted();
    return GOOD;
  });
  const result = await voiceNpc(models(llm), request({ signal: controller.signal }));
  expect(llm.requests[0]?.options.signal).toBe(controller.signal);
  expect(result).toEqual({ ok: false, code: "aborted" });

  const late = new ScriptedLLM([GOOD]);
  expect(await voiceNpc(models(late), request({ signal: controller.signal }))).toEqual({ ok: false, code: "aborted" });
});
