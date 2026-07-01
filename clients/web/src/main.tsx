import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { ErrorBoundary } from "./ErrorBoundary"
import "./themes.css"

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("Missing #root element")

// Default theme is DF-16; the StatusBar theme picker overrides body[data-theme].
if (!document.body.dataset.theme) document.body.dataset.theme = "df16"

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
