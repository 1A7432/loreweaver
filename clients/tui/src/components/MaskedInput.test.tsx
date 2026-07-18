import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { themes } from "../themes"
import { MaskedInput } from "./MaskedInput"

function Harness({ initial, submitted }: { initial: string; submitted: string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <MaskedInput
      value={value}
      focused
      placeholder="invite key"
      maskedLabel="saved (masked)"
      theme={themes.lamplight}
      onInput={setValue}
      onSubmit={(text) => submitted.push(text ?? value)}
    />
  )
}

describe("MaskedInput", () => {
  test("never paints the credential but submits the native input value", async () => {
    const secret = "keeper-bearer-secret"
    const submitted: string[] = []
    const { renderer, flush, captureCharFrame, mockInput } = await testRender(
      <Harness initial={secret} submitted={submitted} />,
      { width: 80, height: 3 },
    )
    await flush()

    const frame = captureCharFrame()
    expect(frame).not.toContain(secret)
    expect(frame).toContain("••••••••••••")
    expect(frame).toContain("saved (masked)")

    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    expect(submitted).toEqual([secret])

    act(() => renderer.destroy())
  })
})
