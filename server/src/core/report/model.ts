// The session report ("团报") as data: what a table keeps of a session. Deterministic, no
// model call.
//
// It has ONE source: the room's event log — the lines and the dice exactly as the table saw
// them. No document is read for it, so there is nothing Keeper-grade it could pick up; the
// reveal edition's extra material is gathered separately (`reveal.ts`).
//
// What the log cannot carry is left out rather than guessed: a hidden roll emits no event
// (its result went to the roller alone), so no edition lists hidden rolls.
import type { StoredEvent } from "../../infra/store.ts";

/** The transcript keeps the most recent lines within this many characters, and says what it left out. */
export const MAX_TRANSCRIPT_CHARS = 200_000;
/** The dice log keeps this many of the most recent rolls. */
export const MAX_DICE_ENTRIES = 2_000;

export type Speaker = "player" | "kp" | "npc" | "system";
export type Tone = "crit" | "success" | "fail" | "fumble" | "plain";
export const TONES: readonly Tone[] = ["crit", "success", "fail", "fumble", "plain"];
export type Rating = "legendary" | "excellent" | "good" | "qualified" | "needs_effort";

export interface ReportLine {
  readonly turn: number | null;
  readonly speaker: Speaker;
  /** The speaker's name as the table saw it; empty for the Keeper's own narration. */
  readonly name: string;
  readonly text: string;
  readonly format: "markdown" | "plain";
}

export interface ReportDie {
  readonly ts: number;
  readonly actor: string;
  /** A graded check (it has an outcome) or a plain roll. */
  readonly graded: boolean;
  /** What was checked — a skill, a rule subsystem — or empty. */
  readonly what: string;
  readonly expr: string;
  readonly total: number;
  readonly target: number | null;
  /** The outcome's own label, already in the room's language when it was rolled. */
  readonly label: string;
  readonly tone: Tone;
  readonly tier: number | null;
}

export interface PlayerTally {
  readonly name: string;
  readonly rolls: number;
  readonly checks: number;
  readonly passed: number;
  readonly criticals: number;
  readonly fumbles: number;
  readonly tones: Readonly<Record<Tone, number>>;
  readonly score: number;
  readonly rating: Rating;
}

export interface ReportModel {
  readonly room: string;
  /** The rule system's display name, or null when the room has none. */
  readonly system: string | null;
  /** The first and last moment of the session, in milliseconds; null for an empty log. */
  readonly start: number | null;
  readonly end: number | null;
  readonly generatedAt: number;
  /** The players, by the name they played under, in order of first appearance. */
  readonly players: readonly string[];
  readonly tally: readonly PlayerTally[];
  readonly dice: readonly ReportDie[];
  readonly lines: readonly ReportLine[];
  /** Lines left out of the transcript (the earliest), to keep it within the cap. */
  readonly omitted: number;
  readonly turns: number;
}

export interface ReportInput {
  readonly room: string;
  readonly system: string | null;
  readonly events: readonly StoredEvent[];
  readonly generatedAt: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

const SPEAKERS: readonly Speaker[] = ["player", "kp", "npc", "system"];

function readLine(event: StoredEvent): ReportLine | null {
  if (!isRecord(event.data)) return null;
  const speaker = SPEAKERS.find((known) => known === own(event.data as Readonly<Record<string, unknown>>, "speaker"));
  const body = text(own(event.data, "text")).trim();
  if (speaker === undefined || body === "") return null;
  return {
    turn: typeof event.turn === "number" ? event.turn : null,
    speaker,
    name: text(own(event.data, "name")),
    text: body,
    format: own(event.data, "format") === "markdown" ? "markdown" : "plain",
  };
}

function readDie(event: StoredEvent): ReportDie | null {
  const data = event.data;
  if (!isRecord(data)) return null;
  const actor = text(own(data, "actor"));
  const total = own(data, "total");
  if (actor === "" || typeof total !== "number") return null;
  const outcome = own(data, "outcome");
  const detail = own(data, "detail");
  const target = own(data, "target");
  const what = text(own(data, "subsystemLabel")) || (isRecord(detail) ? text(own(detail, "skill")) : "");
  const base = { ts: event.ts, actor, what, expr: text(own(data, "expr")), total, target: typeof target === "number" ? target : null };
  if (!isRecord(outcome)) return { ...base, graded: false, label: "", tone: "plain", tier: null };
  const tier = own(outcome, "tier");
  const tone: Tone = own(outcome, "critical") === true ? "crit" : own(outcome, "fumble") === true ? "fumble" : own(outcome, "success") === true ? "success" : "fail";
  return { ...base, graded: true, label: text(own(outcome, "label")), tone, tier: typeof tier === "number" && Number.isInteger(tier) ? tier : null };
}

/**
 * A player's score from the dice alone (the 2.6 formula): 60, plus 2 for each roll or check
 * up to 20, plus the share of checks passed out of 20, plus 2 for each critical; 0..100.
 * Roleplay is deliberately unscored: the transcript is the record of it.
 */
export function scoreOf(tally: Pick<PlayerTally, "rolls" | "checks" | "passed" | "criticals">): { readonly score: number; readonly rating: Rating } {
  const acts = tally.rolls + tally.checks;
  const participation = Math.min(acts * 2, 20);
  const success = tally.checks > 0 ? Math.floor((tally.passed / tally.checks) * 20) : 0;
  const score = Math.max(0, Math.min(100, 60 + participation + success + tally.criticals * 2));
  const rating: Rating = score >= 90 ? "legendary" : score >= 80 ? "excellent" : score >= 70 ? "good" : score >= 60 ? "qualified" : "needs_effort";
  return { score, rating };
}

/**
 * The report of what `events` hold. `events` is the room's log in order; what came before
 * the last reset of the story is another session's and is left out.
 */
export function buildReport(input: ReportInput): ReportModel {
  let from = 0;
  input.events.forEach((event, index) => {
    if (event.kind !== "reset" || !isRecord(event.data)) return;
    const scope = own(event.data, "scope");
    if (scope === "story" || scope === "all") from = index + 1;
  });
  const events = input.events.slice(from);

  const all: ReportLine[] = [];
  const dice: ReportDie[] = [];
  const players: string[] = [];
  const turns = new Set<number>();
  for (const event of events) {
    if (event.kind === "narrative") {
      const line = readLine(event);
      if (line === null) continue;
      all.push(line);
      if (line.turn !== null) turns.add(line.turn);
      // Who the players are is read off the log: the names lines were spoken under.
      if (line.speaker === "player" && line.name !== "" && !players.includes(line.name)) players.push(line.name);
    } else if (event.kind === "dice") {
      const die = readDie(event);
      if (die !== null) dice.push(die);
    }
  }

  // The transcript: the most recent lines within the cap; the count of what was left out.
  let used = 0;
  let keep = all.length;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const cost = count(all[index]?.text ?? "");
    // The newest line is always kept, however long.
    if (used + cost > MAX_TRANSCRIPT_CHARS && index < all.length - 1) break;
    used += cost;
    keep = index;
  }
  const lines = all.slice(keep);

  const tally = players.map((name): PlayerTally => {
    const mine = dice.filter((die) => die.actor === name);
    const tones: Record<Tone, number> = { crit: 0, success: 0, fail: 0, fumble: 0, plain: 0 };
    for (const die of mine) tones[die.tone] += 1;
    const graded = mine.filter((die) => die.graded);
    const counts = {
      rolls: mine.length - graded.length,
      checks: graded.length,
      passed: graded.filter((die) => die.tone === "crit" || die.tone === "success").length,
      criticals: tones.crit,
    };
    return { name, ...counts, fumbles: tones.fumble, tones, ...scoreOf(counts) };
  });

  const stamps = events.filter((event) => event.kind === "narrative" || event.kind === "dice").map((event) => event.ts);
  return {
    room: input.room,
    system: input.system,
    start: stamps[0] ?? null,
    end: stamps.at(-1) ?? null,
    generatedAt: input.generatedAt,
    players,
    tally,
    dice: dice.slice(-MAX_DICE_ENTRIES),
    lines,
    omitted: all.length - lines.length,
    turns: turns.size,
  };
}
