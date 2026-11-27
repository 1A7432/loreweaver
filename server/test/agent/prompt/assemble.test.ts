import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assembleKeeperPrompt,
  keeperMessages,
  type KeeperPromptSnapshot,
  moveInTurnBreakpoint,
  type PastExchange,
  promptText,
  stripCacheBreakpoints,
} from "../../../src/agent/prompt/index.ts";
import type { CampaignSummary } from "../../../src/core/chronicle/index.ts";
import { builtInPacks, expertiseText, type RulePack } from "../../../src/core/rulepacks/index.ts";
import type { VarMap, VarValue } from "../../../src/core/variables/index.ts";
import type { ChatMessage } from "../../../src/infra/llm/types.ts";

function coc7(): RulePack {
  const pack = builtInPacks().find((item) => item.id === "coc7");
  if (pack === undefined) throw new Error("coc7 missing");
  return pack;
}

const EMPTY: KeeperPromptSnapshot = {
  locale: "en",
  pack: null,
  cardDirectives: null,
  skills: [],
  moduleCommands: [],
  summary: null,
  worldImported: false,
  lore: "",
  scene: null,
  clock: null,
  party: [],
  keeperNotes: null,
  initiative: null,
  relationships: null,
  habits: null,
  variables: null,
  setupPending: [],
  variableTree: null,
  whispers: [],
  playerActions: [],
  injections: [],
  threads: [],
  recalled: [],
  history: [],
  speaker: "",
  line: "I open the door.",
};

function summary(throughTurn: number, text = "STABLE_SUMMARY the party reached the lighthouse."): CampaignSummary {
  return { text, throughTurn, foldCount: 1, keeper: "STABLE_MARGIN the keeper is the cultist", foldMeter: null };
}

function tree(entries: [string, VarValue][]): VarMap {
  return new Map(entries);
}

function exchanges(from: number, to: number): PastExchange[] {
  const out: PastExchange[] = [];
  for (let turn = from; turn <= to; turn++) {
    out.push({ turn, speaker: turn % 2 === 0 ? "Alice" : "Bob", playerText: `player line ${turn}`, keeperReply: `keeper reply ${turn}` });
  }
  return out;
}

/** Every section contributing; each volatile input carries a VOLATILE_ marker. */
function furnished(locale = "en"): KeeperPromptSnapshot {
  return {
    locale,
    pack: coc7(),
    cardDirectives: { head: "STABLE_CARD_HEAD speak like a noir narrator", postHistory: "VOLATILE_CARD_POST remember the rain" },
    skills: ["STABLE_SKILL_BODY run horror slowly"],
    moduleCommands: [
      { id: "ring_bell", summary: "STABLE_COMMAND rings the lighthouse bell", signature: "(times?: integer 1..5)" },
      { id: "check_tide", summary: "", signature: null },
      { id: "douse_lamp", summary: "", signature: "()" },
    ],
    summary: summary(2),
    worldImported: true,
    lore: "VOLATILE_LORE the lighthouse was built in 1890",
    scene: {
      name: "VOLATILE_SCENE lighthouse stairs",
      focus: "VOLATILE_FOCUS climbing",
      established: [
        { text: "VOLATILE_OPENING hired by the mayor", at: "开局" },
        { text: "VOLATILE_FACT the lamp is broken", at: "D1 21:00" },
      ],
    },
    clock: { now: "VOLATILE_CLOCK D1 22:10" },
    party: [{ name: "Alice", status: ["VOLATILE_STATUS shaken"], resources: [{ id: "hp", label: "HP", value: 9, max: 11 }] }],
    keeperNotes: {
      categories: [
        { name: "npc_status", entries: [{ text: "VOLATILE_NPC_NOTE the keeper waits upstairs", at: null }] },
        { name: "world_changes", entries: [{ text: "VOLATILE_WORLD_CHANGE the door is broken", at: null }] },
      ],
    },
    initiative: {
      round: 2,
      acting: "Cultist",
      order: [
        { name: "Alice", value: 60 },
        { name: "Cultist", value: 40 },
      ],
    },
    relationships: { tracks: [{ subject: "VOLATILE_REL_NPC", target: "Alice", track: "affection", value: 15 }] },
    habits: { habits: [{ summary: "VOLATILE_HABIT likes long scenes", detail: "", seen: 3 }], pending: [] },
    variables: {
      variables: [
        {
          spec: { id: "dread", kind: "number", visibility: "keeper", labels: { en: "VOLATILE_VAR Dread" }, minimum: 0, maximum: 10, default: 0 },
          value: 4,
        },
        { spec: { id: "bell_rung", kind: "bool", visibility: "player", labels: { en: "Bell rung" }, default: false }, value: true },
      ],
    },
    setupPending: [{ path: "difficulty", options: ["easy", "hard"], labels: [{ locale: "en", text: "VOLATILE_SETUP Difficulty" }], done: false }],
    variableTree: tree([["VOLATILE_TREE", new Map<string, VarValue>([["hp", 3], ["tags", ["a", "b", "c"]]])]]),
    whispers: ["VOLATILE_WHISPER the clock was not advanced"],
    playerActions: [{ actor: "Bob", action: "ring_bell", text: "VOLATILE_ACTION the bell tolls" }],
    injections: ["VOLATILE_INJECTION the tide is rising"],
    threads: [
      { label: "VOLATILE_THREAD who broke the lamp", status: "open", notes: "suspect the keeper" },
      { label: "RESOLVED_THREAD the boat", status: "resolved", notes: "" },
    ],
    recalled: [{ turn: 1, text: "VOLATILE_RECALLED they met the mayor", characters: [], scene: "", keeper: "VOLATILE_RECORD_MARGIN", folded: true }],
    history: exchanges(1, 5),
    speaker: "Alice",
    line: "VOLATILE_PLAYER_LINE I climb on.",
  };
}

const t = (key: string, params: Readonly<Record<string, string | number>> = {}): string => promptText("en", key, params);

describe("sections", () => {
  test("an empty room has the always-present sections and nothing else", () => {
    const prompt = assembleKeeperPrompt(EMPTY);
    expect(prompt.stable).toBe(
      [
        [t("prompt.system.intro"), "", t("prompt.system.guidelines_header"), t("prompt.system.guidelines")].join("\n"),
        t("prompt.expertise.generic"),
        [t("prompt.style.narrative"), "", t("prompt.style.roll_policy"), "", t("prompt.style.freshness")].join("\n"),
      ].join("\n\n"),
    );
    // The state panel is the one tail section with something to say in an empty room.
    expect(prompt.volatile).toBe(
      [
        t("prompt.divider"),
        t("prompt.game_state.title"),
        t("prompt.divider"),
        t("prompt.game_state.scene_line", { scene: t("common.unknown") }),
        t("prompt.game_state.clock_line", { time: t("prompt.game_state.clock_not_set") }),
        t("prompt.game_state.focus_line", { focus: t("prompt.game_state.default_focus") }),
        "",
        t("prompt.game_state.facts_empty"),
        t("prompt.divider"),
      ].join("\n"),
    );
    expect(prompt.history).toEqual([]);
    for (const key of [
      "prompt.card_directives_header",
      "prompt.skills_header",
      "prompt.commands_header",
      "prompt.chronicle.header",
      "worldbook.section.title",
      "prompt.keeper_discipline",
      "prompt.relationships_header",
      "prompt.table_habits",
      "prompt.modvars_header",
      "prompt.mvu_header",
      "prompt.scribe_notes",
      "prompt.player_actions_header",
      "prompt.hooks_header",
      "prompt.game_state.roster_header",
      "prompt.game_state.initiative_header",
    ]) {
      expect([key, prompt.stable.includes(t(key)) || prompt.volatile.includes(t(key))]).toEqual([key, false]);
    }
  });

  test("a furnished room shows every section, head and tail in order", () => {
    const prompt = assembleKeeperPrompt(furnished());
    const headOrder = [
      t("prompt.system.intro"),
      expertiseText(coc7(), "en"),
      t("prompt.style.narrative"),
      t("prompt.card_directives_header") + "\n\nSTABLE_CARD_HEAD",
      t("prompt.skills_header"),
      t("prompt.commands_header"),
      t("prompt.chronicle.header"),
      t("prompt.chronicle.summary_label"),
    ];
    let at = -1;
    for (const marker of headOrder) {
      const next = prompt.stable.indexOf(marker);
      expect([marker, next > at]).toEqual([marker, true]);
      at = next;
    }
    const tailOrder = [
      t("prompt.keeper_discipline"),
      t("prompt.module_fidelity"),
      t("worldbook.section.title"),
      t("prompt.game_state.title"),
      t("prompt.relationships_header"),
      t("prompt.table_habits"),
      t("prompt.modvars_header"),
      "VOLATILE_SETUP",
      t("prompt.mvu_header"),
      "VOLATILE_CARD_POST",
      t("prompt.scribe_notes"),
      t("prompt.player_actions_header"),
      t("prompt.hooks_header"),
      t("prompt.chronicle.threads_label"),
      t("prompt.chronicle.recalled_label"),
    ];
    at = -1;
    for (const marker of tailOrder) {
      const next = prompt.volatile.indexOf(marker);
      expect([marker, next > at]).toEqual([marker, true]);
      at = next;
    }
    // The summary carries the header, so the tail does not repeat it.
    expect(prompt.volatile.includes(t("prompt.chronicle.header"))).toBe(false);
    expect(prompt.volatile).not.toContain("RESOLVED_THREAD");
  });

  test("the section bodies render as 2.6 did", () => {
    const { stable, volatile } = assembleKeeperPrompt(furnished());
    expect(stable).toContain(`${t("prompt.commands_header")}\n- ring_bell(times?: integer 1..5): STABLE_COMMAND rings the lighthouse bell\n- check_tide\n- douse_lamp()`);
    expect(stable).toContain(
      `${t("prompt.chronicle.summary_label")}\nSTABLE_SUMMARY the party reached the lighthouse.\n${t("prompt.chronicle.keeper_label")} STABLE_MARGIN the keeper is the cultist`,
    );
    expect(volatile).toContain(`${t("worldbook.section.title")}\n${t("worldbook.section.instruction")}\nVOLATILE_LORE`);
    expect(volatile).toContain("Alice: HP 9/11 | Status: VOLATILE_STATUS shaken");
    expect(volatile).toContain(`${t("prompt.game_state.background_header")}\n   • VOLATILE_OPENING hired by the mayor`);
    expect(volatile).toContain(`${t("prompt.game_state.facts_header")}\n   • VOLATILE_FACT the lamp is broken`);
    // Initiative is listed from the acting combatant, who carries the marker.
    expect(volatile).toContain(`${t("prompt.game_state.initiative_header")}\n   1. Cultist (40) \u{1F448}\n   2. Alice (60)`);
    expect(volatile).toContain(`${t("prompt.relationships_header")}\nVOLATILE_REL_NPC → Alice: Affection 15`);
    expect(volatile).toContain(`${t("prompt.table_habits")}\n- VOLATILE_HABIT likes long scenes`);
    expect(volatile).toContain(
      "- VOLATILE_VAR Dread [dread]: 4 (range 0–10) — KEEPER-ONLY: never reveal this value or its existence to players\n- Bell rung [bell_rung]: yes",
    );
    expect(volatile).toContain(t("prompt.setup_pending", { items: "VOLATILE_SETUP Difficulty (easy|hard)" }));
    expect(volatile).toContain(`${t("prompt.mvu_header")}\n- VOLATILE_TREE.hp = 3\n- VOLATILE_TREE.tags = ["a","b","c"]`);
    expect(volatile).toContain(`${t("prompt.scribe_notes")}\n- VOLATILE_WHISPER`);
    expect(volatile).toContain(`${t("prompt.player_actions_header")}\n- Bob — ring_bell: VOLATILE_ACTION the bell tolls`);
    expect(volatile).toContain(`${t("prompt.hooks_header")}\nVOLATILE_INJECTION`);
    expect(volatile).toContain(`- VOLATILE_THREAD who broke the lamp — suspect the keeper`);
    expect(volatile).toContain(`- [turn 1] VOLATILE_RECALLED they met the mayor  [${t("prompt.chronicle.keeper_label")} VOLATILE_RECORD_MARGIN]`);
  });

  test("the mystery-shaped blocks ride only lore in a room with an imported world", () => {
    const discipline = t("prompt.keeper_discipline");
    expect(assembleKeeperPrompt(furnished()).volatile).toContain(discipline);
    expect(assembleKeeperPrompt({ ...furnished(), worldImported: false }).volatile).not.toContain(discipline);
    expect(assembleKeeperPrompt({ ...furnished(), lore: "" }).volatile).not.toContain(discipline);
    expect(assembleKeeperPrompt({ ...furnished(), lore: "" }).volatile).not.toContain(t("worldbook.section.title"));
  });

  test("without a summary the chronicle header leads the tail, and nothing chronicle-shaped sits in the head", () => {
    const prompt = assembleKeeperPrompt({ ...furnished(), summary: null });
    expect(prompt.stable).not.toContain(t("prompt.chronicle.header"));
    expect(prompt.volatile).toContain(`${t("prompt.chronicle.header")}\n\n${t("prompt.chronicle.threads_label")}`);
    const bare = assembleKeeperPrompt({ ...furnished(), summary: null, threads: [], recalled: [] });
    expect(bare.volatile).not.toContain(t("prompt.chronicle.header"));
  });

  test("recalled records keep the most relevant prefix that fits the budget", () => {
    const long = "x".repeat(3_500);
    const recalled = [1, 2, 3].map((turn) => ({ turn, text: `${long}${turn}`, characters: [], scene: "", keeper: "", folded: true }));
    const prompt = assembleKeeperPrompt({ ...EMPTY, recalled });
    expect(prompt.volatile).toContain(`${long}1`);
    expect(prompt.volatile).not.toContain(`${long}2`);
  });

  test("an unmoved relationship and an expertise-less pack say nothing of their own", () => {
    const prompt = assembleKeeperPrompt({ ...EMPTY, relationships: { tracks: [{ subject: "A", target: "B", track: "affection", value: 0 }] } });
    expect(prompt.volatile).not.toContain(t("prompt.relationships_header"));
    expect(assembleKeeperPrompt({ ...EMPTY, pack: coc7() }).stable).toContain(expertiseText(coc7(), "en"));
  });
});

describe("layout and cache marks", () => {
  test("head, history, state, player line — with the breakpoints where they belong", () => {
    const prompt = assembleKeeperPrompt(furnished());
    const messages = keeperMessages(prompt);
    // 3 replayed turns (3..5) after the summary through turn 2.
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user", "assistant", "user", "user"]);
    expect(messages.map((message) => message.cacheBreakpoint === true)).toEqual([true, false, false, false, false, false, true, false, false]);
    expect(messages[0]?.content).toBe(prompt.stable);
    expect(messages[1]?.content).toBe("[Bob]\nplayer line 3");
    expect(messages[6]?.content).toBe("keeper reply 5");
    expect(messages[7]?.content).toBe(`${t("prompt.state_header")}\n\n${prompt.volatile}`);
    expect(messages[8]?.content).toBe("[Alice]\nVOLATILE_PLAYER_LINE I climb on.");
    // The prompt object itself carries no marks.
    expect(prompt.history.some((message) => message.cacheBreakpoint !== undefined)).toBe(false);
  });

  test("no history: two marks only, and an untagged line stays verbatim", () => {
    const messages = keeperMessages(assembleKeeperPrompt(EMPTY));
    expect(messages.map((message) => [message.role, message.cacheBreakpoint === true])).toEqual([
      ["system", true],
      ["user", false],
      ["user", false],
    ]);
    expect(messages[2]?.content).toBe("I open the door.");
  });

  test("the in-turn breakpoint follows the newest tool result; strip removes every mark", () => {
    const base = keeperMessages(assembleKeeperPrompt(furnished()));
    const round = (id: string): ChatMessage[] => [
      { role: "assistant", content: "", toolCalls: [{ id, name: "roll_dice", input: { valid: true, value: {} } }] },
      { role: "tool", toolCallId: id, content: `result ${id}` },
    ];
    const first = moveInTurnBreakpoint([...base, ...round("a")]);
    expect(first.filter((message) => message.cacheBreakpoint === true).length).toBe(3);
    expect(first[first.length - 1]?.cacheBreakpoint).toBe(true);
    const second = moveInTurnBreakpoint([...first, ...round("b")]);
    const marks = second.flatMap((message, at) => (message.cacheBreakpoint === true ? [at] : []));
    expect(marks).toEqual([0, 6, second.length - 1]);
    expect(first[first.length - 1]?.cacheBreakpoint).toBe(true); // the input list is not mutated
    expect(stripCacheBreakpoints(second).some((message) => "cacheBreakpoint" in message)).toBe(false);
    expect(stripCacheBreakpoints(second).map((message) => message.content)).toEqual(second.map((message) => message.content));
  });
});

describe("cache stability", () => {
  test("turn N+1 shares turn N's head and history byte for byte", () => {
    const turnN = furnished();
    const turnN1: KeeperPromptSnapshot = {
      ...turnN,
      // Everything live moves; the room's configuration and the summary do not.
      lore: "VOLATILE_LORE a different entry fired",
      scene: { name: "the lamp room", focus: "fighting", established: [] },
      clock: { now: "D1 22:40" },
      whispers: [],
      injections: ["the tide turns"],
      threads: [],
      recalled: [],
      history: [...turnN.history, { turn: 6, speaker: "Alice", playerText: "VOLATILE_PLAYER_LINE I climb on.", keeperReply: "You reach the top." }],
      line: "I light the lamp.",
    };
    const a = keeperMessages(assembleKeeperPrompt(turnN));
    const b = keeperMessages(assembleKeeperPrompt(turnN1));
    const stripped = (messages: ChatMessage[]): string[] => stripCacheBreakpoints(messages).map((message) => JSON.stringify(message));
    const historyEndA = a.findIndex((message, at) => at > 0 && message.cacheBreakpoint === true);
    // Head and every replayed message of turn N reappear unchanged at the front of turn N+1.
    expect(stripped(b).slice(0, historyEndA + 1)).toEqual(stripped(a).slice(0, historyEndA + 1));
    expect(b[0]?.content).toBe(a[0]?.content);
  });

  test("no volatile input reaches the head", () => {
    const prompt = assembleKeeperPrompt(furnished());
    expect(prompt.stable).not.toMatch(/VOLATILE_/u);
    for (const marker of ["STABLE_CARD_HEAD", "STABLE_SKILL_BODY", "STABLE_COMMAND", "STABLE_SUMMARY", "STABLE_MARGIN"]) {
      expect(prompt.stable).toContain(marker);
    }
    // And every volatile marker did land somewhere: in the tail or the player line.
    const json = JSON.stringify(furnished(), (_key, value: unknown) => (value instanceof Map ? [...value] : value));
    const markers = new Set(json.match(/VOLATILE_[A-Z_]+/gu) ?? []);
    expect(markers.size).toBeGreaterThan(20);
    for (const marker of markers) {
      expect([marker, (prompt.volatile + prompt.playerLine).includes(marker)]).toEqual([marker, true]);
    }
  });

  test("the same snapshot always gives the same bytes", () => {
    const one = JSON.stringify(keeperMessages(assembleKeeperPrompt(furnished())));
    const two = JSON.stringify(keeperMessages(assembleKeeperPrompt(furnished())));
    expect(two).toBe(one);
    expect(JSON.stringify(keeperMessages(assembleKeeperPrompt(furnished("zh"))))).toBe(JSON.stringify(keeperMessages(assembleKeeperPrompt(furnished("zh")))));
  });
});

describe("history", () => {
  test("nothing at or before the summary's through-turn is replayed", () => {
    const at = (throughTurn: number): string[] =>
      assembleKeeperPrompt({ ...EMPTY, summary: summary(throughTurn), history: exchanges(1, 5) }).history.map((message) => message.content);
    expect(at(0)).toHaveLength(10);
    expect(at(2)).toEqual(["[Bob]\nplayer line 3", "keeper reply 3", "[Alice]\nplayer line 4", "keeper reply 4", "[Bob]\nplayer line 5", "keeper reply 5"]);
    expect(at(5)).toEqual([]);
    expect(assembleKeeperPrompt({ ...EMPTY, history: exchanges(1, 2) }).history).toHaveLength(4);
  });

  test("what NPCs said as their own messages stays in the history, before that turn's reply", () => {
    const exchange = { turn: 3, speaker: "Bob", playerText: "I ask about the lighthouse.", keeperReply: "She puts the glass down.", npcLines: [{ name: "Martha", text: "Every night it burns." }, { name: "Old Tom", text: "Don't ask." }] };
    const replayed = (locale: string) => assembleKeeperPrompt({ ...EMPTY, locale, history: [exchange] }).history.map((message) => message.content);
    expect(replayed("en")).toEqual(["[Bob]\nI ask about the lighthouse.", '(The table read this as Martha\'s own message: "Every night it burns.")\n\n(The table read this as Old Tom\'s own message: "Don\'t ask.")\n\nShe puts the glass down.']);
    expect(replayed("zh")[1]).toBe("（桌上已读到Martha本人的发言：“Every night it burns.”）\n\n（桌上已读到Old Tom本人的发言：“Don't ask.”）\n\nShe puts the glass down.");
    // A turn in which no NPC spoke replays as it always did.
    const { npcLines: _none, ...silent } = exchange;
    expect(assembleKeeperPrompt({ ...EMPTY, history: [silent] }).history[1]?.content).toBe("She puts the glass down.");
  });
});

describe("text", () => {
  test("both locales render with no leftover placeholder and no raw key", () => {
    const keys = Object.keys(JSON.parse(readFileSync(join(import.meta.dir, "../../../locales/en/prompt.json"), "utf8")) as object);
    for (const locale of ["en", "zh"]) {
      const messages = keeperMessages(assembleKeeperPrompt(furnished(locale)));
      const text = messages.map((message) => message.content).join("\n");
      expect([locale, text.match(/\{[a-z_]+\}/gu)]).toEqual([locale, null]);
      for (const key of keys) expect([locale, key, text.includes(key)]).toEqual([locale, key, false]);
    }
    expect(assembleKeeperPrompt(furnished("zh")).stable).toContain("# AI 游戏主持人");
  });

  test("the carried-over texts are the 2.6 texts, apart from the listed edits", () => {
    // Keys edited to drop a mention of something 3.0 no longer has; every other copied key is verbatim.
    const edited = new Set(["prompt.keeper_discipline", "prompt.system.guidelines", "prompt.style.freshness"]);
    // `prompt.npc_line`: an NPC's own line kept in the history, now that the narration does not repeat it.
    const added = new Set(["prompt.commands_header", "prompt.command_line", "prompt.npc_line"]);
    // The 2.6 originals of every key the Keeper's catalog carries, exported from the Python
    // server's catalogs (prompt, worldbook, relationships, modvars, common) before it was removed:
    // the tuned wording stays pinned to what was tuned.
    for (const locale of ["en", "zh"]) {
      const ours = JSON.parse(readFileSync(join(import.meta.dir, "../../../locales", locale, "prompt.json"), "utf8")) as Record<string, string>;
      const frozen = JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/reference", `keeper_prompt_2_6.${locale}.json`), "utf8")) as Record<string, string>;
      for (const [key, text] of Object.entries(ours)) {
        if (added.has(key)) continue;
        expect([locale, key, Object.hasOwn(frozen, key)]).toEqual([locale, key, true]);
        if (!edited.has(key)) expect([locale, key, text]).toEqual([locale, key, frozen[key] as string]);
        else expect([locale, key, text === frozen[key]]).toEqual([locale, key, false]);
      }
      for (const dropped of ["set_npc_knowledge", "get_module_summary", "unlock_for_player", "search_documents", "companion_act"]) {
        expect([locale, dropped, Object.values(ours).some((text) => text.includes(dropped))]).toEqual([locale, dropped, false]);
      }
    }
  });

  test("size report", () => {
    for (const locale of ["en", "zh"]) {
      const prompt = assembleKeeperPrompt(furnished(locale));
      const empty = assembleKeeperPrompt({ ...EMPTY, locale });
      console.log(
        `[prompt size ${locale}] furnished: head ${prompt.stable.length} chars, tail ${prompt.volatile.length} chars; ` +
          `empty room: head ${empty.stable.length}, tail ${empty.volatile.length}`,
      );
      expect(prompt.stable.length).toBeGreaterThan(empty.stable.length);
    }
  });
});
