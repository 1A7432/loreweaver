import { describe, expect, test } from "bun:test";

import { DRAFT_FLUSH_CHARS, type DraftPayload, ReplyStreamGate, suspectHoldIndex } from "../../../src/agent/turn/gate.ts";

function gate(options: { failOn?: number } = {}): { gate: ReplyStreamGate; sent: DraftPayload[] } {
  const sent: DraftPayload[] = [];
  let ids = 0;
  let calls = 0;
  const instance = new ReplyStreamGate({
    emit: (draft) => {
      calls++;
      if (options.failOn !== undefined && calls >= options.failOn) throw new Error("transport closed");
      sent.push(draft);
    },
    newId: () => `d${++ids}`,
  });
  return { gate: instance, sent };
}

function shown(sent: readonly DraftPayload[], id?: string): string {
  return sent
    .filter((draft): draft is { id: string; text: string } => "text" in draft && (id === undefined || draft.id === id))
    .map((draft) => draft.text)
    .join("");
}

describe("ReplyStreamGate", () => {
  test("streams safe text and never releases machinery", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("雨声落在窗台上。老周抬起头。\n");
    g.feed("「你来了。」<De"); // a suspicious opener split across deltas
    g.feed('ep>\n<use><name>mcp__kp_note</name><args>{"secret": "它不能说谎"}</args></use>\n</Deep>');
    g.feed("他把抹布放下。");
    g.finishRound({ discard: false });

    const text = shown(sent);
    expect(text).toContain("雨声落在窗台上");
    expect(text).toContain("他把抹布放下。");
    expect(text).not.toContain("<Deep");
    expect(text).not.toContain("mcp__");
    expect(text).not.toContain("不能说谎");
    expect(new Set(sent.map((draft) => draft.id))).toEqual(new Set([g.id]));
  });

  test("holds an unclosed suspicious tail at the end of the round", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("正文安全部分。<UpdateVariable>_.set('真凶'"); // never closes
    g.finishRound({ discard: false });
    expect(shown(sent)).toBe("正文安全部分。");
  });

  test("an UpdateVariable block is never shown, closed or not", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("Safe.\n<UpdateVariable>_.set('culprit','the butler');</UpdateVariable>\nAfter.");
    g.finishRound({ discard: false });
    expect(shown(sent)).toBe("Safe.\n");
  });

  test("slices go out in order, one per line", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    for (const line of ["第一行。\n", "第二行。\n", "第三行。\n"]) g.feed(line);
    g.finishRound({ discard: false });
    expect(sent).toEqual([
      { id: "d2", text: "第一行。\n" },
      { id: "d2", text: "第二行。\n" },
      { id: "d2", text: "第三行。\n" },
    ]);
  });

  test("flushes at 48 characters, counted in code points", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("𝔸".repeat(DRAFT_FLUSH_CHARS - 1));
    expect(sent).toEqual([]);
    g.feed("𝔸");
    expect(shown(sent)).toBe("𝔸".repeat(DRAFT_FLUSH_CHARS));
  });

  test("a final round's remainder is released when the round ends", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("Short.");
    expect(sent).toEqual([]);
    g.finishRound({ discard: false });
    expect(shown(sent)).toBe("Short.");
  });

  test("a tool round's draft is discarded, and the next round drafts under a new id", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    const toolRound = g.id;
    g.feed("The archive is quiet.\nPei slides the ledger over.\n");
    g.finishRound({ discard: true });
    expect(sent.at(-1)).toEqual({ id: toolRound, discard: true });

    g.beginRound();
    expect(g.id).not.toBe(toolRound);
    g.feed("You see the struck-out line.");
    g.finishRound({ discard: false });
    expect(shown(sent, g.id)).toBe("You see the struck-out line.");
  });

  test("a tool round that showed nothing sends no discard", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("held");
    g.finishRound({ discard: true });
    expect(sent).toEqual([]);
  });

  test("a provider retry discards the draft and the retry streams under a fresh id", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    const first = g.id;
    g.feed("A first attempt that got cut off.\n");
    g.discard();
    expect(sent.at(-1)).toEqual({ id: first, discard: true });
    expect(g.id).not.toBe(first);
    g.feed("The second attempt.");
    g.finishRound({ discard: false });
    expect(shown(sent, g.id)).toBe("The second attempt.");
    expect(shown(sent, first)).toBe("A first attempt that got cut off.\n");
  });

  test("a retry before anything was shown sends nothing", () => {
    const { gate: g, sent } = gate();
    g.beginRound();
    g.feed("held back");
    g.discard();
    g.finishRound({ discard: false });
    expect(sent).toEqual([]);
  });

  test("text fed outside a round is never shown", () => {
    const { gate: g, sent } = gate();
    g.feed("before any round\n");
    g.beginRound();
    g.finishRound({ discard: false });
    g.feed("after the round\n");
    expect(sent).toEqual([]);
  });

  test("an emit that throws ends the round's drafting (fail closed)", () => {
    const { gate: g, sent } = gate({ failOn: 2 });
    g.beginRound();
    g.feed("Line one.\n");
    g.feed("Line two.\n");
    g.feed("Line three.\n");
    g.finishRound({ discard: false });
    expect(shown(sent)).toBe("Line one.\n");
  });

  test("a trailing '<' and a '<' into prose", () => {
    expect(suspectHoldIndex("abc <")).toBe(4);
    // Every name an update block may use is withheld from the stream, whole or still being typed.
    for (const tag of ["UpdateVariable", "VariableUpdate", "Update", "variableupdate", "Variab", "V"]) {
      expect([tag, suspectHoldIndex(`Hi <${tag}`)]).toEqual([tag, 3]);
      expect([tag, suspectHoldIndex(`Hi <${tag}>_.set('a', 1);</${tag}>`)]).toEqual([tag, 3]);
    }
    expect(suspectHoldIndex("abc <  ")).toBe(4);
    expect(suspectHoldIndex("3 < 4 and 5 > 2")).toBe("3 < 4 and 5 > 2".length);
    expect(suspectHoldIndex("老周<忽然>抬头")).toBe("老周<忽然>抬头".length);
    expect(suspectHoldIndex("x <b>bold</b>")).toBe("x <b>bold</b>".length);
    // A prefix of a suspect name holds; so does a longer name starting with one.
    expect(suspectHoldIndex("x <tool")).toBe(2);
    expect(suspectHoldIndex("x <user>")).toBe(2);
    expect(suspectHoldIndex("x < / Invoke")).toBe(2);
    // The slash of a closing tag whose name has not arrived yet.
    expect(suspectHoldIndex("x </")).toBe(2);
    expect(suspectHoldIndex("x < / ")).toBe(2);
  });
});

describe("the gate fails closed on every suspect prefix split anywhere", () => {
  const WRAPPERS = ["Deep", "use", "tool_call", "tool_use", "function_call", "function_calls", "invoke"];
  const cases: { name: string; text: string }[] = [];
  for (const tag of WRAPPERS) {
    cases.push({ name: `closed ${tag}`, text: `Safe prose.\n<${tag}><name>mcp__x</name><args>SECRET</args></${tag}>\nAfter.` });
    cases.push({ name: `unclosed ${tag}`, text: `Safe prose.\n<${tag}><name>kp_note</name><args>SECRET` });
  }
  cases.push({ name: "closed UpdateVariable", text: "Safe prose.\n<UpdateVariable>_.set('SECRET');</UpdateVariable>\nAfter." });
  cases.push({ name: "unclosed UpdateVariable", text: "Safe prose.\n<updatevariable>_.set('SECRET'" });
  cases.push({ name: "closing tag first", text: "Safe prose.\n</UpdateVariable SECRET" });

  function check(deltas: string[], withDiscard: boolean): void {
    const { gate: g, sent } = gate();
    g.beginRound();
    for (const delta of deltas) g.feed(delta);
    g.finishRound({ discard: withDiscard });
    const text = shown(sent);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("mcp__");
    expect(text).not.toContain("<");
    // The safe text is shown. (Whitespace at the edge of a held stretch can be lost when a
    // completed block is stripped — the reference's strip trims; the final event is whole.)
    if (!withDiscard) expect(text.replace(/\s/gu, "").startsWith("Safeprose.")).toBe(true);
  }

  for (const { name, text } of cases) {
    test(name, () => {
      const characters = Array.from(text);
      for (let cut = 1; cut < characters.length; cut++) {
        check([characters.slice(0, cut).join(""), characters.slice(cut).join("")], false);
        for (let second = cut + 1; second < characters.length; second += 3) {
          check([characters.slice(0, cut).join(""), characters.slice(cut, second).join(""), characters.slice(second).join("")], false);
        }
      }
      check(characters, false);
      check(characters, true);
    });
  }
});
