// The Keeper's prompt: the ONE assembler of the Keeper's context (iron rule 5).
//
// A pure function of a snapshot the caller read (`snapshot.ts`): no store, no clock, no
// randomness — the same snapshot gives the same bytes. It returns one object split at the
// cache boundary, and `keeperMessages` lays that object out for a model call:
//
//   [system: stable head]◆  [history…]◆  [user: state header + volatile tail]  [user: player line]
//
// (◆ = a cache breakpoint). Then, inside the turn, one more breakpoint follows the newest
// tool result (`moveInTurnBreakpoint`). At most three marks against a provider limit of four.
//
// The head holds only what changes when the ROOM's configuration changes — identity,
// rule expertise, style, the world card's head directives, skill bodies, the module
// command catalogue — plus the campaign summary, which changes only when a fold writes it;
// that fold also stops replaying the turns it covers, so the prefix was lost that turn
// regardless. Everything that moves on its own schedule (lore, live state, threads,
// recalled records, this turn's notes) is in the tail. A per-turn value in the head would
// break the cache for every later turn.
//
// Carried over verbatim from 2.6 (`agent/prompt_builder.py`, `core/prompt_sections.py`,
// `agent/chronicle.py`), with these left behind: the module knowledge pool and its
// vector-search fallback, the imported style preset's bands, the AI-companions style
// block, the state panel's clue list (it read the module pool) and its single-character
// fallback line (every character is seated in 3.0).
import { replayable, summaryThroughTurn } from "../../core/chronicle/index.ts";
import type { AssistantMessage, ChatMessage, UserMessage } from "../../infra/llm/types.ts";
import { promptText } from "./catalog.ts";
import {
  cardHeadSection,
  cardPostHistorySection,
  chronicleHeadSection,
  chronicleTailSection,
  expertiseSection,
  gameStateSection,
  habitsSection,
  identitySection,
  injectionsSection,
  loreSection,
  moduleCommandsSection,
  moduleVariablesSection,
  playerActionsSection,
  relationshipsSection,
  setupPendingSection,
  skillsSection,
  styleSection,
  variableTreeSection,
  whispersSection,
} from "./sections.ts";
import type { KeeperPromptSnapshot, PastExchange } from "./snapshot.ts";

/** One assembled Keeper prompt, split at its cache boundary. */
export interface KeeperPrompt {
  /** The cache-stable head: one system message. */
  readonly stable: string;
  /** The volatile tail, without its header. */
  readonly volatile: string;
  /** The text that opens the state message, naming it engine state, not a player's words. */
  readonly stateHeader: string;
  /** The replayed history, unmarked, oldest first. */
  readonly history: readonly ChatMessage[];
  /** This turn's player line, speaker-tagged. */
  readonly playerLine: string;
}

function joinSections(sections: readonly string[]): string {
  return sections.filter((section) => section !== "").join("\n\n");
}

/** The Keeper-side player line: tagged with the speaker, since several humans share one conversation. */
export function speakerLine(locale: string, speaker: string, text: string): string {
  const name = speaker.trim();
  return name === "" ? text : promptText(locale, "prompt.speaker_line", { name, text });
}

/** A past exchange as replayed: a byte-stable function of the exchange alone. */
export function replayExchange(locale: string, exchange: PastExchange): readonly [UserMessage, AssistantMessage] {
  return [
    { role: "user", content: speakerLine(locale, exchange.speaker, exchange.playerText) },
    { role: "assistant", content: exchange.keeperReply },
  ];
}

/** Assemble the Keeper's prompt for one turn. */
export function assembleKeeperPrompt(snapshot: KeeperPromptSnapshot): KeeperPrompt {
  const locale = snapshot.locale;

  const stable = joinSections([
    identitySection(locale),
    expertiseSection(locale, snapshot.pack),
    styleSection(locale),
    cardHeadSection(locale, snapshot.cardDirectives),
    skillsSection(locale, snapshot.skills),
    moduleCommandsSection(locale, snapshot.moduleCommands),
    // The summary closes the head: the last thing before the turns it summarises.
    chronicleHeadSection(locale, snapshot.summary),
  ]);

  const volatile = joinSections([
    loreSection(locale, snapshot.lore, snapshot.worldImported),
    gameStateSection(locale, snapshot),
    relationshipsSection(locale, snapshot.relationships),
    habitsSection(locale, snapshot.habits),
    moduleVariablesSection(locale, snapshot.variables),
    setupPendingSection(locale, snapshot.setupPending),
    variableTreeSection(locale, snapshot.variableTree),
    // Standing directives before this turn's own direction, which keeps recency.
    cardPostHistorySection(locale, snapshot.cardDirectives),
    whispersSection(locale, snapshot.whispers),
    playerActionsSection(locale, snapshot.playerActions),
    injectionsSection(locale, snapshot.injections),
    chronicleTailSection(locale, snapshot.summary, snapshot.threads, snapshot.recalled),
  ]);

  // The one trim rule: nothing at or before the summary's through-turn is replayed.
  const history = replayable(snapshot.history, summaryThroughTurn(snapshot.summary)).flatMap((exchange) =>
    replayExchange(locale, exchange),
  );

  return {
    stable,
    volatile,
    stateHeader: promptText(locale, "prompt.state_header"),
    history,
    playerLine: speakerLine(locale, snapshot.speaker, snapshot.line),
  };
}

// ---------------------------------------------------------------------------
// Laying it out, and the cache marks
// ---------------------------------------------------------------------------

function marked(message: ChatMessage): ChatMessage {
  return message.cacheBreakpoint === true ? message : { ...message, cacheBreakpoint: true };
}

function unmarked(message: ChatMessage): ChatMessage {
  if (message.cacheBreakpoint === undefined) return message;
  const copy: { -readonly [K in keyof ChatMessage]?: ChatMessage[K] } = { ...message };
  delete copy.cacheBreakpoint;
  return copy as ChatMessage;
}

/**
 * The messages that open a Keeper model call: the head as one system message with a
 * breakpoint, the history with a breakpoint on its last message, the state message, the
 * player's line. An empty head or tail contributes no message.
 */
export function keeperMessages(prompt: KeeperPrompt): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (prompt.stable !== "") messages.push({ role: "system", content: prompt.stable, cacheBreakpoint: true });
  const history = prompt.history.map(unmarked);
  const last = history.length - 1;
  history.forEach((message, at) => messages.push(at === last ? marked(message) : message));
  if (prompt.volatile !== "") messages.push({ role: "user", content: prompt.stateHeader + "\n\n" + prompt.volatile });
  messages.push({ role: "user", content: prompt.playerLine });
  return messages;
}

/**
 * The conversation with exactly one in-turn breakpoint, on the newest tool result: each
 * tool round then reads what the round before it wrote. Older tool-result marks are
 * cleared; the head's and the history's marks are left alone. Returns a new list.
 */
export function moveInTurnBreakpoint(messages: readonly ChatMessage[]): ChatMessage[] {
  let newest = -1;
  messages.forEach((message, at) => {
    if (message.role === "tool") newest = at;
  });
  return messages.map((message, at) => {
    if (message.role !== "tool") return message;
    return at === newest ? marked(message) : unmarked(message);
  });
}

/** The conversation with every cache mark removed, for a call that leaves the main prefix. */
export function stripCacheBreakpoints(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map(unmarked);
}
