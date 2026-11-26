// Who a view is computed for: the member, their language, and the character they play.
import type { Role } from "loreweaver-protocol/v3";
import type { Who } from "loreweaver/module";

import type { Services } from "../../agent/context.ts";
import type { Viewer } from "../../core/documents/index.ts";
import { whoIn } from "../commands/index.ts";

export interface ViewMemberInfo {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
}

/**
 * The viewer of a view. `locale` is the viewer's own language: names and labels in a view
 * are resolved in it (decision 32 — views are per viewer, only events are in the room's).
 */
export interface ViewerContext {
  readonly member: ViewMemberInfo;
  readonly locale: string;
  /** The character the member plays (the seating's answer), or null for a spectator. */
  readonly character: { readonly id: string; readonly name: string } | null;
}

/** The viewer `member` is in `room` now: the seating gives their character. */
export function viewerContext(services: Services, room: string, member: ViewMemberInfo, locale: string): ViewerContext {
  const who = whoIn(services, room, member, locale);
  return { member: { id: member.id, name: member.name, role: member.role }, locale, character: who.character };
}

/**
 * Viewers with the same key see the same value of every view: the same person, with the
 * same role, language and character. Several connections of one member share one
 * computation.
 */
export function viewerKey(viewer: ViewerContext): string {
  return JSON.stringify([viewer.member.id, viewer.member.role, viewer.locale, viewer.character?.id ?? null]);
}

/** The projection viewer: the member's grade, their id, their language. */
export function projectionViewer(viewer: ViewerContext): Viewer {
  const role = viewer.member.role;
  if (role === "observer") return { grade: "observer", locale: viewer.locale };
  return { grade: role, locale: viewer.locale, memberId: viewer.member.id };
}

/** The viewer as a module sees one (`dispatchRender`, `CommandRegistry.view`). */
export function whoOf(viewer: ViewerContext): Who {
  return { member: { id: viewer.member.id, name: viewer.member.name, role: viewer.member.role }, character: viewer.character };
}

/** One of each distinct viewer, in first-seen order. */
export function distinctViewers(viewers: Iterable<ViewerContext>): ViewerContext[] {
  const seen = new Map<string, ViewerContext>();
  for (const viewer of viewers) {
    const key = viewerKey(viewer);
    if (!seen.has(key)) seen.set(key, viewer);
  }
  return [...seen.values()];
}
