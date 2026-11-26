// End-of-turn structural checks: the table, the conditions, and the runner (ported from
// the 2.6 `agent/turn_checks.py` and `_run_turn_checks` in `agent/loop.py`).
//
// After the Keeper answers, a row may refuse to let the turn end and feed the reason back
// (Stop form); the model corrects itself. Conditions look only at STRUCTURE — which tools
// ran, what the dice produced, numbers and headings in the text — never at the story:
// whether a moment deserved a roll needs the fiction read, and that is the Scribe's.
//
// - `narration_lost`: a tool round of this turn carried narration-sized text (a tool
//   round's text never reaches the table) and the final reply is under half of it.
// - `dice_forged`: the reply states a roll in one of the shapes the dice frames render,
//   and no dice tool ran. Shape detection, so a written-down tolerance band: ordinary prose
//   has numbers in it (`test/agent/turn/checks.test.ts` lists the accepted false positives).
// - `dice_contradicts`: dice ran and a number the reply presents AS a roll is not one the
//   turn produced. Exact, CJK numerals included.
// - `stale_scene_hud`: the reply drew a scene/time heading and the turn did not set the
//   scene (`kp_note`) and the clock (`game_clock` — or, when a module owns the room's clock,
//   any `run_command`, since the module's own command is the clock bookkeeping there).
//
// The runner never changes `tools` or `tool_choice` (it does not even see them: `ask`
// sends what the main loop sent): the checks run when the prefix is largest, and changing
// either invalidates the provider's cache beneath it.
//
// Python's `re` is Unicode-aware where JavaScript's is not: `\w`, `\b` and `\d` match
// letters and digits of every script there. The patterns below spell that out (`NOT_WORD_BEFORE`/
// `NOT_WORD_AFTER`, `\p{Nd}`) so a CJK character next to a number is a word
// character, exactly as the reference read it.
import type { DiceData } from "loreweaver-protocol/v3";

import { estimateTokens } from "../../core/chronicle/index.ts";
import type { RulePack } from "../../core/rulepacks/index.ts";
import type { ChatMessage, Usage } from "../../infra/llm/types.ts";
import { turnText } from "./catalog.ts";
import { accumulateUsage, EMPTY_TURN_USAGE, type TurnUsage } from "./usage.ts";

// ---------------------------------------------------------------------------
// Round budget
// ---------------------------------------------------------------------------

/** No row asks more than this many times, whatever a rule pack says. */
export const MAX_ROUNDS_PER_CHECK = 3;
/** Check rounds per turn, all rows together: the per-turn model-call budget counts 5. */
export const MAX_ROUNDS_PER_TURN = 5;

/** The engine's own dice tools; a rule pack's subsystem tools join them. */
export const BASE_DICE_TOOL_NAMES: readonly string[] = Object.freeze(["skill_check", "roll_dice"]);

/** The tool that runs a module's command — the clock bookkeeping when a module owns the clock. */
export const MODULE_COMMAND_TOOL = "run_command";

/** The dice tool names for a room: the engine's two plus the rule pack's subsystem tools. */
export function diceToolNames(subsystemToolNames: Iterable<string> = []): ReadonlySet<string> {
  return new Set([...BASE_DICE_TOOL_NAMES, ...subsystemToolNames]);
}

// ---------------------------------------------------------------------------
// What a condition reads
// ---------------------------------------------------------------------------

/** One tool call of this turn, as the checks see it. */
export interface TurnToolCall {
  readonly name: string;
  /** The decoded arguments; null when the model's arguments were not a JSON object. */
  readonly args: Readonly<Record<string, unknown>> | null;
  /** Vetoed by a module, or refused / failed by the tool: the call did nothing. */
  readonly suppressed: boolean;
  /** The dice the call put in front of the table, in order. */
  readonly dice: readonly DiceData[];
}

/**
 * What a condition may look at: the reply as written and what the turn really did.
 * Deliberately not the player's line — a condition reading it would be guessing intent.
 */
export interface TurnState {
  readonly reply: string;
  /** Every call of the turn so far, in call order. */
  readonly calls: readonly TurnToolCall[];
  /**
   * The text each tool round came back with, in order ("" for none). Never shown, never
   * persisted, never in a trace that leaves the engine.
   */
  readonly toolRoundTexts: readonly string[];
  /** `diceToolNames(...)` for this room. */
  readonly diceTools: ReadonlySet<string>;
  /** A module owns the room's clock: its `run_command` counts as clock bookkeeping. */
  readonly moduleOwnsClock: boolean;
}

/** True if a dice tool ran this turn and was not suppressed. */
export function diceRolled(state: Pick<TurnState, "calls" | "diceTools">): boolean {
  return state.calls.some((call) => state.diceTools.has(call.name) && !call.suppressed);
}

// ---------------------------------------------------------------------------
// Numbers: what the dice produced, and what the prose claims they did
// ---------------------------------------------------------------------------

// Python `\b` next to a `\w` character: `\w` is a letter or digit of any script, or `_`.
const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;
const DIGIT = String.raw`\p{Nd}`;

const CJK_DIGITS = new Map<string, number>([
  ["零", 0],
  ["〇", 0],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
]);
const CJK_UNITS = new Map<string, number>([
  ["十", 10],
  ["百", 100],
]);
const CJK_NUMERAL = "[零〇一二两三四五六七八九十百]";
const CJK_NUMBER_RE = new RegExp(`${CJK_NUMERAL}+`, "gu");

/**
 * A CJK numeral in the range dice produce (0–999), else null. Deliberately small: a
 * check's total, target and faces are two or three digits, so 十/百 and the digits cover
 * every rolled number; anything larger is prose.
 */
export function cjkToInt(text: string): number | null {
  let total = 0;
  let section = 0;
  let seen = false;
  for (const character of text) {
    const digit = CJK_DIGITS.get(character);
    if (digit !== undefined) {
      section = digit;
      seen = true;
      continue;
    }
    const unit = CJK_UNITS.get(character);
    if (unit === undefined) return null;
    // "十五" is 15, "三十五" is 35 — a bare unit carries an implicit one.
    total += (section || 1) * unit;
    section = 0;
    seen = true;
  }
  if (!seen) return null;
  const value = total + section;
  return value >= 0 && value <= 999 ? value : null;
}

const ND_RE = /\p{Nd}/u;

/** A run of decimal digits of any script as an integer (Python's `int()` on a `\d` match). */
function digitsToInt(text: string): number {
  let value = 0;
  for (const character of text) {
    // Unicode lays every script's digits out as consecutive runs of ten, zero first.
    let code = character.codePointAt(0) ?? 0;
    let offset = 0;
    while (code > 0 && ND_RE.test(String.fromCodePoint(code - 1))) {
      code--;
      offset++;
    }
    value = value * 10 + (offset % 10);
  }
  return value;
}

const ARABIC_NUMBER_RE = new RegExp(`${DIGIT}{1,4}`, "gu");

/** Every number `text` states, Arabic or CJK. */
function numbersIn(text: string): Set<number> {
  const values = new Set<number>();
  for (const match of text.matchAll(ARABIC_NUMBER_RE)) values.add(digitsToInt(match[0]));
  for (const match of text.matchAll(CJK_NUMBER_RE)) {
    const parsed = cjkToInt(match[0]);
    if (parsed !== null) values.add(parsed);
  }
  return values;
}

// The SHAPES a stated dice result takes in prose — each what the real dice frames render:
//   - a roll-vs-target pair: "22 vs 25", "47 versus 65", "22 对 25";
//   - a d-notation total: "1d100 = 47", "2d6+1 -> 9".
// A bare "22/25" is deliberately NOT one: prose has ratios and scores ("50/50").
const ROLL_VS_TARGET_RE = new RegExp(
  `${NOT_WORD_BEFORE}(${DIGIT}{1,3})\\s*(?:vs\\.?|versus|對|对)\\s*(${DIGIT}{1,3})${NOT_WORD_AFTER}`,
  "giu",
);
const ROLL_TOTAL_RE = new RegExp(
  `${NOT_WORD_BEFORE}${DIGIT}{0,3}d${DIGIT}{1,3}(?:\\s*[+-]\\s*${DIGIT}{1,3})?\\s*(?:=|＝|->|→|:|：)\\s*(${DIGIT}{1,4})${NOT_WORD_AFTER}`,
  "giu",
);
// A die emoji next to a result word is the other shape: "🎲 **Intimidate — Fumble.**" with
// the numbers left out. 🎲 essentially never appears in narration, which is what lets the
// bare result words be trusted here and nowhere else.
const ROLL_MARKUP_RE = new RegExp(
  `🎲[^\\n]{0,80}?(?:fumble|success|failure|${NOT_WORD_BEFORE}fail(?:s|ed)?${NOT_WORD_AFTER}|成功|失败|失敗)`,
  "iu",
);
// The CJK form of a stated roll, where the number may be written out: "掷出三十七".
const CJK_ROLL_RE = new RegExp(`(?:掷出|投出|骰出|roll(?:ed|s)?)\\s*[:：]?\\s*(${CJK_NUMERAL}+|${DIGIT}{1,3})`, "giu");

function has(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}

/**
 * True if `reply` states a dice result in a shape the frames render. Purely structural:
 * not a judgement of whether the moment warranted a check.
 */
export function replyStatesARoll(reply: string): boolean {
  if (reply === "") return false;
  return has(ROLL_VS_TARGET_RE, reply) || has(ROLL_TOTAL_RE, reply) || has(ROLL_MARKUP_RE, reply) || has(CJK_ROLL_RE, reply);
}

/**
 * The numbers `reply` presents AS a roll result — only inside the roll-shaped spans, so a
 * street number, a year or a count of coins never reads as a contradicted die.
 */
export function statedRollNumbers(reply: string): Set<number> {
  const values = new Set<number>();
  for (const match of reply.matchAll(ROLL_VS_TARGET_RE)) {
    values.add(digitsToInt(match[1] ?? ""));
    values.add(digitsToInt(match[2] ?? ""));
  }
  for (const match of reply.matchAll(ROLL_TOTAL_RE)) values.add(digitsToInt(match[1] ?? ""));
  for (const match of reply.matchAll(CJK_ROLL_RE)) for (const value of numbersIn(match[1] ?? "")) values.add(value);
  return values;
}

/**
 * Every number this turn's dice produced — totals, targets, effective targets and faces —
 * read from the same `dice` payloads the table's frames are drawn from.
 */
export function rolledValues(calls: readonly TurnToolCall[]): Set<number> {
  const values = new Set<number>();
  for (const call of calls) {
    for (const dice of call.dice) {
      for (const number of [dice.total, dice.target, dice.effectiveTarget]) if (Number.isInteger(number)) values.add(number as number);
      for (const face of dice.rolls) if (Number.isInteger(face)) values.add(face);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// The scene heading
// ---------------------------------------------------------------------------

// A self-drawn scene card: a short title-like line with a separator AND an explicit time
// marker ("🌉 東京港·大井埠頭五号泊位 | 晚 10:15"). Prose may mention places and times freely.
const SCENE_TITLE_TIME_RE = new RegExp(
  `(?:${NOT_WORD_BEFORE}${DIGIT}{1,2}[:：]${DIGIT}{2}${NOT_WORD_AFTER}|${NOT_WORD_BEFORE}${DIGIT}{1,2}\\s*(?:am|pm)${NOT_WORD_AFTER}|上午|下午|早上|清晨|凌晨|` +
    "傍晚|黄昏|晚上|晚间|夜里|深夜|午夜|正午|morning|afternoon|evening|night|midnight|dawn|dusk|noon)",
  "iu",
);
// Python's `str.splitlines()` boundaries.
const LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
const TITLE_EDGE_CHARS = new Set([" ", "-", ":", "：", "[", "]", "【", "】"]);

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Python's `str.strip(chars)` for a set of single characters. */
function stripChars(text: string, chars: ReadonlySet<string>): string {
  const characters = Array.from(text);
  let start = 0;
  let end = characters.length;
  while (start < end && chars.has(characters[start] ?? "")) start++;
  while (end > start && chars.has(characters[end - 1] ?? "")) end--;
  return characters.slice(start, end).join("");
}

/** The self-drawn scene/time title lines of `reply`. */
export function sceneTitleLines(reply: string): string[] {
  const lines: string[] = [];
  for (const raw of reply.split(LINE_BREAK_RE)) {
    let line = raw.trim();
    if (line === "") continue;
    while (line.startsWith("#")) line = line.slice(1).trimStart();
    const length = codePointLength(line);
    if (length < 6 || length > 140) continue;
    if (!line.includes("|") && !line.includes("｜")) continue;
    if (!SCENE_TITLE_TIME_RE.test(line)) continue;
    const left = stripChars(line.split(/[|｜]/u, 1)[0] ?? "", TITLE_EDGE_CHARS);
    if (left !== "") lines.push(line);
  }
  return lines;
}

const SCENE_CATEGORIES = new Set(["current_scene", "current_focus"]);
const CLOCK_ACTIONS = new Set(["set", "advance"]);

/** True if this turn set both the scene/focus and the clock the HUD reads. */
export function stateBookkeepingDone(state: Pick<TurnState, "calls" | "moduleOwnsClock">): boolean {
  let scene = false;
  let clock = false;
  for (const call of state.calls) {
    const args = call.args ?? {};
    if (call.name === "kp_note" && args.action === "set" && typeof args.category === "string" && SCENE_CATEGORIES.has(args.category)) scene = true;
    if (call.name === "game_clock" && typeof args.action === "string" && CLOCK_ACTIONS.has(args.action)) clock = true;
    if (state.moduleOwnsClock && call.name === MODULE_COMMAND_TOOL && !call.suppressed) clock = true;
  }
  return scene && clock;
}

// ---------------------------------------------------------------------------
// Lost narration
// ---------------------------------------------------------------------------

// Sizes are `estimateTokens` (a CJK character ~1 token, Latin prose ~4 characters a
// token), so one threshold is the same amount of prose in either language. A tool round's
// text is narration-sized from here (~600 characters of English, ~150 of Chinese)...
export const LOST_NARRATION_MIN_TOKENS = 150;
// ...and the final reply has dropped it when it is under this fraction of that round.
export const LOST_NARRATION_KEPT_FRACTION = 0.5;

/** The non-empty text this turn's tool rounds carried, trimmed, in order. */
export function interimTexts(state: Pick<TurnState, "toolRoundTexts">): string[] {
  return state.toolRoundTexts.map((text) => text.trim()).filter((text) => text !== "");
}

// ---------------------------------------------------------------------------
// The conditions and the table
// ---------------------------------------------------------------------------

export type CheckCondition = "narration_lost" | "dice_forged" | "dice_contradicts" | "stale_scene_hud";

function narrationLost(state: TurnState): boolean {
  let longest = 0;
  for (const text of interimTexts(state)) longest = Math.max(longest, estimateTokens(text));
  if (longest < LOST_NARRATION_MIN_TOKENS) return false;
  return estimateTokens(state.reply.trim()) < longest * LOST_NARRATION_KEPT_FRACTION;
}

function diceForged(state: TurnState): boolean {
  return replyStatesARoll(state.reply) && !diceRolled(state);
}

function diceContradicts(state: TurnState): boolean {
  if (!diceRolled(state)) return false;
  const stated = statedRollNumbers(state.reply);
  if (stated.size === 0) return false;
  const real = rolledValues(state.calls);
  // A dice tool ran but published nothing: there is nothing exact to compare against.
  if (real.size === 0) return false;
  for (const value of stated) if (!real.has(value)) return true;
  return false;
}

function staleSceneHud(state: TurnState): boolean {
  return sceneTitleLines(state.reply).length > 0 && !stateBookkeepingDone(state);
}

/**
 * The whole condition vocabulary. Conditions are code; a rule pack chooses among them,
 * rewords, reorders and shortens — it never authors one.
 */
export const CONDITIONS: ReadonlyMap<CheckCondition, (state: TurnState) => boolean> = new Map<CheckCondition, (state: TurnState) => boolean>([
  ["dice_forged", diceForged],
  ["dice_contradicts", diceContradicts],
  ["stale_scene_hud", staleSceneHud],
  ["narration_lost", narrationLost],
]);

function isCondition(name: string): name is CheckCondition {
  return CONDITIONS.has(name as CheckCondition);
}

/** One row of the end-of-turn table. */
export interface TurnCheckRow {
  readonly id: string;
  readonly condition: CheckCondition;
  /** The engine's instruction (a `turn.json` key). */
  readonly instructionKey: string;
  /** A rule pack's own wording by language; wins over the engine's. */
  readonly instructionText: ReadonlyMap<string, string>;
  readonly maxRounds: number;
}

const NO_TEXT: ReadonlyMap<string, string> = new Map();

function row(condition: CheckCondition, maxRounds: number): TurnCheckRow {
  return Object.freeze({ id: condition, condition, instructionKey: `loop.check.${condition}`, instructionText: NO_TEXT, maxRounds });
}

/**
 * The engine's table. Order is part of it: each row is verified once, top to bottom, so the
 * row that REPLACES the whole reply (`narration_lost`) goes first and the dice and heading
 * rows read its result. The caps sum past `MAX_ROUNDS_PER_TURN` (6 > 5); the turn-wide cap
 * is the hard stop, which is why `stale_scene_hud` — the cheapest to lose — is last.
 */
export const DEFAULT_TURN_CHECKS: readonly TurnCheckRow[] = Object.freeze([
  row("narration_lost", 1),
  row("dice_forged", 2),
  row("dice_contradicts", 1),
  row("stale_scene_hud", 2),
]);

/** Whether `row` holds for `state`. */
export function checkHolds(check: TurnCheckRow, state: TurnState): boolean {
  return CONDITIONS.get(check.condition)?.(state) ?? false;
}

function fill(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? (params[name] ?? whole) : whole));
}

/** The text fed back to the model: a pack's own wording in the room's language, else the engine's. */
export function checkInstruction(check: TurnCheckRow, locale: string, fields: Readonly<Record<string, string>>): string {
  const language = (locale.replaceAll("_", "-").split("-")[0] ?? "").toLowerCase();
  const own = check.instructionText.get(language) ?? check.instructionText.get("en");
  if (own !== undefined) return fill(own, fields);
  return turnText(locale, check.instructionKey, fields);
}

/**
 * The substitutions for an instruction, by CONDITION (a pack may give a row any id): only
 * what the model cannot see — the real numbers it contradicted, the heading it drew, and
 * the text its tool rounds carried (the check conversation drops tool rounds).
 */
export function checkFields(condition: CheckCondition, state: TurnState): Record<string, string> {
  if (condition === "dice_contradicts") {
    return { rolled: [...rolledValues(state.calls)].sort((a, b) => a - b).join(", ") };
  }
  if (condition === "stale_scene_hud") {
    const titles = sceneTitleLines(state.reply);
    return { title: titles[0] ?? Array.from(state.reply).slice(0, 160).join("") };
  }
  if (condition === "narration_lost") return { earlier: interimTexts(state).join("\n\n") };
  return {};
}

const DEFAULT_BY_CONDITION = new Map(DEFAULT_TURN_CHECKS.map((check) => [check.condition, check]));

/**
 * This room's table: the pack's when it declares one, else the engine's. A pack may reword
 * a row, reorder rows, drop or disable one, and shorten a row's cap — it may only TIGHTEN:
 * a row's cap never exceeds the engine's cap for that condition (nor
 * `MAX_ROUNDS_PER_CHECK`), a condition appears at most once (the first row naming it
 * decides), and a condition the engine does not implement is skipped rather than failing
 * the room. A pack table that leaves a condition out drops it.
 */
export function turnChecksFor(pack: Pick<RulePack, "turnChecks"> | null): readonly TurnCheckRow[] {
  const declared = pack?.turnChecks ?? [];
  if (declared.length === 0) return DEFAULT_TURN_CHECKS;
  const table: TurnCheckRow[] = [];
  const seen = new Set<string>();
  for (const declaredRow of declared) {
    const condition = declaredRow.condition.trim();
    if (!isCondition(condition)) continue;
    if (seen.has(condition)) continue;
    seen.add(condition);
    if (!declaredRow.enabled) continue;
    const engine = DEFAULT_BY_CONDITION.get(condition);
    if (engine === undefined) continue;
    const asked = declaredRow.maxRounds ?? engine.maxRounds;
    const text = new Map<string, string>();
    for (const [language, value] of declaredRow.instruction) if (value.trim() !== "") text.set(language, value);
    table.push(
      Object.freeze({
        id: declaredRow.id || condition,
        condition,
        instructionKey: engine.instructionKey,
        instructionText: text,
        maxRounds: Math.max(1, Math.min(asked, engine.maxRounds, MAX_ROUNDS_PER_CHECK)),
      }),
    );
  }
  return Object.freeze(table);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * The conversation a check round continues: the turn's messages without this turn's tool
 * rounds (tool results and the assistant messages that called tools). Everything else —
 * the cached head and the history, cache marks included — is kept as it is, so a re-ask
 * reads the prefix the main loop already paid for.
 */
export function correctionBaseMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== "tool" && !(message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0));
}

/** What one check round came back with, as the engine reports it. */
export type CheckAskOutcome =
  /** The model answered in text. */
  | { readonly kind: "reply"; readonly content: string; readonly usage?: Usage }
  /**
   * The model called tools, and the engine ran them (through the module veto, like any
   * round). `messages` continue the conversation: the assistant message that called them,
   * then each result. `calls` are those calls as the checks see them.
   */
  | {
      readonly kind: "tools";
      readonly content: string;
      readonly messages: readonly ChatMessage[];
      readonly calls: readonly TurnToolCall[];
      readonly usage?: Usage;
    }
  /** The provider call failed: the checks stop and the reply stands as it is. */
  | { readonly kind: "failed" };

/**
 * One model round, supplied by the engine: send `messages` with the turn's own tools and
 * tool choice (unchanged), not streamed, run any tool calls, and report. `check` is the
 * asking row's id, for the operator's trace. Anything it THROWS (an abort, a stale room)
 * propagates out of `runTurnChecks`.
 */
export type CheckAsk = (messages: readonly ChatMessage[], meta: { readonly check: string }) => Promise<CheckAskOutcome>;

export interface TurnChecksInput {
  readonly checks: readonly TurnCheckRow[];
  /** The turn as it stands after the main loop. */
  readonly state: TurnState;
  /** The main loop's conversation. */
  readonly messages: readonly ChatMessage[];
  readonly locale: string;
  readonly ask: CheckAsk;
}

export interface TurnChecksResult {
  /** The reply to publish. */
  readonly reply: string;
  /** The turn's calls, the main loop's followed by any a check round made. */
  readonly calls: readonly TurnToolCall[];
  /** The asking row's id for each check round, in order (its length is the rounds spent). */
  readonly asked: readonly string[];
  /** Usage of the check rounds alone — never folded into the turn's headline usage. */
  readonly usage: TurnUsage;
  /** A provider failure ended the checks early. */
  readonly failed: boolean;
}

/**
 * Run the table in Stop form. Each row is verified; while it holds, its instruction is
 * sent and the condition is RE-VERIFIED on the new reply, up to the row's cap. A tool
 * round is not the end: when the model answers by calling tools, the row keeps going for
 * the narration that reads the result — and when that tool round was the row's last
 * allowed round, it gets exactly ONE round more (re-sending its instruction with the
 * results in view), never more, so one row cannot spend the rounds the rows after it are
 * owed. `MAX_ROUNDS_PER_TURN` bounds everything. A provider failure keeps the reply.
 */
export async function runTurnChecks(input: TurnChecksInput): Promise<TurnChecksResult> {
  let convo: ChatMessage[] = correctionBaseMessages(input.messages);
  let reply = input.state.reply;
  let calls = [...input.state.calls];
  // A check round that calls tools is a tool round too: its text is not shown either.
  const roundTexts = [...input.state.toolRoundTexts];
  const asked: string[] = [];
  let usage = EMPTY_TURN_USAGE;
  const result = (failed: boolean): TurnChecksResult => ({ reply, calls, asked, usage, failed });

  for (const check of input.checks) {
    let awaitingNarration = false;
    let rounds = 0;
    while (rounds < check.maxRounds || (awaitingNarration && rounds === check.maxRounds)) {
      if (asked.length >= MAX_ROUNDS_PER_TURN) return result(false);
      const state: TurnState = { ...input.state, reply, calls, toolRoundTexts: roundTexts };
      if (!awaitingNarration && !checkHolds(check, state)) break;
      const instruction = checkInstruction(check, input.locale, checkFields(check.condition, state));
      convo = [...convo, { role: "assistant", content: reply }, { role: "user", content: instruction }];
      const outcome = await input.ask(convo, { check: check.id });
      if (outcome.kind === "failed") return result(true);
      asked.push(check.id);
      rounds++;
      usage = accumulateUsage(usage, outcome.usage);
      if (outcome.kind === "tools") {
        roundTexts.push(outcome.content);
        convo = [...convo, ...outcome.messages];
        calls = [...calls, ...outcome.calls];
        awaitingNarration = true;
        continue;
      }
      reply = outcome.content || reply;
      awaitingNarration = false;
    }
  }
  return result(false);
}
