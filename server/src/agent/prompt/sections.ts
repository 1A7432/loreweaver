// The sections of the Keeper's prompt, one small pure function each, in prompt order.
// Each returns its text, or "" when it has nothing to say (and then no header either).
// The joining rules inside a section are the 2.6 builders' (`core/prompt_sections.py`,
// `agent/prompt_builder.py`, `agent/chronicle.py`), byte for byte, so the carried-over
// text reads exactly as it was tuned.
import type { CampaignSummary, ChronicleRecord, PlotThread } from "../../core/chronicle/index.ts";
import type { GameClockTableView, InitiativeView } from "../../core/clock/index.ts";
import { habitIndex, type TableHabits } from "../../core/habits/index.ts";
import { type SetupItem, setupLabel } from "../../core/lore/index.ts";
import { type KeeperNotes, notesIn, type SceneView } from "../../core/notes/index.ts";
import { changedRelationships, RELATIONSHIP_TRACKS, type Relationships } from "../../core/relationships/index.ts";
import { expertiseText, type RulePack } from "../../core/rulepacks/index.ts";
import { flattenLeaves, labelFor, type Leaf, type ModuleVariables, type VarMap } from "../../core/variables/index.ts";
import { promptText } from "./catalog.ts";
import type { CardDirectives, ModuleCommandLine, PartyMember, PlayerAction } from "./snapshot.ts";

/** Variable-tree leaves shown per turn (a prompt-budget bound, as in 2.6). */
export const MAX_PROMPT_LEAVES = 100;
/** Open threads shown per turn. */
export const MAX_PROMPT_THREADS = 12;
/** Characters of recalled records per turn; the weakest hits are the ones left out. */
export const RECALL_BUDGET_CHARS = 6_000;
/** Keeper-note entries the state panel shows per category. */
export const STATE_NPC_NOTES = 3;
export const STATE_WORLD_CHANGES = 3;
/** Established facts the state panel shows (background and the rest, each). */
export const STATE_FACTS = 5;
/** Combatants the state panel lists, from the acting one on. */
export const STATE_INITIATIVE_ROWS = 5;

/** The keeper-notes categories the state panel reads (the notebook's own conventions). */
export const NPC_STATUS_CATEGORY = "npc_status";
export const WORLD_CHANGES_CATEGORY = "world_changes";
/**
 * An established fact stamped with this instead of a clock time is the opening briefing's
 * background (2.6 data convention, kept as data — not text anyone reads).
 */
export const OPENING_FACT_TAG = "开局";

const ACTING_MARKER = " \u{1F448}";

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function lastN<T>(items: readonly T[], count: number): readonly T[] {
  return items.slice(Math.max(0, items.length - count));
}

// ---------------------------------------------------------------------------
// The stable head
// ---------------------------------------------------------------------------

/** 1. Who the Keeper is and the table's hard constraints. Always present. */
export function identitySection(locale: string): string {
  return [
    promptText(locale, "prompt.system.intro"),
    "",
    promptText(locale, "prompt.system.guidelines_header"),
    promptText(locale, "prompt.system.guidelines"),
  ].join("\n");
}

/** 2. The rule system's own keeper expertise, or the generic text. Always present. */
export function expertiseSection(locale: string, pack: RulePack | null): string {
  const text = pack === null ? "" : expertiseText(pack, locale);
  return text !== "" ? text : promptText(locale, "prompt.expertise.generic");
}

/** 3. Voice, the dice contract and freshness. Always present. */
export function styleSection(locale: string): string {
  return [
    promptText(locale, "prompt.style.narrative"),
    "",
    promptText(locale, "prompt.style.roll_policy"),
    "",
    promptText(locale, "prompt.style.freshness"),
  ].join("\n");
}

/** 6. The imported world card's standing directives (head band). */
export function cardHeadSection(locale: string, directives: CardDirectives | null): string {
  if (directives === null || directives.head === "") return "";
  return promptText(locale, "prompt.card_directives_header") + "\n\n" + directives.head;
}

/** 7. The enabled skills' bodies. */
export function skillsSection(locale: string, skills: readonly string[]): string {
  if (skills.length === 0) return "";
  return promptText(locale, "prompt.skills_header") + "\n\n" + skills.join("\n\n");
}

/** 7b (new in 3.0). The module commands the Keeper reaches through `run_command`. */
export function moduleCommandsSection(locale: string, commands: readonly ModuleCommandLine[]): string {
  if (commands.length === 0) return "";
  const lines = commands.map((command) =>
    command.summary === "" ? `- ${command.id}` : promptText(locale, "prompt.command_line", { id: command.id, summary: command.summary }),
  );
  return promptText(locale, "prompt.commands_header") + "\n" + lines.join("\n");
}

/** The summary part of the chronicle (label, text, keeper margin); "" when there is none. */
function summaryBody(locale: string, summary: CampaignSummary | null): string {
  const text = summary?.text.trim() ?? "";
  if (summary === null || text === "") return "";
  let body = promptText(locale, "prompt.chronicle.summary_label") + "\n" + text;
  const margin = summary.keeper.trim();
  if (margin !== "") body += "\n" + promptText(locale, "prompt.chronicle.keeper_label") + " " + margin;
  return body;
}

/**
 * 8. The campaign summary, led by the chronicle header. It changes only when a fold
 * writes it — and that fold also stops replaying the turns it covers, so the cached
 * prefix was lost that turn anyway.
 */
export function chronicleHeadSection(locale: string, summary: CampaignSummary | null): string {
  const body = summaryBody(locale, summary);
  if (body === "") return "";
  return promptText(locale, "prompt.chronicle.header") + "\n\n" + body;
}

// ---------------------------------------------------------------------------
// The volatile tail
// ---------------------------------------------------------------------------

/**
 * 11. This turn's lore. In a room with an imported world, the keeper-discipline and
 * module-fidelity blocks lead it — only there, and only when there is lore to govern:
 * a free room whose admin added a few setting notes gets plain lore.
 */
export function loreSection(locale: string, lore: string, worldImported: boolean): string {
  if (lore === "") return "";
  const section = [promptText(locale, "worldbook.section.title"), promptText(locale, "worldbook.section.instruction"), lore].join("\n");
  if (!worldImported) return section;
  return [promptText(locale, "prompt.keeper_discipline"), promptText(locale, "prompt.module_fidelity"), section].join("\n\n");
}

export interface GameState {
  readonly scene: SceneView | null;
  readonly clock: GameClockTableView | null;
  readonly party: readonly PartyMember[];
  readonly keeperNotes: KeeperNotes | null;
  readonly initiative: InitiativeView | null;
}

function partyLines(locale: string, party: readonly PartyMember[]): string[] {
  if (party.length === 0) return [];
  const none = promptText(locale, "common.none");
  const lines = ["", promptText(locale, "prompt.game_state.roster_header")];
  for (const member of party) {
    const meters = member.resources.map((meter) => (meter.max === null ? `${meter.label} ${meter.value}` : `${meter.label} ${meter.value}/${meter.max}`)).join(" | ") || none;
    const effects = member.status.join(" | ") || none;
    lines.push(promptText(locale, "prompt.game_state.roster_line", { name: member.name, meters, effects }));
  }
  return lines;
}

function bulletBlock(locale: string, headerKey: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ["", promptText(locale, headerKey), ...items.map((content) => promptText(locale, "prompt.game_state.bullet", { content }))];
}

function initiativeLines(locale: string, initiative: InitiativeView | null): string[] {
  if (initiative === null || initiative.order.length === 0) return [];
  // Listed from the acting combatant on, wrapping round, so row 1 is always whose turn it is.
  const start = Math.max(
    0,
    initiative.order.findIndex((combatant) => combatant.name === initiative.acting),
  );
  const rotated = [...initiative.order.slice(start), ...initiative.order.slice(0, start)].slice(0, STATE_INITIATIVE_ROWS);
  return [
    "",
    promptText(locale, "prompt.game_state.initiative_header"),
    ...rotated.map((combatant, at) =>
      promptText(locale, "prompt.game_state.initiative_line", {
        index: at + 1,
        name: combatant.name,
        initiative: combatant.value,
        marker: at === 0 && initiative.acting !== null ? ACTING_MARKER : "",
      }),
    ),
  ];
}

/** 13. The state panel: scene, time, focus, party, NPCs, facts, world changes, initiative. Always present. */
export function gameStateSection(locale: string, state: GameState): string {
  const divider = promptText(locale, "prompt.divider");
  const scene = state.scene?.name || promptText(locale, "common.unknown");
  const focus = state.scene?.focus || promptText(locale, "prompt.game_state.default_focus");
  const time = state.clock?.now || promptText(locale, "prompt.game_state.clock_not_set");
  const lines = [
    divider,
    promptText(locale, "prompt.game_state.title"),
    divider,
    promptText(locale, "prompt.game_state.scene_line", { scene }),
    promptText(locale, "prompt.game_state.clock_line", { time }),
    promptText(locale, "prompt.game_state.focus_line", { focus }),
  ];
  lines.push(...partyLines(locale, state.party));

  const notes = state.keeperNotes;
  const npcNotes = notes === null ? [] : lastN(notesIn(notes, NPC_STATUS_CATEGORY), STATE_NPC_NOTES).map((note) => note.text);
  lines.push(...bulletBlock(locale, "prompt.game_state.npc_header", npcNotes));

  const established = state.scene?.established ?? [];
  const opening = established.filter((fact) => fact.at === OPENING_FACT_TAG).map((fact) => fact.text);
  lines.push(...bulletBlock(locale, "prompt.game_state.background_header", lastN(opening, STATE_FACTS)));
  const facts = lastN(
    established.filter((fact) => fact.at !== OPENING_FACT_TAG).map((fact) => fact.text),
    STATE_FACTS,
  );
  lines.push("");
  if (facts.length > 0) {
    lines.push(promptText(locale, "prompt.game_state.facts_header"));
    lines.push(...facts.map((content) => promptText(locale, "prompt.game_state.bullet", { content })));
  } else {
    lines.push(promptText(locale, "prompt.game_state.facts_empty"));
  }

  const changes = notes === null ? [] : lastN(notesIn(notes, WORLD_CHANGES_CATEGORY), STATE_WORLD_CHANGES).map((note) => note.text);
  lines.push(...bulletBlock(locale, "prompt.game_state.world_changes_header", changes));
  lines.push(...initiativeLines(locale, state.initiative));
  lines.push(divider);
  return lines.join("\n");
}

/** 14. Relationship tracks that moved off their initial value, one line per pair. */
export function relationshipsSection(locale: string, relationships: Relationships | null): string {
  if (relationships === null) return "";
  // Sorted by subject, target, track (code-point order): the same state reads the same.
  const pairs: { subject: string; target: string; tracks: string[] }[] = [];
  for (const row of changedRelationships(relationships)) {
    if (!RELATIONSHIP_TRACKS.has(row.track)) continue;
    const label = promptText(locale, `relationships.track.${row.track}`);
    const pair = promptText(locale, "relationships.describe.pair", { label, value: row.value });
    const last = pairs[pairs.length - 1];
    if (last !== undefined && last.subject === row.subject && last.target === row.target) last.tracks.push(pair);
    else pairs.push({ subject: row.subject, target: row.target, tracks: [pair] });
  }
  if (pairs.length === 0) return "";
  const lines = pairs.map((pair) =>
    promptText(locale, "relationships.describe.line", { subject: pair.subject, target: pair.target, tracks: pair.tracks.join(", ") }),
  );
  return promptText(locale, "prompt.relationships_header") + "\n" + lines.join("\n");
}

/** 15. How this table plays: the index lines only, never the details. */
export function habitsSection(locale: string, habits: TableHabits | null): string {
  const lines = habits === null ? [] : habitIndex(habits).filter((line) => line.trim() !== "");
  if (lines.length === 0) return "";
  return promptText(locale, "prompt.table_habits") + "\n" + lines.map((line) => `- ${line.trim()}`).join("\n");
}

/** 16. The declared module variables, every one; keeper-only ones carry the never-reveal tag. */
export function moduleVariablesSection(locale: string, variables: ModuleVariables | null): string {
  if (variables === null || variables.variables.length === 0) return "";
  const lines = variables.variables.map(({ spec, value }) => {
    let shown =
      spec.kind === "bool"
        ? promptText(locale, value === true ? "modvars.describe.bool_true" : "modvars.describe.bool_false")
        : String(value);
    if (spec.kind === "number" && (spec.minimum !== undefined || spec.maximum !== undefined)) {
      shown = promptText(locale, "modvars.describe.bounded", {
        value: shown,
        minimum: spec.minimum === undefined ? "-∞" : spec.minimum,
        maximum: spec.maximum === undefined ? "∞" : spec.maximum,
      });
    }
    const line = promptText(locale, "modvars.describe.line", { label: labelFor(spec, locale), id: spec.id, value: shown });
    return spec.visibility === "keeper" ? promptText(locale, "modvars.describe.keeper_tagged", { line }) : line;
  });
  return promptText(locale, "prompt.modvars_header") + "\n" + lines.map((line) => `- ${line}`).join("\n");
}

/** 17. The set-up choices the table has not made yet, as one data line. */
export function setupPendingSection(locale: string, pending: readonly SetupItem[]): string {
  if (pending.length === 0) return "";
  const items = pending
    .map((item) => {
      const label = setupLabel(item, locale);
      return item.options.length > 0 ? promptText(locale, "prompt.setup_item", { label, options: item.options.join("|") }) : label;
    })
    .join(promptText(locale, "common.list_separator"));
  return promptText(locale, "prompt.setup_pending", { items });
}

function scalarText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function leafText(leaf: Leaf): string {
  return Array.isArray(leaf.value) ? JSON.stringify(leaf.value) : scalarText(leaf.value);
}

/** 18. The imported variable tree's leaves, whole (the Keeper sees unexposed ones too). */
export function variableTreeSection(locale: string, tree: VarMap | null): string {
  const leaves = tree === null ? [] : flattenLeaves(tree, MAX_PROMPT_LEAVES);
  if (leaves.length === 0) return "";
  return promptText(locale, "prompt.mvu_header") + "\n" + leaves.map((leaf) => `- ${leaf.path} = ${leafText(leaf)}`).join("\n");
}

/** 20. The world card's post-history directives (this turn's text). */
export function cardPostHistorySection(locale: string, directives: CardDirectives | null): string {
  if (directives === null || directives.postHistory === "") return "";
  return promptText(locale, "prompt.card_directives_header") + "\n\n" + directives.postHistory;
}

/** 21. The Scribe's bookkeeping whispers. */
export function whispersSection(locale: string, whispers: readonly string[]): string {
  if (whispers.length === 0) return "";
  return promptText(locale, "prompt.scribe_notes") + "\n" + whispers.map((note) => `- ${note}`).join("\n");
}

/** 22. Commands players ran themselves since the Keeper's last turn. */
export function playerActionsSection(locale: string, actions: readonly PlayerAction[]): string {
  if (actions.length === 0) return "";
  const lines = actions.map((entry) =>
    promptText(locale, "prompt.player_action_line", { actor: entry.actor, action: entry.action, text: entry.text }),
  );
  return promptText(locale, "prompt.player_actions_header") + "\n" + lines.join("\n");
}

/** 23. Module injections for this turn. */
export function injectionsSection(locale: string, injections: readonly string[]): string {
  if (injections.length === 0) return "";
  return promptText(locale, "prompt.hooks_header") + "\n" + injections.join("\n");
}

function recordLine(locale: string, record: ChronicleRecord): string {
  let text = record.text.trim();
  const margin = record.keeper.trim();
  if (margin !== "") text += `  [${promptText(locale, "prompt.chronicle.keeper_label")} ${margin}]`;
  return promptText(locale, "prompt.chronicle.record_line", { turn: record.turn, text });
}

/** The largest prefix of a relevance-ranked list that fits the budget: the weakest hits go. */
function mostRelevant(locale: string, records: readonly ChronicleRecord[], budget: number): string[] {
  const lines: string[] = [];
  let left = budget;
  for (const record of records) {
    const line = recordLine(locale, record);
    const size = codePointLength(line);
    if (left - size < 0) break;
    lines.push(line);
    left -= size;
  }
  return lines;
}

/**
 * 24. Open threads and recalled records. When the head carries no summary, the chronicle
 * header leads this half instead.
 */
export function chronicleTailSection(
  locale: string,
  summary: CampaignSummary | null,
  threads: readonly PlotThread[],
  recalled: readonly ChronicleRecord[],
): string {
  const parts: string[] = [];
  const open = threads.filter((thread) => thread.status === "open").slice(0, MAX_PROMPT_THREADS);
  if (open.length > 0) {
    const lines = open.map((thread) => {
      const notes = thread.notes.trim();
      return notes === "" ? `- ${thread.label}` : `- ${thread.label} — ${notes}`;
    });
    parts.push(promptText(locale, "prompt.chronicle.threads_label") + "\n" + lines.join("\n"));
  }
  const recalledLines = mostRelevant(locale, recalled, RECALL_BUDGET_CHARS);
  if (recalledLines.length > 0) {
    parts.push(promptText(locale, "prompt.chronicle.recalled_label") + "\n" + recalledLines.join("\n"));
  }
  if (parts.length === 0) return "";
  const body = parts.join("\n\n");
  return summaryBody(locale, summary) === "" ? promptText(locale, "prompt.chronicle.header") + "\n\n" + body : body;
}
