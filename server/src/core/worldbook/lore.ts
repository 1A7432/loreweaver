/**
 * The whole lore step over one turn: activation, condition evaluation, rendering (the
 * template renderer is supplied by the caller — templates run only in the room worker),
 * macros, frontend scrubbing and the one extra `activewi()` pass.
 *
 * Rendering one entry: content without `<%` or `{{` is used as it is. Content with `<%`
 * goes through the template renderer; a template that fails renders as NOTHING (never as
 * its source). Then the macros, then the status-bar scrub. An entry whose rendered text is
 * empty is selected (it counts in `activatedTitles`) but contributes no text.
 *
 * `activewi(name)` (ST-Prompt-Template): names requested by the templates of the selected
 * entries pull further entries in, by id or title, once each, after the selected ones and
 * subject to the same visibility (enabled, and not secret for a player). One additive
 * pass with no recursion: names requested while rendering a pulled-in entry are reported
 * but not followed. At most `maxEntries` entries are pulled in.
 */

import { compile, ExprError } from "../condexpr.ts";
import type { RandomSource } from "../random.ts";
import { type Activation, activate, DEFAULT_MAX_ENTRIES, MAX_ENTRIES_CEILING } from "./activation.ts";
import { type DiceRoller, type MacroContext, substituteMacros } from "./macros.ts";
import { scrubFrontendTemplates } from "./scrub.ts";
import type { GameClock, LoreEntry, Placement, TimerState, VariableSnapshot, ViewerGrade } from "./types.ts";
import { variableResolver } from "./variables.ts";

/** What the lore step needs from a template engine. */
export interface TemplateRenderer {
  /** Renders `content`; `null` when the template failed. */
  render(content: string, entry: LoreEntry): string | null;
  /** Decides a JavaScript condition; `null` when it could not be evaluated. */
  evalCondition(source: string): boolean | null;
  /** Names passed to `activewi()` since the last call, in call order. */
  takeActivations(): readonly string[];
}

export interface LoreStepInput {
  /** The room's entries in stored order. */
  readonly entries: readonly LoreEntry[];
  readonly viewer: ViewerGrade;
  /** The transcript window, oldest message first. */
  readonly transcript: readonly string[];
  readonly timers: TimerState;
  readonly advanceTimers: boolean;
  readonly random: RandomSource;
  readonly variables: VariableSnapshot;
  readonly names?: { readonly user?: string; readonly char?: string };
  readonly clock?: GameClock;
  readonly pickSeed?: string;
  readonly roll?: DiceRoller;
  readonly maxEntries?: number;
  readonly budgetChars?: number;
  readonly includeConstant?: boolean;
}

export interface InjectedEntry {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly placement: Placement;
  readonly depth: number;
  /** `match`: selected by activation; `activewi`: pulled in by a template. */
  readonly via: "match" | "activewi";
}

export interface LoreStepResult {
  /** Non-empty rendered entries, in prompt order. */
  readonly injected: readonly InjectedEntry[];
  /** The rendered entries joined by line breaks (no header: that is the caller's). */
  readonly text: string;
  /** Titles activation selected, in final order. */
  readonly activatedTitles: readonly string[];
  /** Every name passed to `activewi()`, in call order. */
  readonly activationRequests: readonly string[];
  /** Titles of the entries the `activewi()` pass pulled in. */
  readonly pulledInTitles: readonly string[];
  readonly timers: TimerState;
  readonly turn: number;
}

/**
 * An entry's condition: the closed condition language first; a condition it cannot read
 * (or cannot evaluate) goes to the template engine as JavaScript; anything else fails
 * closed.
 */
function conditionJudge(variables: VariableSnapshot, renderer: TemplateRenderer): (condition: string) => boolean {
  const resolve = variableResolver(variables);
  return (condition) => {
    try {
      return compile(condition).test(resolve);
    } catch (error) {
      if (!(error instanceof ExprError)) return false;
    }
    return renderer.evalCondition(condition) ?? false;
  };
}

function renderEntry(entry: LoreEntry, renderer: TemplateRenderer, macros: MacroContext): string {
  const content = entry.content;
  if (!content.includes("<%") && !content.includes("{{")) return content;
  let text = content;
  if (content.includes("<%")) {
    const rendered = renderer.render(content, entry);
    if (rendered === null) return "";
    text = rendered;
  }
  return scrubFrontendTemplates(substituteMacros(text, macros));
}

/** Runs the lore step. Pure given a pure renderer. */
export function runLoreStep(input: LoreStepInput, renderer: TemplateRenderer): LoreStepResult {
  const activation: Activation = activate({
    entries: input.entries,
    viewer: input.viewer,
    transcript: input.transcript,
    timers: input.timers,
    advanceTimers: input.advanceTimers,
    random: input.random,
    ...(input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries }),
    ...(input.budgetChars === undefined ? {} : { budgetChars: input.budgetChars }),
    ...(input.includeConstant === undefined ? {} : { includeConstant: input.includeConstant }),
    conditionHolds: conditionJudge(input.variables, renderer),
  });
  const macros: MacroContext = {
    variables: input.variables,
    random: input.random,
    ...(input.names === undefined ? {} : { names: input.names }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.pickSeed === undefined ? {} : { pickSeed: input.pickSeed }),
    ...(input.roll === undefined ? {} : { roll: input.roll }),
  };

  const injected: InjectedEntry[] = [];
  const add = (entry: LoreEntry, via: InjectedEntry["via"]): void => {
    const text = renderEntry(entry, renderer, macros);
    if (text !== "") injected.push({ id: entry.id, title: entry.title, text, placement: entry.placement, depth: entry.depth, via });
  };
  for (const entry of activation.selected) add(entry, "match");

  const requests = [...renderer.takeActivations()];
  const seen = new Set<string>();
  for (const entry of activation.selected) {
    seen.add(entry.title);
    seen.add(entry.id);
  }
  const pulledIn: string[] = [];
  const maxPulled = Math.min(MAX_ENTRIES_CEILING, Math.max(0, Math.trunc(input.maxEntries ?? DEFAULT_MAX_ENTRIES)));
  for (const name of [...requests]) {
    if (pulledIn.length >= maxPulled) break;
    if (seen.has(name)) continue;
    seen.add(name);
    const extra = activation.visible.find((entry) => entry.id === name || entry.title === name);
    if (extra === undefined) continue;
    pulledIn.push(extra.title);
    add(extra, "activewi");
  }
  requests.push(...renderer.takeActivations());

  return {
    injected,
    text: injected.map((entry) => entry.text).join("\n"),
    activatedTitles: activation.selected.map((entry) => entry.title),
    activationRequests: requests,
    pulledInTitles: pulledIn,
    timers: activation.timers,
    turn: activation.turn,
  };
}
