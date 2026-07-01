import { render, screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { ErrorBoundary } from "./ErrorBoundary"

function Boom(): never {
  throw new Error("render exploded")
}

describe("ErrorBoundary", () => {
  test("renders a fallback instead of a blank screen when a child throws", () => {
    // React re-throws to console.error while committing the boundary; silence it
    // so the intentional error doesn't pollute the test output.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByRole("alert")).toBeTruthy()
    expect(screen.getByText("Something went wrong.")).toBeTruthy()

    spy.mockRestore()
  })

  test("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    )

    expect(screen.getByText("all good")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
