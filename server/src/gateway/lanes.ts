// The work that follows a Keeper turn off the lock (§12 3.2 step 14, and the lanes table's
// "提交方式" row): the Scribe, then — on a beat, with the Director on and a presentation
// kit — the Stage Director. One pass runs per room at a time, on the room's ordered chain
// (`chain.ts`); nothing waits for it.
//
// Everything a pass reads from the room is read when it is SCHEDULED, synchronously, under
// the lock: the Scribe's snapshot, the kit, the picture bookkeeping, the room as the module
// veto sees it. Everything it writes goes through the context of the turn it follows —
// never a fresh one — and commits in one synchronous block that refuses when the room has
// moved to another generation since; a refused commit ends the pass quietly.
import type { SignalPayloads } from "loreweaver-protocol/v3";
import type { RoomSnapshot } from "loreweaver/module";

import type { RoomContext } from "../agent/context.ts";
import {
  commitDirector,
  computeDirector,
  type DirectorImageDeps,
  type DirectorImageState,
  type DirectorSettings,
  renderDirectorImage,
  type RenderedImage,
} from "../agent/lanes/director.ts";
import type { RoomKit } from "../agent/lanes/presentation.ts";
import { allowAllScribeOps, allowedScribeOps, commitScribe, computeScribe, type ScribeSnapshot, scribeVetoCalls } from "../agent/lanes/scribe.ts";
import { dispatchToolUse } from "../agent/modules.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import type { StoredEvent } from "../infra/store.ts";
import { runAsWork } from "./keeper.ts";

/** The deployment's switches for the after-turn lanes. */
export interface LaneSettings {
  /** False: no Scribe pass (and so no Stage Director, which stages the Scribe's beats). */
  readonly scribe: boolean;
  /** False: beats are not staged. */
  readonly director: boolean;
  /** Pictures: on or off, the story's budget, how many to warm per beat. */
  readonly directorSettings: DirectorSettings;
}

export const LANES_OFF: LaneSettings = { scribe: false, director: false, directorSettings: { imagesEnabled: false, maxImages: 0, pregenPerBeat: 0 } };

/** One pass, as it was scheduled. */
export interface LanePass {
  /** The context of the turn the pass follows. */
  readonly context: RoomContext;
  readonly scribe: ScribeSnapshot;
  /** What the player said and what the Keeper replied (both already shown). */
  readonly player: string;
  readonly reply: string;
  /** The room as the module veto is shown it. */
  readonly vetoRoom: RoomSnapshot;
  /** The Director's material; null when the Director will not run for this turn. */
  readonly director: { readonly kit: RoomKit; readonly images: DirectorImageState } | null;
}

/** What a pass asks of the room. */
export interface LaneRoom {
  readonly settings: LaneSettings;
  /** The image client and media store; null: a generate plan shows nothing new. */
  readonly images: DirectorImageDeps | null;
  moduleWorker(): RoomWorker | null;
  /** Recompute the views after a commit (queued with every other refresh). */
  refreshViews(): Promise<void>;
  /** Send a logged event to the table. */
  broadcastEvent(event: StoredEvent): void;
  broadcastAudio(audio: SignalPayloads["audio"]): void;
  report(text: string): void;
}

const NOBODY = { member: null, character: null } as const;

/** Run one pass. Resolves when it is done or has stood down. */
export async function runLanePass(pass: LanePass, room: LaneRoom): Promise<"done" | "stale"> {
  const { context } = pass;
  const services = context.services;
  const proposal = await computeScribe(pass.scribe, services);
  if (proposal.status !== "ok" && proposal.status !== "empty_reply") room.report(`scribe: ${proposal.status}`);

  // The module veto on the Scribe's writes: read-only, one exchange, and it fails open.
  let allowed = allowAllScribeOps(proposal);
  const worker = proposal.ops.length > 0 ? room.moduleWorker() : null;
  if (worker !== null) {
    const veto = await runAsWork(context.writer, () => dispatchToolUse(worker, { ...pass.vetoRoom, turn: context.turn, who: NOBODY, calls: scribeVetoCalls(proposal) }));
    for (const problem of veto.problems) room.report(problem);
    allowed = allowedScribeOps(proposal, veto.verdicts);
  }

  const committed = commitScribe(context, proposal, allowed);
  if (committed.status === "stale") return "stale";
  await room.refreshViews();

  if (committed.beat === null || pass.director === null || !room.settings.director) return "done";
  const staged = await computeDirector(
    {
      room: context.room,
      locale: context.locale,
      beat: committed.beat,
      player: pass.player,
      reply: pass.reply,
      views: services.views,
      kit: pass.director.kit,
      images: pass.director.images,
      settings: room.settings.directorSettings,
    },
    services.models.director,
  );
  if (staged.status !== "ok") room.report(`director: ${staged.status}`);
  let image: RenderedImage | null = null;
  if (staged.image.kind === "generate" && room.images !== null) {
    image = await renderDirectorImage(staged.image, room.images);
    if (image.status === "fallback") room.report(`director: picture fell back (${image.code})`);
  }
  const done = commitDirector(context, staged, image, { clock: services.clock });
  if (done.status === "stale") return "stale";
  if (done.event !== null) room.broadcastEvent(done.event);
  for (const audio of done.audio) room.broadcastAudio(audio);
  return "done";
}
