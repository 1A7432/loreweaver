// `save` — the whole room as one file, out and back in, over the byte channel.
//
// A bundle holds every secret of the room and may be far larger than a control-stream line,
// so it never travels in a frame. `export` serialises the room, stores it as an UNLISTED file
// of the room for admins only (the `save` budget), and answers the caller alone with its
// reference; the client fetches the bytes with a GET. `import` takes the hash of a save file
// the caller uploaded (`media.offer {purpose: "save"}`), reads it, and loads it with the same
// all-or-nothing check as any bundle.
//
// The room keeps only its latest export: a new one removes the previous file first, so the
// room's save budget holds one export and one upload. The key naming it never travels in a
// bundle (`StateKey.outsideBundle`): an import clears the room's media, the file is not there.
//
// An uploaded save is removed once it was read: on success the import clears the room's
// media anyway; a refused import removes it as well (the bytes will not load any better on a
// second try — the client still has the file and offers it again).
import { LifecycleError, StaleGeneration } from "../../../infra/lifecycle/errors.ts";
import { jsonStateKey, type StateKey } from "../../../infra/lifecycle/declarations.ts";
import { SAVE_MIME } from "../../../infra/media/index.ts";
import type { Uploads } from "../../uploads.ts";
import { firstWord } from "../parse.ts";
import { object, oneOf, text } from "../schema.ts";
import { documentCatalogOf } from "../support.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, isRefused, refuse, type Refused } from "../types.ts";
import { lifecycleRefusal } from "./room.ts";

const HASH = /^[0-9a-f]{64}$/u;

/** The reason `save` gives on a server without a media store (as `uploads` and `import` do). */
const NO_MEDIA = "no_media";

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

/** The room's latest export, so that a new one replaces it instead of piling up beside it. */
export const SAVE_EXPORT: StateKey<string> = jsonStateKey("save.export", { reset: "all" }, isHash, {
  keptOnUndo: "a stored save is a file, not part of the story: an undo does not remove the file, so the entry naming it must stay",
  outsideBundle: "it names a file of this room's media, which an import clears: the loaded room does not hold it",
});

interface Exported {
  readonly kind: "export";
  readonly documents: number;
  readonly events: number;
  readonly media: { readonly hash: string; readonly mime: string; readonly size: number; readonly name: string };
}

interface Read {
  readonly kind: "import";
  readonly hash: string;
  readonly bundle: unknown;
}

function fileName(call: CommandCall, at: number): string {
  const moment = new Date(at);
  const two = (value: number): string => String(value).padStart(2, "0");
  const when = `${moment.getFullYear()}${two(moment.getMonth() + 1)}${two(moment.getDate())}-${two(moment.getHours())}${two(moment.getMinutes())}${two(moment.getSeconds())}`;
  return `${call.say("save.file")}-${call.context.room}-${when}.json`;
}

export function saveCommand(uploads: Uploads | null): CommandSpec {
  return {
    id: "save",
    source: "engine",
    key: "save",
    params: object({ op: oneOf(["export", "import"]), file: text(64, 64) }, ["op"]),
    text: { en: ["save"], zh: ["save", "存档", "存檔"] },
    role: "admin",
    danger: true,
    lifecycle: true,
    available: () => (uploads === null ? NO_MEDIA : true),
    parseText(rest): Args | Refused {
      const [word, after] = firstWord(rest);
      if (word === "" || word === "export") return after === "" ? { op: "export" } : refuse("usage");
      if (word !== "import") return refuse("usage");
      const [file, more] = firstWord(after);
      if (file === "") return refuse("missing_arg", { path: "file" });
      return more === "" ? { op: "import", file } : refuse("usage");
    },
    prepare(call, args): Promise<Exported | Read | Refused> {
      if (uploads === null) return Promise.resolve(refuse(NO_MEDIA));
      return args.op === "import" ? readSave(call, uploads, args) : storeExport(call, uploads);
    },
    run(call, args, prepared): Done | Refused {
      if (uploads === null) return refuse(NO_MEDIA);
      if (isRefused(prepared)) return prepared;
      const done = prepared as Exported | Read;
      return done.kind === "export" ? exported(call, uploads, done) : imported(call, uploads, done);
    },
  };
}

/**
 * Serialise the room and store it. The previous export goes first, so that the room's save
 * budget holds this one; a failure to store leaves the room with no export, never with an
 * entry naming a file that is gone.
 */
async function storeExport(call: CommandCall, uploads: Uploads): Promise<Exported | Refused> {
  const { services, room, writer } = call.context;
  const bundle = services.store.exportRoom(room);
  const counts = { documents: bundle.documents.length, events: bundle.events.length };
  // Encoded at once, so the only large string lives no longer than this statement.
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const previous = services.store.stateGet(room, SAVE_EXPORT);
  if (previous !== null) {
    try {
      writer.stateDelete(SAVE_EXPORT);
    } catch (error) {
      // The room was rewound, reset or replaced under the call: nothing of it is touched.
      if (error instanceof StaleGeneration) return refuse("stale_generation");
      throw error;
    }
    uploads.media.remove(room, previous);
  }
  const stored = await uploads.media.registerServerBlob({
    room,
    bytes,
    mime: SAVE_MIME,
    name: fileName(call, services.clock.now()),
    audience: "admin",
    save: true,
  });
  if (!stored.ok) return refuse("save_not_stored", { reason: stored.code });
  const { hash, mime, size, name } = stored.record;
  return { kind: "export", ...counts, media: { hash, mime, size, name } };
}

function exported(call: CommandCall, uploads: Uploads, done: Exported): Done {
  const { services, room, writer } = call.context;
  // Another export may have finished while this one was stored: the room keeps the latest.
  const other = services.store.stateGet(room, SAVE_EXPORT);
  if (other !== null && other !== done.media.hash) uploads.media.remove(room, other);
  writer.statePut(SAVE_EXPORT, done.media.hash);
  // The reference is the caller's: the file holds every secret of the room, so it is never an event.
  return {
    text: call.say("save.exported", { documents: done.documents, events: done.events, name: done.media.name }),
    data: { documents: done.documents, events: done.events, media: done.media },
  };
}

/** The save file the caller uploaded, read and parsed as JSON; what it holds is `importRoom`'s to judge. */
async function readSave(call: CommandCall, uploads: Uploads, args: Args): Promise<Read | Refused> {
  const member = call.context.who.member;
  if (member === null) return refuse("no_member");
  if (args.file === undefined) return refuse("missing_arg", { path: "file" });
  if (!isHash(args.file)) return refuse("invalid_arg", { path: "file" });
  const hash = args.file;
  const file = await uploads.saveFile(call.context.room, member.id, hash);
  // Never uploaded, uploaded by somebody else, or gone with a reset or an import: one answer.
  if (file === undefined) return refuse("save_not_uploaded");
  let bundle: unknown;
  try {
    bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
  } catch {
    dropUpload(call, uploads, hash);
    return refuse("bad_bundle", { path: "" });
  }
  return { kind: "import", hash, bundle };
}

function imported(call: CommandCall, uploads: Uploads, read: Read): Done | Refused {
  const { services, room } = call.context;
  let result;
  try {
    result = services.store.importRoom(room, read.bundle, documentCatalogOf(services));
  } catch (error) {
    if (error instanceof LifecycleError) dropUpload(call, uploads, read.hash);
    return lifecycleRefusal(error, call);
  }
  // Gone already when the import cleared the room's media; said again for a store without that storage.
  uploads.media.remove(room, read.hash);
  return {
    text: call.say("save.imported", { turn: result.turn }),
    data: { epoch: result.epoch, turn: result.turn },
    lifecycle: { kind: "import", epoch: result.epoch, turn: result.turn },
  };
}

/** Remove an uploaded save that did not load — unless it is the room's latest export, which stays. */
function dropUpload(call: CommandCall, uploads: Uploads, hash: string): void {
  const room = call.context.room;
  if (call.context.services.store.stateGet(room, SAVE_EXPORT) === hash) return;
  uploads.media.remove(room, hash);
}
