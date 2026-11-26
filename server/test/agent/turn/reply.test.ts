import { describe, expect, test } from "bun:test";

import { turnText } from "../../../src/agent/turn/catalog.ts";
import {
  type CommittedCall,
  failureCode,
  failureNotice,
  FINALIZER_OPTIONS,
  finalizerMessages,
  finalizerReply,
  maxRoundsFallback,
  publicCommittedResults,
  stripTextToolCalls,
  type TurnFailureCode,
} from "../../../src/agent/turn/reply.ts";
import { LLMError, type LLMErrorCode } from "../../../src/infra/llm/errors.ts";
import type { ChatMessage } from "../../../src/infra/llm/types.ts";

const LIVE_SAMPLE =
  "「你要看房子，拿去。用完挂回来。」\n\n" +
  "<Deep>\n<use>\n<name>mcp__oc__kp_note</name>\n" +
  '<args>{"action": "add", "content": "老周对问题沉默绕开（它不能说谎，只答非所问）。"}</args>\n' +
  "</use>\n</Deep>\n\n" +
  "那枚钥匙就悬在小窗口，黄纸签被门房的灯照得发脆。";

describe("stripTextToolCalls", () => {
  test("removes machinery blocks and keeps the narration", () => {
    const cleaned = stripTextToolCalls(LIVE_SAMPLE);
    expect(cleaned).not.toContain("<Deep>");
    expect(cleaned).not.toContain("mcp__");
    // The keeper note rode inside the fake call's arguments.
    expect(cleaned).not.toContain("不能说谎");
    expect(cleaned).toContain("你要看房子，拿去。用完挂回来。");
    expect(cleaned).toContain("黄纸签被门房的灯照得发脆");
    expect(cleaned).not.toMatch(/\n{3,}/);
  });

  test("leaves plain prose and decorative brackets alone, byte for byte", () => {
    const prose = "老周放下抹布。窗外雨声<忽然>密了一层。";
    expect(stripTextToolCalls(prose)).toBe(prose);
    const padded = "  Leading and trailing space stay when nothing is stripped.  \n";
    expect(stripTextToolCalls(padded)).toBe(padded);
  });

  test("a wrapper without tool-call markers is not machinery", () => {
    const text = "He hums <use>an old tune</use> under his breath.";
    expect(stripTextToolCalls(text)).toBe(text);
  });

  test("every wrapper tag, any case, with every marker", () => {
    for (const tag of ["Deep", "use", "tool_call", "tool_use", "function_call", "function_calls", "invoke", "INVOKE"]) {
      for (const marker of ["<name>x</name>", "< tool_name>", "<args>", "<arguments x=1>", "<parameter name='a'>", "mcp__srv__tool"]) {
        expect(stripTextToolCalls(`Before.<${tag} id="1">${marker} SECRET</${tag}>After.`)).toBe("Before.After.");
      }
    }
  });

  test("a tag name that merely starts with a wrapper's is not one", () => {
    // Python's `\b` after the name: `useful` is not `use`.
    const text = "<useful><name>x</name></useful>";
    expect(stripTextToolCalls(text)).toBe(text);
  });
});

const SECRET = "THE BUTLER POISONED THE WINE";

function committed(name: string, result: string, keeperOnly = false, suppressed = false): CommittedCall {
  return { name, result, keeperOnly, suppressed };
}

describe("the max-rounds fallback", () => {
  test("lists the public results and never a secret", () => {
    const calls = [committed("secret_truth", SECRET, true), committed("lookup_time", "  1926-03-15 14:00 ")];
    const text = maxRoundsFallback(calls, "en");
    expect(text).toContain(turnText("en", "loop.max_rounds"));
    expect(text).toContain("- lookup_time: 1926-03-15 14:00");
    expect(text).not.toContain(SECRET);
    expect(text).toBe(
      `${turnText("en", "loop.max_rounds")}\n\n${turnText("en", "loop.max_rounds_committed")}\n- lookup_time: 1926-03-15 14:00`,
    );
  });

  test("is localized", () => {
    const text = maxRoundsFallback([committed("lookup_time", "14:00")], "zh");
    expect(text).toContain(turnText("zh", "loop.max_rounds"));
    expect(text).not.toContain(turnText("en", "loop.max_rounds"));
    expect(text).toContain("- lookup_time：14:00");
  });

  test("says so when nothing public was committed", () => {
    expect(publicCommittedResults([committed("secret_truth", SECRET, true)], "en")).toBe(turnText("en", "loop.max_rounds_no_public_results"));
    expect(publicCommittedResults([], "zh")).toBe(turnText("zh", "loop.max_rounds_no_public_results"));
  });

  test("a call that did nothing is not a committed result", () => {
    expect(publicCommittedResults([committed("skill_check", "Refused by the module: VETO-REASON", false, true)], "en")).toBe(
      turnText("en", "loop.max_rounds_no_public_results"),
    );
  });

  test("marker: no keeper-only result reaches the fallback or the finalizer, in any mix", () => {
    const kinds: [boolean, boolean][] = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ];
    for (let mask = 0; mask < 4 ** 3; mask++) {
      const calls: CommittedCall[] = [];
      for (let slot = 0; slot < 3; slot++) {
        const [keeperOnly, suppressed] = kinds[Math.floor(mask / 4 ** slot) % 4] ?? [false, false];
        const marker = keeperOnly ? `KEEPER-MARKER-${slot}` : `PUBLIC-${slot}`;
        calls.push(committed(`tool_${slot}`, marker, keeperOnly, suppressed));
      }
      for (const locale of ["en", "zh"]) {
        const surfaces = [maxRoundsFallback(calls, locale), JSON.stringify(finalizerMessages([{ role: "user", content: "hi" }], calls, locale))];
        for (const surface of surfaces) {
          expect(surface).not.toContain("KEEPER-MARKER");
          for (const [slot, made] of calls.entries()) {
            if (!made.keeperOnly && !made.suppressed) expect(surface).toContain(`PUBLIC-${slot}`);
          }
        }
      }
    }
  });
});

describe("the max-rounds finalizer", () => {
  test("continues the turn without its tool rounds or cache marks, then asks for the closing narration", () => {
    const head: ChatMessage = { role: "system", content: "You are the Keeper.", cacheBreakpoint: true };
    const messages: ChatMessage[] = [
      head,
      { role: "user", content: "hi", cacheBreakpoint: true },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "secret_truth", input: { valid: true, value: {} } }] },
      { role: "tool", toolCallId: "a", content: SECRET },
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "lookup_time", input: { valid: true, value: {} } }] },
      { role: "tool", toolCallId: "b", content: "1926-03-15 14:00", cacheBreakpoint: true },
    ];
    const calls = [committed("secret_truth", SECRET, true), committed("lookup_time", "1926-03-15 14:00")];
    const convo = finalizerMessages(messages, calls, "en");
    expect(convo.slice(0, 2)).toEqual([
      { role: "system", content: "You are the Keeper." },
      { role: "user", content: "hi" },
    ]);
    expect(convo).toHaveLength(3);
    expect(convo.some((message) => "cacheBreakpoint" in message)).toBe(false);
    const last = convo[2];
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(turnText("en", "loop.max_rounds_finalize", { results: "- lookup_time: 1926-03-15 14:00" }));
    expect(JSON.stringify(convo)).not.toContain(SECRET);
    // The input is not modified.
    expect(head.cacheBreakpoint).toBe(true);
  });

  test("runs with tools disabled", () => {
    expect(FINALIZER_OPTIONS.tools).toEqual([]);
    expect(FINALIZER_OPTIONS.toolChoice).toBe("none");
  });

  test("its reply is trimmed; an empty one falls back", () => {
    expect(finalizerReply("  The clock settles at two.\n")).toBe("The clock settles at two.");
    expect(finalizerReply(" \n ")).toBeNull();
    expect(finalizerReply("")).toBeNull();
  });
});

describe("a failed provider call", () => {
  const table: [LLMErrorCode, boolean, TurnFailureCode][] = [
    ["auth", false, "provider_auth"],
    ["rate_limited", false, "provider_quota"],
    ["rate_limited", true, "provider_transient"],
    ["transient", true, "provider_transient"],
    ["bad_request", false, "provider_content"],
    ["context_overflow", false, "unavailable"],
    ["unknown", false, "unavailable"],
    ["aborted", false, "unavailable"],
  ];

  for (const [code, retryable, expected] of table) {
    test(`${code}${retryable ? " (retryable)" : ""} → ${expected}`, () => {
      const error = new LLMError({ code, retryable });
      expect(failureCode(error)).toBe(expected);
      for (const locale of ["en", "zh"]) {
        expect(failureNotice(error, locale)).toEqual({ level: "warn", code: expected, text: turnText(locale, `loop.${expected}`) });
      }
    });
  }

  test("anything that is not a classified provider error is 'momentarily unavailable'", () => {
    expect(failureNotice(new Error("gateway timeout"), "zh")).toEqual({ level: "warn", code: "unavailable", text: turnText("zh", "loop.unavailable") });
    expect(failureCode("boom")).toBe("unavailable");
  });

  test("the five texts are distinct in both languages", () => {
    for (const locale of ["en", "zh"]) {
      const texts = ["provider_auth", "provider_quota", "provider_transient", "provider_content", "unavailable"].map((key) => turnText(locale, `loop.${key}`));
      expect(new Set(texts).size).toBe(5);
      for (const text of texts) expect(text.startsWith("loop.")).toBe(false);
    }
  });
});
