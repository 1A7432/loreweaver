// The one way UI reads state: the protocol session's snapshot and the connection's own state,
// each through `useSyncExternalStore`. No component keeps a copy of either.
import { useSyncExternalStore } from "react"
import { builtInView, type BuiltInViewName, type BuiltInViews, type SessionSnapshot } from "loreweaver-protocol/v3"
import type { Connection, ConnectionState } from "./connection"

export function useSnapshot(connection: Connection): SessionSnapshot {
  return useSyncExternalStore(connection.session.subscribe, connection.session.getSnapshot)
}

export function useConnectionState(connection: Connection): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getState)
}

/** A built-in view's latest value, or null until it arrives (or when it was refused). */
export function viewData<K extends BuiltInViewName>(snapshot: SessionSnapshot, name: K): BuiltInViews[K] | null {
  return builtInView(snapshot, name)?.data ?? null
}
