import { describe, expect, test } from "bun:test";

import {
  type CheckAsk,
  type CheckAskOutcome,
  checkHolds,
  checkInstruction,
  cjkToInt,
  correctionBaseMessages,
  DEFAULT_TURN_CHECKS,
  diceRolled,
  MAX_ROUNDS_PER_CHECK,
  MAX_ROUNDS_PER_TURN,
  replyStatesARoll,
  rolledValues,
  runTurnChecks,
  sceneTitleLines,
  statedRollNumbers,
  type TurnCheckRow,
  turnChecksFor,
  type TurnState,
  type TurnToolCall,
} from "../../../src/agent/turn/checks.ts";
import { turnText } from "../../../src/agent/turn/catalog.ts";
import type { TurnCheck } from "../../../src/core/rulepacks/index.ts";
import { FrozenMap } from "../../../src/core/resolution/types.ts";
import type { ChatMessage, Usage } from "../../../src/infra/llm/types.ts";
import {
  ARCHIVE_SCENE,
  bookkeepingCalls,
  CLOSING,
  call,
  DICE_TOOLS,
  dice,
  FULL_SCENE,
  rolledCalls,
  state,
  TITLE_REPLY,
} from "./fixtures.ts";

function row(condition: string): TurnCheckRow {
  const found = DEFAULT_TURN_CHECKS.find((check) => check.condition === condition);
  if (found === undefined) throw new Error(condition);
  return found;
}

// ---------------------------------------------------------------------------
// What the prose claims, and what the dice really did
// ---------------------------------------------------------------------------

describe("roll shapes", () => {
  test("every shape a stated roll takes is detected", () => {
    for (const stated of [
      "Spot Hidden — 22 vs 25 (Success!)",
      "You rolled 47 versus 65.",
      "侦查 22 对 25，勉强过了。",
      "1d100 = 47, under your 65.",
      "2d6+1 -> 9 damage.",
      "🎲 Intimidate — Fumble.",
      "掷出三十七，堪堪压过对方。",
    ]) {
      expect(replyStatesARoll(stated)).toBe(true);
    }
  });

  test("ordinary prose with numbers in it is not a roll", () => {
    for (const plain of [
      "The corridor stretches on, silent and cold.",
      "Three men wait by the pier; the fourth is already gone.",
      "It is 10:15 pm and the tide is turning.",
      "The odds are 50/50 at best.",
      "You succeed in prying the crate open.",
      "他把 1926 年的账本推到你面前。",
      "你成功撬开了箱子。",
      "",
    ]) {
      expect(replyStatesARoll(plain)).toBe(false);
    }
  });

  test("the forgery tolerance band is written down, not hidden", () => {
    // Accepted false positives: narrowing the shapes until these pass would reopen the hole
    // the shapes close; a false positive costs one re-ask, a false negative shows the table
    // numbers the engine never produced. Moving the band is allowed — update this list.
    for (const text of [
      "The vote was 12 vs 5 — the council refuses.",
      "Reinforcements: 40 versus 6. The alley will not hold.",
      "🎲 The gaming table's felt is worn where hands rest — success favours the house.",
    ]) {
      expect(replyStatesARoll(text)).toBe(true);
    }
    // The band's edges: an intervening noun breaks the pair; a die far from any result word is decoration.
    expect(replyStatesARoll("Their 40 rifles versus your 6 revolvers.")).toBe(false);
    expect(replyStatesARoll(`🎲 ${"The dice cup sits untouched on the felt. ".repeat(3)}`)).toBe(false);
  });

  test("a CJK character next to a number is a word character, as Python read it", () => {
    // `\b` in the reference is Unicode-aware: 查 and 2 are both word characters, so there is
    // no boundary between them and the pair is not a stated roll.
    expect(replyStatesARoll("侦查22对25")).toBe(false);
    expect(replyStatesARoll("侦查 22 对 25")).toBe(true);
    // Python's `\d` reads every script's digits.
    expect(statedRollNumbers("２２ vs ２５")).toEqual(new Set([22, 25]));
  });
});

describe("contradiction", () => {
  test("is exact against what the turn really rolled", () => {
    const calls = rolledCalls(47, 65);
    const check = row("dice_contradicts");
    expect(checkHolds(check, state("Spot Hidden — 22 vs 25. You find nothing.", calls))).toBe(true);
    // The real numbers are not a contradiction, even though prose should omit them.
    expect(checkHolds(check, state("Spot Hidden — 47 vs 65. You spot the latch.", calls))).toBe(false);
  });

  test("normalizes CJK numerals", () => {
    const calls = rolledCalls(37, 60);
    expect(statedRollNumbers("你掷出三十七。")).toEqual(new Set([37]));
    const check = row("dice_contradicts");
    expect(checkHolds(check, state("你掷出三十七，压过了目标。", calls))).toBe(false);
    expect(checkHolds(check, state("你掷出八十八，压过了目标。", calls))).toBe(true);
  });

  test("CJK numerals parse in the range dice produce", () => {
    const cases: [string, number | null][] = [
      ["十五", 15],
      ["三十五", 35],
      ["一百二十", 120],
      ["九百九十九", 999],
      ["两", 2],
      ["〇", 0],
      ["十", 10],
      ["百", 100],
      ["", null],
      ["千", null],
    ];
    for (const [text, value] of cases) expect(cjkToInt(text)).toBe(value);
  });

  test("only roll-shaped numbers are compared", () => {
    const reply = "42 vs 65 — you hold your nerve. Three men wait outside number 17, and it is 1926.";
    expect(statedRollNumbers(reply)).toEqual(new Set([42, 65]));
    expect(checkHolds(row("dice_contradicts"), state(reply, rolledCalls(42, 65)))).toBe(false);
  });

  test("forgery and contradiction are split by whether dice ran", () => {
    const forged = state("22 vs 25 — you fail.", [call("lookup_time")]);
    const contradicting = state("22 vs 25 — you fail.", rolledCalls());
    expect(checkHolds(row("dice_forged"), forged)).toBe(true);
    expect(checkHolds(row("dice_contradicts"), forged)).toBe(false);
    expect(checkHolds(row("dice_contradicts"), contradicting)).toBe(true);
    expect(checkHolds(row("dice_forged"), contradicting)).toBe(false);
  });

  test("rolled values read the same payloads the players see", () => {
    expect(rolledValues(rolledCalls(42, 65))).toEqual(new Set([42, 65]));
    // A roll with no published payload claims nothing.
    expect(rolledValues([call("skill_check")])).toEqual(new Set());
    expect(rolledValues([call("skill_check", {}, [{ ...dice(30, 60, [3, 0]), effectiveTarget: 30 }])])).toEqual(new Set([30, 60, 3, 0]));
  });

  test("a dice tool that published nothing makes no contradiction claim", () => {
    expect(checkHolds(row("dice_contradicts"), state("22 vs 25", [call("skill_check")]))).toBe(false);
  });

  test("dice rolled keys off the room's dice tools only", () => {
    const rolled = (calls: TurnToolCall[]): boolean => diceRolled({ calls, diceTools: DICE_TOOLS });
    expect(rolled([call("skill_check")])).toBe(true);
    expect(rolled([call("lookup_time"), call("sanity_check")])).toBe(true);
    expect(rolled([call("spend_luck")])).toBe(true);
    expect(rolled([call("skill_check", {}, [], true)])).toBe(false);
    expect(rolled([call("lookup_time"), call("get_module_summary")])).toBe(false);
    expect(rolled([])).toBe(false);
  });
});

describe("scene headings", () => {
  test("the detector's hits and misses", () => {
    expect(sceneTitleLines("🌉 東京港·大井埠頭五号泊位 | 晚 10:15").length).toBeGreaterThan(0);
    expect(sceneTitleLines("码头仓库区 ｜ 深夜").length).toBeGreaterThan(0);
    expect(sceneTitleLines("## 東京港 | 凌晨 2:00\n正文继续。").length).toBeGreaterThan(0);
    expect(sceneTitleLines(TITLE_REPLY).length).toBeGreaterThan(0);

    expect(sceneTitleLines("你们在晚上10:15到达了码头,海风很冷,吊机在夜空里摆动。")).toEqual([]);
    expect(sceneTitleLines("东京港 | 五号泊位")).toEqual([]);
    expect(sceneTitleLines(`东京港 | 深夜,${"很".repeat(140)}冷`)).toEqual([]);
    expect(sceneTitleLines("The corridor stretches on, silent and cold.")).toEqual([]);
  });

  test("a heading with both bookkeeping calls stands; with either missing it is stale", () => {
    const stale = row("stale_scene_hud");
    const scene = call("kp_note", { action: "set", category: "current_scene", content: "Pier 5" });
    const clock = call("game_clock", { action: "set", value: "22:15" });
    expect(checkHolds(stale, state(TITLE_REPLY))).toBe(true);
    expect(checkHolds(stale, state(TITLE_REPLY, [scene]))).toBe(true);
    expect(checkHolds(stale, state(TITLE_REPLY, [clock]))).toBe(true);
    expect(checkHolds(stale, state(TITLE_REPLY, [scene, clock]))).toBe(false);
    expect(checkHolds(stale, state(TITLE_REPLY, [call("kp_note", { action: "add", category: "current_scene" }), clock]))).toBe(true);
    expect(checkHolds(stale, state(TITLE_REPLY, [scene, call("game_clock", { action: "show" })]))).toBe(true);
    expect(checkHolds(stale, state(TITLE_REPLY, [scene, call("game_clock", { action: "advance", value: "+1 hour" })]))).toBe(false);
  });

  test("when a module owns the clock, its run_command is the clock bookkeeping", () => {
    const stale = row("stale_scene_hud");
    const scene = call("kp_note", { action: "set", category: "current_focus", content: "The pier" });
    const command = call("run_command", { command: "advance_watch" });
    expect(checkHolds(stale, state(TITLE_REPLY, [scene, command], [], true))).toBe(false);
    // Without a module clock, a module command is not clock bookkeeping.
    expect(checkHolds(stale, state(TITLE_REPLY, [scene, command], [], false))).toBe(true);
    // A command the module vetoed did nothing.
    expect(checkHolds(stale, state(TITLE_REPLY, [scene, call("run_command", {}, [], true)], [], true))).toBe(true);
    // The scene still has to be set.
    expect(checkHolds(stale, state(TITLE_REPLY, [command], [], true))).toBe(true);
  });
});

describe("lost narration", () => {
  test("compares sizes in both languages", () => {
    const check = row("narration_lost");
    const holds = (reply: string, ...texts: string[]): boolean => checkHolds(check, state(reply, [], texts));
    const zhScene =
      "账本用龟裂的小牛皮装订，书脊上是书记员挤在一起的字迹：一九一九到一九二四，一年一册，另有一本更薄的、没有标签。" +
      "你借着灯光一页页翻过去，管理员装作没在看你。数字怎么也对不上：上一页结转的金额到下一页就不见了；同一批麻绳记了两次，" +
      "价钱还不一样；一九二二年整整一个季度先用铅笔合计，又被另一只更重的手用墨水盖掉。钱在这里动过，有人替它遮掩过，" +
      "可每当你以为抓住了规律，它就又滑走了。";
    expect(holds("你合上账本，钟敲了四下。", zhScene)).toBe(true);
    expect(holds(CLOSING, ARCHIVE_SCENE)).toBe(true);

    expect(holds("Ok.", "Let me check the ledger rules first.")).toBe(false);
    expect(holds("好。", "我先查一下账本相关的设定，再推进时间。")).toBe(false);
    // The longest round counts, not the sum.
    expect(holds("Ok.", ...Array<string>(8).fill("Checking the next ledger before I narrate anything."))).toBe(false);
    // A reply that kept most of it stands.
    expect(holds(ARCHIVE_SCENE.slice(0, Math.floor((ARCHIVE_SCENE.length * 3) / 5)), ARCHIVE_SCENE)).toBe(false);
    expect(holds("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The table is data, and the engine owns its ceiling
// ---------------------------------------------------------------------------

function packRow(condition: string, extra: Partial<Omit<TurnCheck, "instruction">> & { instruction?: [string, string][] } = {}): TurnCheck {
  return {
    id: extra.id ?? null,
    condition,
    instruction: new FrozenMap(extra.instruction ?? []),
    maxRounds: extra.maxRounds ?? null,
    enabled: extra.enabled ?? true,
  };
}

function pack(...rows: TurnCheck[]): { turnChecks: readonly TurnCheck[] } {
  return { turnChecks: rows };
}

describe("turnChecksFor", () => {
  test("a pack without a table gets the engine's", () => {
    expect(turnChecksFor(null).map((check) => check.condition)).toEqual(["narration_lost", "dice_forged", "dice_contradicts", "stale_scene_hud"]);
    expect(turnChecksFor(pack())).toBe(DEFAULT_TURN_CHECKS);
    expect(DEFAULT_TURN_CHECKS.map((check) => check.maxRounds)).toEqual([1, 2, 1, 2]);
  });

  test("a pack may reword, reorder and shorten", () => {
    const table = turnChecksFor(pack(packRow("stale_scene_hud", { maxRounds: 1 }), packRow("dice_forged", { instruction: [["en", "Roll it. Now."]], maxRounds: 2 })));
    expect(table.map((check) => check.condition)).toEqual(["stale_scene_hud", "dice_forged"]);
    expect(table[0]?.maxRounds).toBe(1);
    expect(checkInstruction(table[1] as TurnCheckRow, "en", {})).toBe("Roll it. Now.");
    // The pack's English stands in for a language it did not write.
    expect(checkInstruction(table[1] as TurnCheckRow, "zh-CN", {})).toBe("Roll it. Now.");
  });

  test("a pack that tries to LOOSEN a row is ignored: caps never exceed the engine's", () => {
    expect(turnChecksFor(pack(packRow("dice_forged", { maxRounds: 99 })))[0]?.maxRounds).toBe(2);
    expect(turnChecksFor(pack(packRow("narration_lost", { maxRounds: 3 })))[0]?.maxRounds).toBe(1);
    expect(turnChecksFor(pack(packRow("dice_contradicts", { maxRounds: MAX_ROUNDS_PER_CHECK })))[0]?.maxRounds).toBe(1);
    // A row that names no cap keeps the engine's, not a looser default.
    expect(turnChecksFor(pack(packRow("narration_lost")))[0]?.maxRounds).toBe(1);
    // Naming a condition twice would double its rounds: the first row decides.
    const twice = turnChecksFor(pack(packRow("dice_forged", { id: "first" }), packRow("dice_forged", { id: "second" })));
    expect(twice.map((check) => check.id)).toEqual(["first"]);
    const disabledFirst = turnChecksFor(pack(packRow("dice_forged", { enabled: false }), packRow("dice_forged")));
    expect(disabledFirst).toEqual([]);
    for (const check of turnChecksFor(pack(...DEFAULT_TURN_CHECKS.map((engine) => packRow(engine.condition, { maxRounds: 99 }))))) {
      expect(check.maxRounds).toBeLessThanOrEqual(row(check.condition).maxRounds);
    }
  });

  test("a pack may drop a check but not invent a condition", () => {
    const table = turnChecksFor(pack(packRow("dice_forged", { enabled: false }), packRow("vibe_check"), packRow("dice_contradicts")));
    expect(table.map((check) => check.condition)).toEqual(["dice_contradicts"]);
    expect(table[0]?.id).toBe("dice_contradicts");
  });

  test("an instruction that is only whitespace leaves the engine's text", () => {
    const table = turnChecksFor(pack(packRow("dice_forged", { instruction: [["en", "   "]] })));
    expect(checkInstruction(table[0] as TurnCheckRow, "en", {})).toBe(turnText("en", "loop.check.dice_forged"));
  });
});

describe("instructions", () => {
  test("the engine's text in the room's language, with the fields filled", () => {
    const text = checkInstruction(row("dice_contradicts"), "zh", { rolled: "42, 65" });
    expect(text).toContain("42, 65");
    expect(text).toContain("运行时检查");
    expect(checkInstruction(row("stale_scene_hud"), "en", { title: "Pier 5 | 10 pm" })).toContain('"Pier 5 | 10 pm"');
  });
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

interface Recorded {
  readonly messages: readonly ChatMessage[];
  readonly check: string;
}

function reply(content: string, usage?: Usage): CheckAskOutcome {
  return usage === undefined ? { kind: "reply", content } : { kind: "reply", content, usage };
}

function tools(content: string, calls: TurnToolCall[], usage?: Usage): CheckAskOutcome {
  const assistant: ChatMessage = {
    role: "assistant",
    content,
    toolCalls: calls.map((made, index) => ({ id: `c${index}`, name: made.name, input: { valid: true, value: made.args ?? {} } })),
  };
  const results: ChatMessage[] = calls.map((made, index) => ({ role: "tool", toolCallId: `c${index}`, content: `${made.name} ok` }));
  return { kind: "tools", content, messages: [assistant, ...results], calls, ...(usage === undefined ? {} : { usage }) };
}

/** An `ask` that answers from a script (then from `rest`), recording every request. */
function scripted(script: CheckAskOutcome[], rest?: () => CheckAskOutcome): { ask: CheckAsk; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const queue = [...script];
  const ask: CheckAsk = async (messages, meta) => {
    seen.push({ messages, check: meta.check });
    const next = queue.shift() ?? rest?.();
    if (next === undefined) throw new Error("script exhausted");
    return next;
  };
  return { ask, seen };
}

const HEAD: ChatMessage = { role: "system", content: "You are the Keeper.", cacheBreakpoint: true };

function run(initial: TurnState, ask: CheckAsk, checks: readonly TurnCheckRow[] = DEFAULT_TURN_CHECKS, messages: readonly ChatMessage[] = [HEAD, { role: "user", content: "I act." }]) {
  return runTurnChecks({ checks, state: initial, messages, locale: "en", ask });
}

function lastContent(recorded: Recorded | undefined): string {
  return recorded?.messages[recorded.messages.length - 1]?.content ?? "";
}

describe("runTurnChecks", () => {
  test("a forged roll is refused, rolled for real and renarrated", async () => {
    const { ask, seen } = scripted([tools("", [call("skill_check", { skill_name: "Spot Hidden" }, [dice(42, 65)])]), reply("Your eye catches the loose panel behind the crates.")]);
    const result = await run(state("Spot Hidden — 22 vs 25. You find nothing."), ask);
    expect(diceRolled({ calls: result.calls, diceTools: DICE_TOOLS })).toBe(true);
    expect(result.reply).toBe("Your eye catches the loose panel behind the crates.");
    expect(replyStatesARoll(result.reply)).toBe(false);
    expect(seen.map((item) => item.check)).toEqual(["dice_forged", "dice_forged"]);
  });

  test("it re-verifies instead of asking once", async () => {
    const { ask, seen } = scripted([reply("Fine: 31 vs 25 — you still fail."), reply("The lock does not give.")]);
    const result = await run(state("22 vs 25 — you fail."), ask);
    expect(seen).toHaveLength(2);
    expect(result.reply).toBe("The lock does not give.");
    expect(result.asked).toEqual(["dice_forged", "dice_forged"]);
  });

  test("it is bounded and keeps the last reply it got", async () => {
    const forever = "22 vs 25 — you fail.";
    const { ask, seen } = scripted([], () => reply(forever));
    const result = await run(state(forever), ask);
    expect(result.reply).toBe(forever);
    expect(seen.length).toBeLessThanOrEqual(MAX_ROUNDS_PER_TURN);
    expect(seen).toHaveLength(2);
  });

  test("a tool round inside a row is not the end of it", async () => {
    const { ask } = scripted([tools("", [call("skill_check", {}, [dice(42, 65)])]), reply("You find the loose panel after all.")]);
    const result = await run(state("Spot Hidden — 99 vs 25. You fail badly."), ask);
    expect(result.reply).toBe("You find the loose panel after all.");
  });

  test("a clean reply runs no checks at all", async () => {
    const { ask, seen } = scripted([]);
    const result = await run(state("The rain keeps on, and the street stays empty."), ask);
    expect(seen).toEqual([]);
    expect(result.asked).toEqual([]);
    expect(result.reply).toBe("The rain keeps on, and the street stays empty.");
  });

  test("a turn that rolled and kept numbers out of prose runs no checks", async () => {
    const { ask, seen } = scripted([]);
    await run(state("Your eye catches the loose panel behind the crates.", rolledCalls()), ask);
    expect(seen).toEqual([]);
  });

  test("a provider failure keeps the reply", async () => {
    const { ask } = scripted([{ kind: "failed" }]);
    const result = await run(state("22 vs 25 — you fail."), ask);
    expect(result.reply).toBe("22 vs 25 — you fail.");
    expect(result.failed).toBe(true);
    expect(result.asked).toEqual([]);
  });

  test("what `ask` throws propagates", async () => {
    const ask: CheckAsk = async () => {
      throw new Error("aborted");
    };
    await expect(run(state("22 vs 25 — you fail."), ask)).rejects.toThrow("aborted");
  });

  test("a scene heading without bookkeeping is refused until the tools run", async () => {
    const { ask } = scripted([
      tools("", [call("kp_note", { action: "set", category: "current_scene", content: "Pier 5" }), call("game_clock", { action: "set", value: "22:15" })]),
      reply(`${TITLE_REPLY}\nThe HUD now agrees with the fiction.`),
    ]);
    const result = await run(state(TITLE_REPLY), ask);
    expect(result.calls.map((made) => made.name)).toEqual(["kp_note", "game_clock"]);
    expect(result.reply).toContain("HUD now agrees");
  });

  test("a scene heading with bookkeeping already done is left alone", async () => {
    const { ask, seen } = scripted([]);
    await run(state(TITLE_REPLY, [call("kp_note", { action: "set", category: "current_scene" }), call("game_clock", { action: "set", value: "22:15" })]), ask);
    expect(seen).toEqual([]);
  });

  test("the check conversation reads the prefix the main loop already paid for", async () => {
    const messages: ChatMessage[] = [
      HEAD,
      { role: "user", content: "I pick the lock." },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "lookup_time", input: { valid: true, value: {} } }] },
      { role: "tool", toolCallId: "t1", content: "1926-03-15 14:00" },
    ];
    const { ask, seen } = scripted([reply("The lock holds.")]);
    await run(state("22 vs 25 — you fail.", [call("lookup_time")]), ask, DEFAULT_TURN_CHECKS, messages);
    const sent = seen[0]?.messages ?? [];
    expect(sent.some((message) => message.role === "tool")).toBe(false);
    expect(sent.some((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)).toBe(false);
    // The stable head is the same object, cache mark and all.
    expect(sent[0]).toBe(HEAD);
    expect(sent.slice(-2)).toEqual([
      { role: "assistant", content: "22 vs 25 — you fail." },
      { role: "user", content: turnText("en", "loop.check.dice_forged") },
    ]);
  });

  test("correctionBaseMessages keeps an assistant message whose tool list is empty", () => {
    const plain: ChatMessage = { role: "assistant", content: "Earlier reply.", toolCalls: [] };
    expect(correctionBaseMessages([HEAD, plain])).toEqual([HEAD, plain]);
  });

  test("a scene narrated beside the bookkeeping is handed back and restored", async () => {
    const { ask, seen } = scripted([reply(FULL_SCENE)]);
    const result = await run(state(CLOSING, bookkeepingCalls(), [ARCHIVE_SCENE]), ask);
    expect(result.reply).toBe(FULL_SCENE);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages.at(-1)?.role).toBe("user");
    expect(lastContent(seen[0])).toContain(ARCHIVE_SCENE);
    expect(result.calls.map((made) => made.name)).toEqual(["game_clock", "kp_note"]);
    // The probe names the row that asked.
    expect(result.asked).toEqual(["narration_lost"]);
  });

  test("the narration check asks once and keeps what it gets", async () => {
    const { ask, seen } = scripted([reply("You leave.")]);
    const result = await run(state(CLOSING, bookkeepingCalls(), [ARCHIVE_SCENE]), ask);
    expect(result.reply).toBe("You leave.");
    expect(seen).toHaveLength(1);
  });

  test("interim chatter beside a tool call costs no extra round", async () => {
    const chatter = scripted([]);
    await run(state(CLOSING, bookkeepingCalls(), ["Let me note the time and the ledger finding first."]), chatter.ask);
    expect(chatter.seen).toEqual([]);

    const repeated = scripted([]);
    const kept = await run(state(FULL_SCENE, bookkeepingCalls(), [ARCHIVE_SCENE]), repeated.ask);
    expect(repeated.seen).toEqual([]);
    expect(kept.reply).toBe(FULL_SCENE);

    // Positive control: the same scene dropped, and the row is live.
    const dropped = scripted([reply(FULL_SCENE)]);
    await run(state(CLOSING, bookkeepingCalls(), [ARCHIVE_SCENE]), dropped.ask);
    expect(dropped.seen).toHaveLength(1);
  });

  test("a check round's own text counts for the rows after it", async () => {
    const table = [row("stale_scene_hud"), row("narration_lost")];
    const { ask, seen } = scripted([
      tools(ARCHIVE_SCENE, [call("kp_note", { action: "set", category: "current_scene", content: "Pier 5" }), call("game_clock", { action: "set", value: "22:15" })]),
      reply("The HUD agrees now."),
      reply(FULL_SCENE),
    ]);
    const result = await run(state(TITLE_REPLY), ask, table);
    expect(result.reply).toBe(FULL_SCENE);
    expect(lastContent(seen.at(-1))).toContain(ARCHIVE_SCENE);
    expect(result.asked).toEqual(["stale_scene_hud", "stale_scene_hud", "narration_lost"]);
  });

  test("a one-round row answered with a tool call still gets its narration (exactly one extra round)", async () => {
    const { ask, seen } = scripted([tools(FULL_SCENE, bookkeepingCalls()), reply(FULL_SCENE)]);
    const result = await run(state(CLOSING, bookkeepingCalls(), [ARCHIVE_SCENE]), ask);
    expect(result.reply).toBe(FULL_SCENE);
    expect(seen).toHaveLength(2);
    // The narration ask hands back what the tool round wrote.
    expect(lastContent(seen[1])).toContain(FULL_SCENE);
    // ...after the tool round's messages, which stay in the conversation.
    expect(seen[1]?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("a model that keeps calling tools gets one round past the cap, and the turn cap is the hard stop", async () => {
    const forgedClose = `${CLOSING} You rolled 47 versus 65.`;
    const { ask } = scripted([], () => tools("Noted again.", bookkeepingCalls()));
    const result = await run(state(forgedClose, bookkeepingCalls(), [ARCHIVE_SCENE]), ask);
    expect(result.reply).toBe(forgedClose);
    expect(result.asked.slice(0, 2)).toEqual(["narration_lost", "narration_lost"]);
    expect(result.asked.filter((id) => id === "narration_lost")).toHaveLength(2);
    expect(result.asked).toContain("dice_forged");
    expect(result.asked).toHaveLength(MAX_ROUNDS_PER_TURN);
    expect(result.asked).toEqual(["narration_lost", "narration_lost", "dice_forged", "dice_forged", "dice_forged"]);
  });

  test("check-round usage is reported on its own: output sums, the prompt is the last round's", async () => {
    const { ask } = scripted([
      tools("", [call("skill_check", {}, [dice(42, 65)])], { inputTokens: 900, outputTokens: 12, cachedInputTokens: 800 }),
      reply("You find nothing.", { inputTokens: 950, outputTokens: 30 }),
    ]);
    const result = await run(state("22 vs 25 — you fail."), ask);
    expect(result.usage).toEqual({ inputTokens: 950, outputTokens: 42, estimated: false });
  });

  test("the input state is not modified", async () => {
    const initial = state("22 vs 25 — you fail.", [call("lookup_time")], ["note"]);
    const { ask } = scripted([tools("", [call("skill_check", {}, [dice(1)])]), reply("Done.")]);
    await run(initial, ask);
    expect(initial.calls).toHaveLength(1);
    expect(initial.toolRoundTexts).toEqual(["note"]);
  });

  test("a pack's wording is what the model is sent", async () => {
    const table = turnChecksFor(pack(packRow("dice_forged", { id: "house_rule", instruction: [["en", "Roll it. Now."]] })));
    const { ask, seen } = scripted([reply("The lock holds.")]);
    const result = await run(state("22 vs 25 — you fail."), ask, table);
    expect(lastContent(seen[0])).toBe("Roll it. Now.");
    expect(result.asked).toEqual(["house_rule"]);
  });
});
