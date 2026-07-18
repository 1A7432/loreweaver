/** Shared terminal-width policy for the primary OpenTUI screens. */
export const SIDEBAR_COLLAPSE_WIDTH = 96

export interface HeaderVisibility {
  usage: boolean
  cache: boolean
  clock: boolean
  scene: boolean
}

/**
 * Preserve room identity and online state at every width. Metadata disappears in
 * product-priority order as horizontal space gets tight.
 */
export function headerVisibility(width: number): HeaderVisibility {
  return {
    usage: width >= 118,
    cache: width >= 104,
    clock: width >= 94,
    scene: width >= 84,
  }
}

export function sidebarCollapsed(width: number): boolean {
  return width < SIDEBAR_COLLAPSE_WIDTH
}

export function sidebarWidth(width: number): number {
  return Math.min(32, Math.max(24, Math.floor(width * 0.4)))
}
