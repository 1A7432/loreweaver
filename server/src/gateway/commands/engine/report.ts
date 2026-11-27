// `report` — the session report ("团报"): the table's keepsake of a session.
//
// Text (the default) is a compact scoreboard in the caller's result. `html` is the whole
// session as one self-contained page: it is stored as an UNLISTED file of the room and its
// reference returned to the caller alone — never an event, never in a listing — who fetches
// it over the byte channel. The player edition is built from the event log only, and any
// member of the room may fetch it. The reveal edition adds what was hidden during play; it
// is an admin's to ask for and is stored for admins only, so its hash is useless to a player.
//
// No model is called. The page is made and stored before the command's own (synchronous)
// step, and the command does not wait for the room's lock: a report asked for during a long
// Keeper turn is of the log as it stands.
import { jsonStateKey, type StateKey } from "../../../infra/lifecycle/declarations.ts";
import { REPORT_MIME } from "../../../infra/media/index.ts";
import type { StoredEvent } from "../../../infra/store.ts";
import { buildReport, buildReveal, renderReportHtml, renderReportText, type ReportModel } from "../../../core/report/index.ts";
import { REPORT_CATALOG } from "../../../core/report/catalog.ts";
import { translate } from "../../../infra/i18n.ts";
import type { Uploads } from "../../uploads.ts";
import { firstWord } from "../parse.ts";
import { BOOLEAN, object, oneOf } from "../schema.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, refuse, type Refused } from "../types.ts";

/** The report reads at most this many of the room's most recent events. */
export const MAX_REPORT_EVENTS = 100_000;
const PAGE = 1_000;

const HTML_WORDS = new Set(["html", "page", "网页", "網頁", "网页版", "網頁版"]);
const REVEAL_WORDS = new Set(["reveal", "复盘", "復盤", "复盘版", "復盤版"]);
const TEXT_WORDS = new Set(["", "text", "summary", "文字", "摘要"]);

type Edition = "player" | "reveal";

function isPages(value: unknown): value is { player?: string; reveal?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, hash]) => (key === "player" || key === "reveal") && typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash));
}

/** The room's latest report page per edition, so that a new one replaces it instead of piling up beside it. */
export const REPORT_PAGES: StateKey<{ player?: string; reveal?: string }> = jsonStateKey("report.pages", { reset: "all" }, isPages, {
  keptOnUndo: "a stored page is a file, not part of the story: an undo does not remove the file, so the entry naming it must stay",
});

function readEvents(call: CommandCall): StoredEvent[] {
  const store = call.context.services.store;
  const room = call.context.room;
  const head = store.room(room).head;
  let after = Math.max(store.firstSeq(room) - 1, head - MAX_REPORT_EVENTS, 0);
  const events: StoredEvent[] = [];
  for (;;) {
    const page = store.eventsAfter(room, after, PAGE);
    events.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < PAGE) return events;
    after = last.seq;
  }
}

function modelOf(call: CommandCall): ReportModel {
  return buildReport({ room: call.context.room, system: call.context.pack?.names[0] ?? null, events: readEvents(call), generatedAt: call.context.services.clock.now() });
}

function fileName(call: CommandCall, edition: Edition, at: number): string {
  const moment = new Date(at);
  const two = (value: number): string => String(value).padStart(2, "0");
  const when = `${moment.getFullYear()}${two(moment.getMonth() + 1)}${two(moment.getDate())}-${two(moment.getHours())}${two(moment.getMinutes())}`;
  return `${translate(REPORT_CATALOG, call.locale, `file.${edition}`)}-${call.context.room}-${when}.html`;
}

interface Stored {
  readonly edition: Edition;
  readonly media: { readonly hash: string; readonly mime: string; readonly size: number; readonly name: string };
}

export function reportCommand(uploads: Uploads | null): CommandSpec {
  return {
    id: "report",
    source: "engine",
    key: "report",
    params: object({ format: oneOf(["text", "html"]), reveal: BOOLEAN }),
    text: { en: ["report"], zh: ["report", "团报", "跑团记录"] },
    role: "player",
    observers: true,
    // The reveal edition prints what was hidden during play.
    adminWhen: (args) => args.reveal === true,
    unlocked: () => true,
    parseText(rest): Args | Refused {
      const words: string[] = [];
      let left = rest.trim();
      while (left !== "") {
        const [word, more] = firstWord(left);
        words.push(word.toLowerCase());
        left = more.trim();
      }
      if (words.length === 0 || (words.length === 1 && TEXT_WORDS.has(words[0] ?? ""))) return {};
      // A bare reveal word is shorthand for the HTML reveal edition.
      if (!words.every((word) => HTML_WORDS.has(word) || REVEAL_WORDS.has(word))) return refuse("usage");
      return words.some((word) => REVEAL_WORDS.has(word)) ? { format: "html", reveal: true } : { format: "html" };
    },
    async prepare(call, args): Promise<Stored | Refused | null> {
      if (args.format !== "html" && args.reveal !== true) return null;
      if (uploads === null) return refuse("report_no_files");
      const edition: Edition = args.reveal === true ? "reveal" : "player";
      const model = modelOf(call);
      const reveal = edition === "reveal" ? buildReveal(call.context.services.views, call.context.room, call.locale) : null;
      const page = renderReportHtml(model, call.locale, reveal);
      const stored = await uploads.media.registerServerBlob({
        room: call.context.room,
        bytes: new TextEncoder().encode(page.html),
        mime: REPORT_MIME,
        name: fileName(call, edition, model.generatedAt),
        // Unlisted either way; the reveal edition for admins alone.
        audience: edition === "reveal" ? "admin" : "members",
      });
      if (!stored.ok) return refuse("report_not_stored", { code: stored.code });
      const { hash, mime, size, name } = stored.record;
      return { edition, media: { hash, mime, size, name } };
    },
    run(call, _args, prepared): Done | Refused {
      if (prepared === null || prepared === undefined) {
        const model = modelOf(call);
        return { text: renderReportText(model, call.locale), data: { format: "text", players: model.tally, turns: model.turns, lines: model.lines.length + model.omitted } };
      }
      if ("refused" in (prepared as object)) return prepared as Refused;
      const { edition, media } = prepared as Stored;
      // The page this one replaces is removed, unless it is the same bytes.
      const store = call.context.services.store;
      const pages = store.stateGet(call.context.room, REPORT_PAGES) ?? {};
      const previous = pages[edition];
      if (previous !== undefined && previous !== media.hash && uploads !== null) uploads.media.remove(call.context.room, previous);
      call.context.writer.statePut(REPORT_PAGES, { ...pages, [edition]: media.hash });
      return { text: call.say(edition === "reveal" ? "report.ready_reveal" : "report.ready", { name: media.name }), data: { format: "html", edition, media } };
    },
  };
}
