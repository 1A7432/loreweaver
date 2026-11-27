// Files members bring: `uploads` (the room's upload switch) and `import` (a card file — one
// the caller uploaded over the byte channel, or one an enabled pack ships — made the room's
// world or the caller's character).
//
// `import` is iron rule 3's card split at the command layer: `as: "world"` is the admin's and
// calls `importWorld`, the one path by which a card's world machinery reaches a room;
// `as: "character"` is any player's and calls `importCharacter`, which writes a character
// and a seat and nothing else, whatever the card holds. Its sheet is rolled for the room's
// rule system and biased toward the concept the authoring lane reads from the card's persona
// (the reference's `build_sheet_from_persona`; `genchar.ts` holds the shared step, its cap
// and its review): one model call in `prepare`, so a character import does not wait for the
// room's lock. Without a model, over the cap, or with an answer the lane cannot use, the
// sheet is rolled without a concept — the reference's fallback — and the caller is told why. The card file itself never becomes
// table media (see `../../uploads.ts`): the table hears one line for a world import — that a
// world was imported, and its name — and nothing at all of a character card.
import { characterPersona, importCharacter, importWorld, type CardImportRefusal, type LeftBehind } from "../../../agent/card_import.ts";
import { forgetItems, indexLoreEntries, type RecallDeps } from "../../../agent/recall.ts";
import { CardError, parseCard, type ImportedCard } from "../../../core/card/index.ts";
import { MAX_CHARACTER_NAME_CHARS } from "../../../core/characters/index.ts";
import type { RoomPacks } from "../../packs.ts";
import type { Uploads } from "../../uploads.ts";
import { firstWord } from "../parse.ts";
import { BOOLEAN, compact, object, oneOf, text } from "../schema.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, isRefused, refuse, type Refused } from "../types.ts";
import { type AuthoringDeps, type ConceptRead, readConcept, reviewConcept } from "./genchar.ts";
import { OFF_WORDS, ON_WORDS } from "./room.ts";
import { tableCharacterNames } from "../support.ts";

const HASH = /^[0-9a-f]{64}$/u;
const WORLD_WORDS: ReadonlySet<string> = new Set(["world", "世界"]);
const CHARACTER_WORDS: ReadonlySet<string> = new Set(["character", "char", "角色"]);

/** The reason both commands give on a server without a media store. */
const NO_MEDIA = "no_media";

/** `uploads`: show the room's upload switch (anyone), or set it (the admin). */
export function uploadsCommand(uploads: Uploads | null): CommandSpec {
  return {
    id: "uploads",
    source: "engine",
    key: "uploads",
    params: object({ on: BOOLEAN }),
    text: { en: ["uploads"], zh: ["uploads", "上传"] },
    role: "player",
    observers: true,
    adminWhen: (args) => args.on !== undefined,
    available: () => (uploads === null ? NO_MEDIA : true),
    parseText(rest) {
      const [word] = firstWord(rest);
      if (word === "") return {};
      if (ON_WORDS.has(word)) return { on: true };
      if (OFF_WORDS.has(word)) return { on: false };
      return refuse("usage");
    },
    run(call, args): Done | Refused {
      if (uploads === null) return refuse(NO_MEDIA);
      const room = call.context.room;
      if (args.on === undefined) {
        const on = uploads.enabled(room);
        return { text: call.say(on ? "uploads.status_on" : "uploads.status_off"), data: { on } };
      }
      const on = args.on as boolean;
      uploads.setEnabled(room, on);
      return { data: { on }, events: [{ kind: "narrative", data: { speaker: "system", text: call.tell(on ? "uploads.event_on" : "uploads.event_off"), format: "plain" } }] };
    },
  };
}

/** A card import's refusal, as the command layer states it. */
function cardRefusal(refusal: CardImportRefusal): Refused {
  switch (refusal.code) {
    case "stale_writer":
      return refuse("stale_generation");
    case "bad_name":
      return refuse("card_bad_name");
    case "name_taken":
      return refuse("name_taken", { name: refusal.detail ?? "" });
    case "sheet_refused":
    case "seat_refused":
      return refuse(refusal.code, { code: refusal.detail ?? "" });
    default:
      return refuse(refusal.code, { path: refusal.path ?? "", detail: refusal.detail ?? "" });
  }
}

/** "hooks ×2, secret entries ×1", in the caller's language. */
function partsText(call: CommandCall, parts: readonly LeftBehind[]): string {
  return parts.map((part) => call.say("import.part_count", { part: call.say(`import.part.${part.part}`), count: part.count })).join(call.say("import.list_separator"));
}

/** What the import reads: the caller's card, parsed (and, for a character, the concept read from its persona). */
interface Prepared {
  readonly card: ImportedCard;
  readonly concept?: ConceptRead;
}

/** The first whitespace-separated word of `text`, case kept, and the rest. */
function rawWord(text: string): readonly [string, string] {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match === null ? ["", ""] : [match[1] as string, (match[2] ?? "").trim()];
}

/** A card an enabled pack ships, by pack id and the card's path in the pack. */
async function packCard(packs: RoomPacks, call: CommandCall, packId: string, path: string): Promise<Prepared | Refused> {
  const loaded = packs.get(packId);
  if (loaded === null) return refuse("unknown_pack", { id: packId });
  if (!packs.enabledIds(call.context.services.store, call.context.room).includes(packId)) return refuse("pack_not_enabled", { id: packId });
  const card = loaded.pack.cards.find((item) => item.path === path);
  if (card === undefined) return refuse("card_not_in_pack", { id: packId, card: path });
  const bytes = await loaded.read(card.path);
  if (bytes === null) return refuse("card_unreadable", { card: path });
  try {
    return { card: parseCard(bytes, card.path.split("/").at(-1) ?? "") };
  } catch (error) {
    if (error instanceof CardError) return refuse("not_a_card", { code: error.code });
    throw error;
  }
}

/**
 * `import`: a card file — one the caller uploaded (`file`, `purpose: "import"`), or one a
 * pack enabled in this room ships (`pack` and `card`, its path in the pack) — as the room's
 * world (admin) or the caller's character.
 */
export function importCommand(uploads: Uploads | null, recall: RecallDeps | null, packs: RoomPacks | null = null, authoring: AuthoringDeps | null = null): CommandSpec {
  return {
    id: "import",
    source: "engine",
    key: "import",
    params: object({ file: text(64, 64), pack: text(64, 1), card: text(512, 1), as: oneOf(["world", "character"]), name: text(MAX_CHARACTER_NAME_CHARS, 1) }, ["as"]),
    text: { en: ["import"], zh: ["import", "导入"] },
    role: "player",
    adminWhen: (args) => args.as === "world",
    // A character import may wait on the model (the concept); a world import waits on nothing.
    unlocked: (args) => args.as === "character" && authoring !== null,
    available: () => (uploads === null && (packs === null || packs.installed().length === 0) ? NO_MEDIA : true),
    parseText(rest) {
      const [kind, after] = firstWord(rest);
      const as = WORLD_WORDS.has(kind) ? "world" : CHARACTER_WORDS.has(kind) ? "character" : null;
      if (as === null) return refuse("usage");
      // Case kept: a card's path in its pack is case-sensitive. A character's name may have spaces.
      const [first, afterFirst] = rawWord(after);
      if (first === "") return refuse("usage");
      if (HASH.test(first) || afterFirst === "") {
        // A world card keeps its own name.
        if (afterFirst !== "" && as === "world") return refuse("usage");
        return compact({ file: first, as, name: afterFirst === "" ? undefined : afterFirst });
      }
      const [card, name] = rawWord(afterFirst);
      if (name !== "" && as === "world") return refuse("usage");
      return compact({ pack: first.toLowerCase(), card, as, name: name === "" ? undefined : name });
    },
    async prepare(call, args): Promise<Prepared | Refused> {
      const read = await readCard(call, args);
      if (isRefused(read) || args.as !== "character" || authoring === null) return read;
      return { ...read, ...(await personaConcept(call, authoring, read.card, args.name as string | undefined)) };
    },
    run(call, args, prepared): Done | Refused {
      if (isRefused(prepared)) return prepared;
      const { card, concept } = prepared as Prepared;
      return args.as === "world" ? world(call, card, recall) : character(call, card, args.name as string | undefined, concept ?? null, authoring);
    },
  };

  async function readCard(call: CommandCall, args: Args): Promise<Prepared | Refused> {
    const member = call.context.who.member;
    if (member === null) return refuse("no_member");
    const fromPack = args.pack !== undefined || args.card !== undefined;
    if (fromPack === (args.file !== undefined)) return refuse("usage");
    if (fromPack) {
      if (packs === null) return refuse("unknown_pack", { id: String(args.pack ?? "") });
      if (args.pack === undefined) return refuse("missing_arg", { path: "pack" });
      if (args.card === undefined) return refuse("missing_arg", { path: "card" });
      return packCard(packs, call, args.pack as string, args.card as string);
    }
    if (uploads === null) return refuse(NO_MEDIA);
    const hash = args.file as string;
    if (!HASH.test(hash)) return refuse("invalid_arg", { path: "file" });
    const file = await uploads.importFile(call.context.room, member.id, hash);
    // Never uploaded, uploaded by somebody else, or gone with a reset: one answer.
    if (file === undefined) return refuse("not_uploaded");
    try {
      return { card: parseCard(file.bytes, file.record.name) };
    } catch (error) {
      if (error instanceof CardError) return refuse("not_a_card", { code: error.code });
      throw error;
    }
  }
}

/** The concept for a character import: none when the room has no rule system or the import would be refused anyway. */
async function personaConcept(call: CommandCall, authoring: AuthoringDeps, card: ImportedCard, name: string | undefined): Promise<{ concept?: ConceptRead }> {
  const pack = call.context.pack;
  const persona = characterPersona(card, name);
  // A name already at the table is refused by the import: no call for it.
  if (pack === null || persona === null || tableCharacterNames(call, null).has(persona.name.toLowerCase())) return {};
  return { concept: await readConcept(call, authoring, pack, persona, "import") };
}

function world(call: CommandCall, card: ImportedCard, recall: RecallDeps | null): Done | Refused {
  const context = call.context;
  const result = importWorld(context, card, { importedBy: context.who.member?.id ?? null });
  if (!result.ok) return cardRefusal(result);
  const lines = [
    call.say(result.code === "world_reimported" ? "import.world_redone" : "import.world_done", {
      name: result.name,
      lore: result.lore.written,
      secret: result.lore.secret,
      replaced: result.lore.replaced,
      variables: result.variables.declarations,
      openings: result.openings,
    }),
  ];
  if (result.otherWorlds > 0) lines.push(call.say("import.world_stacked", { count: result.otherWorlds + 1 }));
  if (result.lore.skippedTooLong.length > 0) lines.push(call.say("import.skipped_long", { count: result.lore.skippedTooLong.length }));
  if (result.lore.unreachable.length > 0) lines.push(call.say("import.unreachable", { count: result.lore.unreachable.length }));
  if (result.variables.unreadable > 0) lines.push(call.say("import.unreadable_declarations", { count: result.variables.unreadable }));
  if (result.notImported.length > 0) lines.push(call.say("import.left_behind", { parts: partsText(call, result.notImported) }));
  // Everything but the lore's text: the new entries' content stays in the room's documents.
  const { index, forget, ...data } = result;
  const done: { -readonly [K in keyof Done]: Done[K] } = {
    text: lines.join("\n"),
    data,
    events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("import.event_world", { name: result.name }), format: "plain" } }],
  };
  if (recall !== null && (index.length > 0 || forget.length > 0)) {
    done.after = async () => {
      const room = context.room;
      try {
        forgetItems(recall, room, "lore", forget);
      } catch (error) {
        context.services.report(room, `import: dropping replaced lore from recall failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const outcome = await indexLoreEntries(recall, context, index);
      for (const problem of outcome.problems) context.services.report(room, `import: recall indexing: ${problem.code}`);
      const failed = outcome.problems[0];
      if (failed !== undefined) return [call.say("import.recall_failed", { code: failed.code })];
      return outcome.indexed > 0 ? [call.say("import.indexed", { count: outcome.indexed })] : [];
    };
  }
  return done;
}

/** Why the sheet was rolled without reading the persona, in the caller's language. */
function conceptSkipped(call: CommandCall, status: Exclude<ConceptRead["status"], "applied">): string {
  if (status === "no_model") return call.say("import.concept_no_model");
  if (status === "rate_limited") return call.say("import.concept_rate_limited");
  return call.say("import.concept_failed");
}

function character(call: CommandCall, card: ImportedCard, name: string | undefined, read: ConceptRead | null, authoring: AuthoringDeps | null): Done | Refused {
  const concept = read?.status === "applied" && authoring !== null ? reviewConcept(call, authoring, read.concept) : null;
  const result = importCharacter(call.context, card, { ...(name === undefined ? {} : { name }), concept });
  if (!result.ok) return cardRefusal(result);
  const label = call.context.services.packs.get(result.pack)?.sheet.shape?.label ?? "";
  const lines = [call.say("import.character_done", { name: result.name, system: label === "" ? result.pack : label })];
  if (read !== null && read.status !== "applied") lines.push(conceptSkipped(call, read.status));
  if (result.worldCard) lines.push(call.say("import.character_world_card"));
  if (result.stripped.length > 0) lines.push(call.say("import.stripped", { parts: partsText(call, result.stripped) }));
  return { text: lines.join("\n"), data: { ...result, concept: read?.status ?? "none" } };
}
