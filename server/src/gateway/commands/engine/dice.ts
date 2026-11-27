// Rolling dice: `roll`, `hidden_roll`, inline `[[expr]]` rolls, and the two table toys
// `jrrp` (the day's luck) and `draw` (a card).
//
// Notation is the dice engine's (`core/dice`): a comparison straight after a dice group
// counts the dice that meet it (`5d10>=7`), a total is compared in parentheses
// (`(5d10)>6`), and `d%` is a d100.
import type { DiceData } from "loreweaver-protocol/v3";

import { DiceError, type DiceExpression, LIMITS, parseDice, renderRoll, type Roll, rollAdvantage, rollDice } from "../../../core/dice/index.ts";
import { SeededRandom } from "../../../core/random.ts";
import { foldCase } from "../../../core/sheets/text.ts";
import { compact, integer, object, oneOf, text } from "../schema.ts";
import { actorName, facesOf, memberIdOf } from "../support.ts";
import { type Args, type CommandCall, type CommandEvent, type CommandSpec, type Done, refuse, type Refused } from "../types.ts";

export const DEFAULT_ROLL = "1d20";
/** The longest notation a roll command takes, in code points: the dice engine's own limit. */
export const MAX_NOTATION_CHARS = LIMITS.maxNotationLength;

/** Words that roll with advantage or disadvantage (game vocabulary: CJK aliases are data). */
export const FAVOR_WORDS: ReadonlySet<string> = new Set(["adv", "advantage", "优势", "優勢"]);
export const DISFAVOR_WORDS: ReadonlySet<string> = new Set(["dis", "disadvantage", "劣势", "劣勢"]);

const REPEAT = /^(\d{1,2})[#＃]\s*([\s\S]*)$/u;

type Mode = "adv" | "dis";

/** `N#rest` → N and the rest; no prefix → null and the whole text. */
export function splitRepeat(text: string): readonly [number | null, string] {
  const match = REPEAT.exec(text.trim());
  if (match === null) return [null, text.trim()];
  return [Number(match[1]), (match[2] as string).trim()];
}

/** An advantage/disadvantage word at the start or end of a roll's text. */
function splitMode(text: string): readonly [Mode | undefined, string] {
  const tokens = text.split(/\s+/u).filter((token) => token !== "");
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  for (const [word, rest] of [
    [first, tokens.slice(1)],
    [last, tokens.slice(0, -1)],
  ] as const) {
    if (word === undefined) continue;
    const folded = foldCase(word);
    if (FAVOR_WORDS.has(folded)) return ["adv", rest.join(" ")];
    if (DISFAVOR_WORDS.has(folded)) return ["dis", rest.join(" ")];
  }
  return [undefined, text];
}

/** The longest reason a roll carries, in code points. */
export const MAX_ROLL_REASON_CHARS = 100;
/** How many leading words are tried as the notation: written with spaces, an expression is still short. */
const MAX_NOTATION_WORDS = 16;

/**
 * `expr reason` → the notation and what the roll is for (the dice-bot habit `.r 3d6 砍门`). The
 * notation is the longest run of leading words the dice engine reads. A text it reads whole has
 * no reason, and one whose first word it cannot read is left whole — the roll then refuses it
 * as bad notation: a mistyped expression is never taken for a reason.
 */
export function splitReason(text: string): readonly [string, string | undefined] {
  const tokens = text.split(/\s+/u).filter((token) => token !== "");
  for (let take = Math.min(tokens.length, MAX_NOTATION_WORDS); take >= 1; take--) {
    const head = tokens.slice(0, take).join(" ");
    try {
      parseDice(head);
    } catch (error) {
      if (error instanceof DiceError) continue;
      throw error;
    }
    const reason = tokens.slice(take).join(" ");
    return [head, reason === "" ? undefined : reason];
  }
  return [text, undefined];
}

function rollArgs(rest: string): Args {
  const [repeat, afterRepeat] = splitRepeat(rest);
  const [wordMode, afterMode] = splitMode(afterRepeat);
  const [expr, said] = splitReason(afterMode);
  // `.r 1d20 adv to hit`: the favour word sits between the notation and the reason.
  const [innerMode, reason] = wordMode === undefined && said !== undefined ? splitLeadingMode(said) : [undefined, said];
  return compact({ expr: expr === "" ? undefined : expr, repeat: repeat ?? undefined, mode: wordMode ?? innerMode, reason: reason === "" ? undefined : reason });
}

function splitLeadingMode(text: string): readonly [Mode | undefined, string] {
  const [first = "", ...rest] = text.split(/\s+/u);
  const folded = foldCase(first);
  if (FAVOR_WORDS.has(folded)) return ["adv", rest.join(" ")];
  if (DISFAVOR_WORDS.has(folded)) return ["dis", rest.join(" ")];
  return [undefined, text];
}

function parseNotation(expr: string): DiceExpression | Refused {
  try {
    return parseDice(expr);
  } catch (error) {
    if (error instanceof DiceError) return refuse("bad_dice", { expr, code: error.code });
    throw error;
  }
}

function diceEvent(call: CommandCall, roll: Roll, extra: Record<string, unknown> = {}, reason?: string): CommandEvent {
  const rendered = renderRoll(roll);
  // What the roll is for leads its line, in the room's punctuation; it is also the event's label.
  const text = reason === undefined ? rendered : call.tell("roll.reasoned", { reason, roll: rendered });
  // `detail.text` is the roll alone, kept where 3.0 clients first read it.
  const data: DiceData = {
    actor: actorName(call.context),
    kind: "roll",
    expr: roll.notation,
    rolls: facesOf(roll),
    total: roll.total,
    ...(reason === undefined ? {} : { label: reason }),
    text,
    detail: { text: rendered, ...extra },
  };
  return { kind: "dice", data };
}

interface Rolled {
  readonly roll: Roll;
  readonly detail: Record<string, unknown>;
}

function rollOnce(call: CommandCall, expression: DiceExpression, mode: Mode | undefined): Rolled {
  if (mode === undefined) return { roll: rollDice(expression, call.context.random), detail: {} };
  const rolled = rollAdvantage(expression, call.context.random, mode === "adv" ? "advantage" : "disadvantage");
  return {
    roll: rolled.kept,
    detail: { mode, candidates: rolled.candidates.map((candidate) => candidate.total), kept: rolled.keptIndex },
  };
}

function rollMany(call: CommandCall, expr: string, times: number, mode: Mode | undefined): Rolled[] | Refused {
  const expression = parseNotation(expr);
  if ("refused" in expression) return expression;
  const out: Rolled[] = [];
  try {
    for (let index = 0; index < times; index++) out.push(rollOnce(call, expression, mode));
  } catch (error) {
    if (error instanceof DiceError) return refuse("bad_dice", { expr, code: error.code });
    throw error;
  }
  return out;
}

const MODE = oneOf(["adv", "dis"]);

export const rollCommand: CommandSpec = {
  id: "roll",
  source: "engine",
  key: "roll",
  params: object({ expr: text(MAX_NOTATION_CHARS, 1), repeat: integer(1, LIMITS.maxRepeat), mode: MODE, reason: text(MAX_ROLL_REASON_CHARS, 1) }),
  text: { en: ["roll", "r"], zh: ["r", "rd"] },
  role: "player",
  parseText: (rest) => rollArgs(rest),
  run(call, args): Done | Refused {
    const expr = (args.expr as string | undefined) ?? DEFAULT_ROLL;
    const rolled = rollMany(call, expr, (args.repeat as number | undefined) ?? 1, args.mode as Mode | undefined);
    if ("refused" in rolled) return rolled;
    return {
      data: { totals: rolled.map((entry) => entry.roll.total) },
      events: rolled.map((entry) => diceEvent(call, entry.roll, entry.detail, args.reason as string | undefined)),
    };
  },
};

export const hiddenRollCommand: CommandSpec = {
  id: "hidden_roll",
  source: "engine",
  key: "hidden_roll",
  params: object({ expr: text(MAX_NOTATION_CHARS, 1), mode: MODE }),
  text: { en: ["rh", "hroll"], zh: ["rh"] },
  role: "player",
  parseText(rest) {
    const [mode, expr] = splitMode(rest);
    return compact({ expr: expr.trim() === "" ? undefined : expr.trim(), mode });
  },
  run(call, args): Done | Refused {
    const rolled = rollMany(call, (args.expr as string | undefined) ?? DEFAULT_ROLL, 1, args.mode as Mode | undefined);
    if ("refused" in rolled) return rolled;
    const [only] = rolled as [Rolled];
    // The answer is the caller's alone: no event, so the table does not learn a roll was made.
    return {
      text: call.say("roll.hidden", { result: renderRoll(only.roll) }),
      data: { expr: only.roll.notation, rolls: facesOf(only.roll), total: only.roll.total, ...only.detail },
    };
  },
};

/** One inline roll of a line of speech: its event, or why it did not roll. */
export type InlineRoll = { readonly ok: true; readonly event: CommandEvent } | { readonly ok: false; readonly expr: string; readonly code: string };

export function rollInline(call: CommandCall, expr: string): InlineRoll {
  const rolled = rollMany(call, expr, 1, undefined);
  if ("refused" in rolled) return { ok: false, expr, code: String(rolled.params?.code ?? "SYNTAX") };
  const [only] = rolled as [Rolled];
  return { ok: true, event: diceEvent(call, only.roll, { inline: true }) };
}

const DAY_MS = 86_400_000;

export const jrrpCommand: CommandSpec = {
  id: "jrrp",
  source: "engine",
  key: "jrrp",
  params: object({}),
  text: { en: ["jrrp", "luck"], zh: ["jrrp"] },
  role: "player",
  parseText: () => ({}),
  run(call): Done | Refused {
    const member = call.context.who.member;
    if (member === null || memberIdOf(call.context) === null) return refuse("no_member");
    // The same number all day for the same person: seeded by who and which day, nothing stored.
    const day = Math.floor(call.context.services.clock.now() / DAY_MS);
    const luck = new SeededRandom(`jrrp:${member.id}:${day}`).nextInt(1, 100);
    return {
      data: { luck },
      events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("jrrp.event", { name: member.name, luck }), format: "plain" } }],
    };
  },
};

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export const drawCommand: CommandSpec = {
  id: "draw",
  source: "engine",
  key: "draw",
  params: object({}),
  text: { en: ["draw"], zh: ["draw", "抽牌"] },
  role: "player",
  parseText: () => ({}),
  run(call): Done {
    const index = call.context.random.nextInt(0, SUITS.length * RANKS.length - 1);
    const card = `${SUITS[Math.floor(index / RANKS.length)] as string}${RANKS[index % RANKS.length] as string}`;
    return {
      data: { card },
      events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("draw.event", { name: actorName(call.context), card }), format: "plain" } }],
    };
  },
};
