/**
 * Rule subsystems: the extra mechanics a pack declares beyond the basic check, each an
 * instance of a small closed set of templates (see `spec.ts`), run as PURE functions:
 *
 *   (pack, subsystem id, the sheet(s), the arguments, a RandomSource) → result
 *
 * A result is data: the dice rolled (the dice engine's own results), the graded outcome,
 * the numbers and flags a caller needs to narrate it, and the sheet with the changes
 * applied (written through the sheet layer; a refused write is reported, never
 * swallowed). A request the rules turn down comes back as `ok: false` with a `refusal`
 * code and its facts, having consumed no randomness wherever the refusal can be known
 * before rolling. Nothing is stored and no text is produced: localizing labels and keeping
 * the session record are the caller's.
 */

import type { RandomSource } from "../random.ts";
import type { RulePack } from "../rulepacks/types.ts";
import { SubsystemCallError } from "./common.ts";
import { runTableDraw, type TableDrawRefusal, type TableDrawRequest, type TableDrawResult } from "./draw.ts";
import { type ImprovementRefusal, type ImprovementRequest, type ImprovementResult, runImprovementCheck } from "./improvement.ts";
import { type LossCheckRefusal, type LossCheckRequest, type LossCheckResult, runLossCheck } from "./loss.ts";
import { type OpposedRefusal, type OpposedRequest, type OpposedResult, runOpposedCheck } from "./opposed.ts";
import { runResourceSpend, type SpendRefusal, type SpendRequest, type SpendResult } from "./spend.ts";

export { lookupStat, type StatLookup, SubsystemCallError, type SubsystemCallErrorCode } from "./common.ts";
export { findTable, runTableDraw, type TableDrawRefusal, type TableDrawRequest, type TableDrawResult } from "./draw.ts";
export { type ImprovementRefusal, type ImprovementRequest, type ImprovementResult, runImprovementCheck } from "./improvement.ts";
export { type LossCheckRefusal, type LossCheckRequest, type LossCheckResult, lossMaximum, runLossCheck } from "./loss.ts";
export { type OpposedRefusal, type OpposedRequest, type OpposedResult, type OpposedSide, type OpposedSideResult, runOpposedCheck, type Side } from "./opposed.ts";
export {
  type CheckWithLossSpec,
  compileSubsystems,
  type DrawTable,
  type ImprovementCheckSpec,
  type LossCeiling,
  localizedName,
  MAX_SUBSYSTEMS,
  MAX_TABLE_ENTRIES,
  type OpposedSpec,
  RESERVED_SUBSYSTEM_NAMES,
  type ResourceSpendSpec,
  SUBSYSTEM_TEMPLATES,
  type SubsystemSpec,
  type SubsystemTemplate,
  type TableDrawSpec,
} from "./spec.ts";
export { type RecordedCheck, runResourceSpend, type SpendRefusal, type SpendRequest, type SpendResult } from "./spend.ts";

/** A request for any subsystem, tagged with the template it is for. */
export type SubsystemRequest =
  | ({ readonly template: "check_with_loss" } & LossCheckRequest)
  | ({ readonly template: "improvement_check" } & ImprovementRequest)
  | ({ readonly template: "resource_spend_adjust" } & SpendRequest)
  | ({ readonly template: "opposed" } & OpposedRequest)
  | ({ readonly template: "table_draw" } & TableDrawRequest);

export type SubsystemOutcome =
  | LossCheckResult
  | LossCheckRefusal
  | ImprovementResult
  | ImprovementRefusal
  | SpendResult
  | SpendRefusal
  | OpposedResult
  | OpposedRefusal
  | TableDrawResult
  | TableDrawRefusal;

/**
 * Runs the subsystem `id` of `pack`. The request's `template` must be the one the pack
 * bound the subsystem to (`SubsystemCallError` otherwise, as for an undeclared id).
 */
export function runSubsystem(pack: RulePack, id: string, request: SubsystemRequest, random: RandomSource): SubsystemOutcome {
  const spec = pack.subsystems.get(id);
  if (spec === undefined) throw new SubsystemCallError("UNKNOWN_SUBSYSTEM", pack.id, id, "not declared by this pack");
  if (spec.template !== request.template) throw new SubsystemCallError("WRONG_TEMPLATE", pack.id, id, `bound to ${spec.template}, called as ${request.template}`);
  switch (request.template) {
    case "check_with_loss":
      return runLossCheck(pack, id, request, random);
    case "improvement_check":
      return runImprovementCheck(pack, id, request, random);
    case "resource_spend_adjust":
      return runResourceSpend(pack, id, request);
    case "opposed":
      return runOpposedCheck(pack, id, request, random);
    case "table_draw":
      return runTableDraw(pack, id, request, random);
  }
}
