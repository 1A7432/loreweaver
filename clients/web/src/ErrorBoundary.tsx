import { Component, type ErrorInfo, type ReactNode } from "react"

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

// A last line of defense around the whole app. Untrusted server/player/Keeper
// content can, in principle, still slip a render error past the per-frame
// validation (e.g. an unexpected shape a component doesn't guard). Without a
// boundary, React unmounts the entire tree and the user sees a blank white
// screen. This catches the error and shows a stable fallback instead.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a trace for debugging; the UI itself stays on the stable fallback.
    console.error("ErrorBoundary caught a render error:", error, info)
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      this.props.fallback ?? (
        <div className="error-boundary" role="alert">
          <h1>Something went wrong.</h1>
          <p>The interface hit an unexpected error. Try reloading the page.</p>
        </div>
      )
    )
  }
}

export default ErrorBoundary
