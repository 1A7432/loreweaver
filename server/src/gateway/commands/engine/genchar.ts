// `genchar` (`生卡`, `生成角色`): a character sheet from a description. A player describes a
// character in words and gets a rule-legal sheet in the room's rule system (or the one they
// name), as their character — the reference server's `.genchar`.
//
// The model reads the description and proposes a concept (`agent/lanes/genchar.ts`: ONE
// call, no re-ask); the engine rolls the sheet and places the numbers by the pack's own data
// (`core/characters/concept.ts`), then makes and seats it exactly as `new_character` does
// (`seatNewCharacter`): validated as a creation, the table told in one line, the caller
// answered with the sheet. The model call happens in `prepare`, and the command does not
// wait for the room's lock (`unlocked`): the room goes on taking input meanwhile, and the
// write is one synchronous step once the answer is in.
//
// A model call any player can trigger at will is capped: `GENCHAR_PER_HOUR` per member and
// room, shared with a player's card import (which calls the same lane). The description is
// the player's text: it reaches the model as delimited data, never as instructions. What the
// model wrote (the occupation, the backstory, notes) is capped by the lane and passes the
// server's word filter before it is stored, as the Keeper's narration does.
import { charCount } from "loreweaver-protocol/v3";

import { type ConceptFailure, type ConceptPersonaInput, proposeConcept } from "../../../agent/lanes/genchar.ts";
import { type CharacterConcept, conceptCharacterSheet, MAX_CHARACTER_NAME_CHARS } from "../../../core/characters/index.ts";
import type { RulePack } from "../../../core/rulepacks/index.ts";
import { liftsOutputFilter, readEnabledSkills, type SkillRegistry } from "../../../core/skills/index.ts";
import type { ModelSettings } from "../../model_settings.ts";
import type { HourlyQuota } from "../../rate_limit.ts";
import { type ReviewFilter, reviewAuthored } from "../../review.ts";
import { MAX_COMMAND_ARG_CHARS, splitBar } from "../parse.ts";
import { compact, object, text } from "../schema.ts";
import { memberIdOf, tableCharacterNames } from "../support.ts";
import { type CommandCall, type CommandSpec, type Done, isRefused, refuse, type Refused } from "../types.ts";
import { seatNewCharacter } from "./checks.ts";
import { sheetItems } from "./sheet.ts";

/** Concept calls one member may make per hour in one room (genchar and character imports together). */
export const GENCHAR_PER_HOUR = 5;
/** A description, in code points. */
export const MAX_GENCHAR_DESCRIPTION_CHARS = 2_000;
const MAX_SYSTEM_CHARS = 64;

/** What `genchar` and a player's card import need to read a concept. */
export interface AuthoringDeps {
  /** The model lanes at run time, to know whether any model is configured; null: assume one is. */
  readonly models: ModelSettings | null;
  /** The hourly cap per member and room. */
  readonly quota: HourlyQuota;
  /** The operator's word filter. */
  readonly review: ReviewFilter;
  /** The skills, to know whether a room lifted the filter. */
  readonly skills: SkillRegistry;
}

/** What reading a concept came to: one, or why there is none. */
export type ConceptRead =
  | { readonly status: "applied"; readonly concept: CharacterConcept; readonly dropped: number }
  | { readonly status: "no_model" | "rate_limited" | ConceptFailure };

/**
 * One concept for `persona` in `pack`'s system: the quota spent, then the lane's one call on
 * the Keeper's client. Never throws for the model's sake.
 */
export async function readConcept(call: CommandCall, deps: AuthoringDeps, pack: RulePack, persona: ConceptPersonaInput, work: string): Promise<ConceptRead> {
  const context = call.context;
  if (deps.models !== null && !deps.models.snapshot().configured) return { status: "no_model" };
  const member = memberIdOf(context) ?? "";
  if (!deps.quota.take(`${context.room}\u0000${member}`, context.services.clock.now())) return { status: "rate_limited" };
  const outcome = await proposeConcept(context.services.models.keeper, { system: pack.id, persona, room: context.room, work });
  if (!outcome.ok) {
    context.services.report(context.room, `${work}: no concept (${outcome.code})`);
    return { status: outcome.code };
  }
  return { status: "applied", concept: outcome.concept, dropped: outcome.dropped };
}

/** The concept's free text through the operator's word filter (lifted in a room with a mature skill). */
export function reviewConcept(call: CommandCall, deps: AuthoringDeps, concept: CharacterConcept): CharacterConcept {
  const context = call.context;
  const room = { unfiltered: liftsOutputFilter(deps.skills, readEnabledSkills(context.services.store, context.room)) };
  const pass = (value: string | null): string | null => (value === null ? null : reviewAuthored(deps.review, room, value, context.locale).text);
  return { ...concept, role: pass(concept.role), backstory: pass(concept.backstory), notes: pass(concept.notes) };
}

interface Prepared {
  readonly pack: RulePack;
  readonly name: string;
  readonly description: string;
  readonly concept: CharacterConcept;
  readonly dropped: number;
}

/** The refusal a concept that could not be read comes to. */
function conceptRefusal(read: Exclude<ConceptRead, { status: "applied" }>): Refused {
  switch (read.status) {
    case "no_model":
      return refuse("genchar_no_model");
    case "rate_limited":
      return refuse("genchar_rate_limited", { limit: GENCHAR_PER_HOUR });
    default:
      return refuse("genchar_failed", { reason: read.status });
  }
}

/**
 * The reference's text form: `genchar [system] [name] | <description>`, or
 * `genchar [system] <description>`. A first word naming an installed rule system selects it.
 */
function parseGencharText(rest: string, call: CommandCall): Record<string, unknown> | Refused {
  const isSystem = (word: string): boolean => word !== "" && call.context.services.packs.resolve(word) !== null;
  const bar = splitBar(rest);
  if (bar !== null) {
    const [head, description] = bar;
    const [first = "", ...others] = head.split(/\s+/u).filter((word) => word !== "");
    const system = isSystem(first) ? first : undefined;
    const name = (system === undefined ? head : others.join(" ")).trim();
    if (description === "") return refuse("usage");
    return compact({ system, name: name === "" ? undefined : name, description });
  }
  const text = rest.trim();
  if (text === "") return refuse("usage");
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(text);
  if (match !== null && isSystem(match[1] as string)) return { system: match[1] as string, description: (match[2] as string).trim() };
  // A rule system's name alone describes nobody.
  if (isSystem(text)) return refuse("usage");
  return { description: text };
}

export function gencharCommand(deps: AuthoringDeps): CommandSpec {
  return {
    id: "genchar",
    source: "engine",
    key: "genchar",
    // The description's own cap is checked by the handler, for a refusal that says so.
    params: object({ description: text(MAX_COMMAND_ARG_CHARS), name: text(MAX_CHARACTER_NAME_CHARS, 1), system: text(MAX_SYSTEM_CHARS, 1) }, ["description"]),
    text: { en: ["genchar"], zh: ["genchar", "生卡", "生成角色"] },
    role: "player",
    unlocked: () => true,
    parseText: parseGencharText,
    async prepare(call, args): Promise<Prepared | Refused> {
      if (call.context.who.member === null) return refuse("no_member");
      const description = (args.description as string).trim();
      if (description === "") return refuse("genchar_empty");
      if (charCount(description) > MAX_GENCHAR_DESCRIPTION_CHARS) return refuse("genchar_too_long", { max: MAX_GENCHAR_DESCRIPTION_CHARS });
      const asked = args.system as string | undefined;
      const pack = asked === undefined ? call.context.pack : call.context.services.packs.resolve(asked);
      if (pack === null) return asked === undefined ? refuse("genchar_no_system") : refuse("unknown_system", { system: asked });
      const name = ((args.name as string | undefined) ?? call.say("character.default_name")).trim();
      // Before the model is asked: a name already at the table would only waste the call.
      if (tableCharacterNames(call, null).has(name.toLowerCase())) return refuse("name_taken", { name });
      // The description stands for the persona's description and personality both, as the
      // reference's `build_sheet_from_description` made it.
      const read = await readConcept(call, deps, pack, { name, description, personality: description, tags: [] }, "genchar");
      if (read.status !== "applied") return conceptRefusal(read);
      return { pack, name, description, concept: read.concept, dropped: read.dropped };
    },
    run(call, _args, prepared): Done | Refused {
      if (isRefused(prepared)) return prepared;
      const { pack, name, description, concept, dropped } = prepared as Prepared;
      const made = conceptCharacterSheet(pack.sheet, pack.source, call.context.random, {
        name,
        system: pack.id,
        persona: { description, personality: description },
        concept: reviewConcept(call, deps, concept),
      });
      const seated = seatNewCharacter(call, pack, made.sheet, made.method);
      if (isRefused(seated)) return seated;
      const sheet = seated.character.sheet;
      const label = pack.sheet.shape?.label ?? pack.id;
      const lines = [call.say("genchar.done", { name: sheet.name, system: label, items: sheetItems(call, pack, sheet) })];
      if (sheet.background !== "") lines.push(call.say("genchar.background", { text: sheet.background }));
      const corrected = seated.violations.filter((violation) => violation.corrected !== null).length;
      if (corrected > 0) lines.push(call.say("sheet.corrected", { count: corrected }));
      for (const violation of seated.violations) {
        if (violation.code === "budget_exceeded") lines.push(call.say("genchar.over_budget", { spent: String(violation.original), limit: String(violation.limit) }));
      }
      return {
        text: lines.join("\n"),
        data: { id: seated.id, name: sheet.name, system: pack.id, method: made.method, violations: seated.violations.map((violation) => violation.code), dropped },
        events: seated.events,
      };
    },
  };
}
