import { describe, expect, test } from "bun:test"
import { CHAT_INPUT_LIMIT, inputLimitState } from "./inputLimits"

describe("chat input limit", () => {
  test("shows the counter from 80% and blocks the exact capacity", () => {
    expect(inputLimitState("x".repeat(3_199))).toEqual({ count: 3_199, showCounter: false, atLimit: false })
    expect(inputLimitState("x".repeat(3_200))).toEqual({ count: 3_200, showCounter: true, atLimit: false })
    expect(inputLimitState("x".repeat(CHAT_INPUT_LIMIT))).toEqual({
      count: CHAT_INPUT_LIMIT,
      showCounter: true,
      atLimit: true,
    })
  })
})
