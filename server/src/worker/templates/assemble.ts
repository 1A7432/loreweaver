/**
 * `assembleLore`: the whole lore step of one prompt assembly, as one worker exchange.
 *
 * A pure function of its request (both shapes are plain data, safe to structured-clone):
 * every random draw — probability rolls, inclusion-group picks, `{{random}}`, `{{roll}}`
 * and the templates' `Math.random` — comes from `seed`, templates read `Date` as `nowMs`,
 * and a fresh template context is built for this call and dropped after it. The one
 * thing outside the request is wall time: a template that runs past its limit fails with
 * `timeout`, and how far it got is not part of the result.
 *
 * Secrecy is structural here too: for a player-grade request, secret entries are removed
 * before activation (`visibleEntries`) AND left out of the templates' `getwi` library, so
 * no template can read a secret entry's text into a player-grade result.
 */

import {
  type DiceRoller,
  diceRoller,
  type GameClock,
  type InjectedEntry,
  type LoreEntry,
  runLoreStep,
  type TemplateRenderer,
  type TimerState,
  type VariableSnapshot,
  type ViewerGrade,
} from "../../core/worldbook/index.ts";
import { type RandomSource, SeededRandom } from "../../core/random.ts";
import { DEFAULT_LIMITS, type TemplateFailureCode, type TemplateLimits, TemplateSession, type TemplateWrite } from "./session.ts";

export interface LoreAssemblyRequest {
  /** The room's entries in stored order, disabled ones included (they feed `getwi`). */
  readonly entries: readonly LoreEntry[];
  /** Required: who the result is for. */
  readonly viewer: ViewerGrade;
  /** The transcript window, oldest message first. */
  readonly transcript: readonly string[];
  readonly timers: TimerState;
  /** true: this assembly counts a new turn; false: a retry of the counted turn, or a browse. */
  readonly advanceTimers: boolean;
  readonly variables: VariableSnapshot;
  /** Seeds every random draw of the assembly. */
  readonly seed: string;
  /** What `Date.now()` returns inside templates (milliseconds since the epoch). */
  readonly nowMs: number;
  /** Seeds `{{pick}}`: the same seed and text pick the same item (e.g. the room id). */
  readonly pickSeed?: string;
  readonly names?: { readonly user?: string; readonly char?: string };
  readonly clock?: GameClock;
  /** `getchar()` / `getchat()` snapshots. */
  readonly character?: Readonly<Record<string, unknown>>;
  readonly chat?: Readonly<Record<string, unknown>>;
  readonly maxEntries?: number;
  readonly budgetChars?: number;
  readonly includeConstant?: boolean;
  readonly limits?: Partial<TemplateLimits>;
}

export interface TemplateFailure {
  /** Which call of this assembly failed (renders and conditions share one count, from 0). */
  readonly index: number;
  readonly kind: "render" | "condition";
  /** The entry the template belongs to (absent for a condition, which several entries may share). */
  readonly entryId?: string;
  readonly title?: string;
  readonly code: TemplateFailureCode;
  /** The template's own error message, cut to 500 characters: content data, not engine text. */
  readonly detail?: string;
}

export interface LoreAssemblyResult {
  /** The rendered entries joined by line breaks; the section header is the caller's. */
  readonly text: string;
  readonly injected: readonly InjectedEntry[];
  /** Titles activation selected, in final order. */
  readonly activatedTitles: readonly string[];
  /** Every name passed to `activewi()`, in call order. */
  readonly activationRequests: readonly string[];
  /** Entries the `activewi()` pass pulled in. */
  readonly pulledInTitles: readonly string[];
  /** Template variable writes, in call order, for the caller to apply. */
  readonly writes: readonly TemplateWrite[];
  /** Writes dropped for exceeding the per-assembly cap or the size bound. */
  readonly droppedWrites: number;
  readonly timers: TimerState;
  readonly turn: number;
  readonly failures: readonly TemplateFailure[];
  readonly warnings: readonly string[];
}

/** Test and replay seams: what `assembleLore` otherwise derives from `seed`. */
export interface AssemblyOverrides {
  readonly random?: RandomSource;
  readonly roll?: DiceRoller;
}

function templateLibrary(entries: readonly LoreEntry[], viewer: ViewerGrade): Array<[string, string]> {
  return entries.filter((entry) => viewer === "keeper" || !entry.secret).map((entry) => [entry.title, entry.content]);
}

/** The lore step of one prompt assembly. */
export function assembleLore(request: LoreAssemblyRequest): LoreAssemblyResult {
  return assembleLoreWith(request, {});
}

/** `assembleLore` with the random source and dice roller supplied by the caller. */
export function assembleLoreWith(request: LoreAssemblyRequest, overrides: AssemblyOverrides): LoreAssemblyResult {
  const random = overrides.random ?? new SeededRandom(request.seed);
  const session = new TemplateSession(
    {
      flat: request.variables.flat,
      tree: request.variables.tree,
      worldInfo: templateLibrary(request.entries, request.viewer),
      character: request.character ?? {},
      chat: request.chat ?? {},
      seed: `${request.seed}\u0000templates`,
      nowMs: request.nowMs,
    },
    { ...DEFAULT_LIMITS, ...request.limits },
  );
  const failures: TemplateFailure[] = [];
  let calls = 0;
  const renderer: TemplateRenderer = {
    render(content, entry) {
      const index = calls++;
      const outcome = session.render(content);
      if (outcome.ok) return outcome.text;
      failures.push({
        index,
        kind: "render",
        entryId: entry.id,
        title: entry.title,
        code: outcome.code,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
      return null;
    },
    evalCondition(source) {
      const index = calls++;
      const outcome = session.evaluateCondition(source);
      if (outcome.ok) return outcome.value;
      failures.push({ index, kind: "condition", code: outcome.code });
      return null;
    },
    takeActivations: () => session.takeActivations(),
  };

  const step = runLoreStep(
    {
      entries: request.entries,
      viewer: request.viewer,
      transcript: request.transcript,
      timers: request.timers,
      advanceTimers: request.advanceTimers,
      random,
      variables: request.variables,
      roll: overrides.roll ?? diceRoller(random),
      pickSeed: request.pickSeed ?? "",
      ...(request.names === undefined ? {} : { names: request.names }),
      ...(request.clock === undefined ? {} : { clock: request.clock }),
      ...(request.maxEntries === undefined ? {} : { maxEntries: request.maxEntries }),
      ...(request.budgetChars === undefined ? {} : { budgetChars: request.budgetChars }),
      ...(request.includeConstant === undefined ? {} : { includeConstant: request.includeConstant }),
    },
    renderer,
  );

  return {
    text: step.text,
    injected: step.injected,
    activatedTitles: step.activatedTitles,
    activationRequests: step.activationRequests,
    pulledInTitles: step.pulledInTitles,
    writes: [...session.writes],
    droppedWrites: session.droppedWrites,
    timers: step.timers,
    turn: step.turn,
    failures,
    warnings: [...session.warnings],
  };
}
