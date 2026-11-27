// The one way UI reads state: the protocol session's snapshot and the connection's own state,
// each through `useSyncExternalStore`. No component keeps a copy of either.
import { useEffect, useRef, useSyncExternalStore } from "react"
import { builtInView, panelViewNames, type BuiltInViewName, type BuiltInViews, type PanelEntry, type SessionSnapshot } from "loreweaver-protocol/v3"
import type { AudioController, AudioLocalState } from "./audio"
import { CLIENT_VIEWS, type Connection, type ConnectionState } from "./connection"

export function useSnapshot(connection: Connection): SessionSnapshot {
  return useSyncExternalStore(connection.session.subscribe, connection.session.getSnapshot)
}

export function useConnectionState(connection: Connection): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getState)
}

const NO_AUDIO: AudioLocalState = { muted: false, noPlayer: false }
const noSubscription = (): (() => void) => () => undefined

/** The sound controller's own state (muted, no player); the defaults when there is none. */
export function useAudioState(audio: AudioController | undefined): AudioLocalState {
  return useSyncExternalStore(audio?.subscribe ?? noSubscription, audio?.getState ?? (() => NO_AUDIO))
}

/** A built-in view's latest value, or null until it arrives (or when it was refused). */
export function viewData<K extends BuiltInViewName>(snapshot: SessionSnapshot, name: K): BuiltInViews[K] | null {
  return builtInView(snapshot, name)?.data ?? null
}

/** The views panels read beyond the ones the client always shows, sorted (a stable key). */
export function panelViews(panels: readonly PanelEntry[]): string[] {
  const always = new Set<string>(CLIENT_VIEWS)
  return [...new Set(panels.flatMap((panel) => panelViewNames(panel)))].filter((name) => !always.has(name)).sort()
}

/**
 * Keep the session subscribed to the views the listed panels read: subscribe to the new ones,
 * unsubscribe from those no panel reads any more. Only the NAMES are kept here; the values
 * live in the session snapshot, which re-subscribes them on every reconnect.
 */
export function usePanelViews(connection: Connection, panels: readonly PanelEntry[]): void {
  const held = useRef<ReadonlySet<string>>(new Set())
  const wanted = panelViews(panels)
  const key = wanted.join("\n")
  useEffect(() => {
    const next = new Set(wanted)
    const added = wanted.filter((name) => !held.current.has(name))
    const dropped = [...held.current].filter((name) => !next.has(name))
    held.current = next
    if (added.length > 0) void connection.session.viewSubscribe(added).catch(() => undefined)
    if (dropped.length > 0) void connection.session.viewUnsubscribe(dropped).catch(() => undefined)
  }, [key])
}

/**
 * Keep the session subscribed to the named views for as long as the calling component is
 * mounted, and drop them (and their values) when it unmounts. The admin screens use it for the
 * `admin/*` views: they are subscribed only while the screen is open, and only by an admin —
 * pass no names for anyone else. Only the NAMES are held here; the values live in the snapshot.
 */
export function useViews(connection: Connection, names: readonly string[]): void {
  const key = names.join("\n")
  useEffect(() => {
    if (names.length === 0) return
    const held = [...names]
    void connection.session.viewSubscribe(held).catch(() => undefined)
    return () => {
      void connection.session.viewUnsubscribe(held).catch(() => undefined)
    }
  }, [connection, key])
}
