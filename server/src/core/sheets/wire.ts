/**
 * The resource meters a client draws for a sheet (HP, sanity, fate…), in pack order.
 */

import { getHitPoints } from "./access.ts";
import { attributeSlot, evaluateSheet } from "./evaluate.ts";
import type { FormulaIssue } from "./formulas.ts";
import type { Sheet } from "./sheet.ts";
import type { SheetSpec } from "./spec.ts";
import { pickLabel } from "./text.ts";

export interface WireResource {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max: number;
}

export interface WireResources {
  readonly resources: readonly WireResource[];
  /** Failed derivations that kept a meter off the list. */
  readonly issues: readonly FormulaIssue[];
}

/**
 * The pack's resource meters for `sheet`, labelled for the VIEWER's `locale` (that
 * locale, else `en`, else the resource id), so one room can serve each client its own
 * language. An attribute-backed meter whose value or maximum the sheet does not have is
 * left out.
 */
export function wireResources(spec: SheetSpec, sheet: Sheet, locale: string | null | undefined): WireResources {
  const shape = spec.shape;
  if (shape === null || shape.resources.length === 0) return { resources: [], issues: [] };
  const evaluation = evaluateSheet(spec, sheet);
  const resources: WireResource[] = [];
  const issues: FormulaIssue[] = [];
  for (const resource of shape.resources) {
    const label = pickLabel(resource.labels, locale, resource.id);
    if (resource.source === "hit_points") {
      const hp = getHitPoints(spec, sheet, evaluation);
      if (hp.ok) resources.push(Object.freeze({ id: resource.id, label, value: hp.current, max: hp.max }));
      else issues.push(hp.issue);
      continue;
    }
    const value = attributeSlot(spec, sheet, evaluation, resource.valueKey);
    const max = attributeSlot(spec, sheet, evaluation, resource.maxKey);
    if (value.kind === "failed") issues.push(value.issue);
    if (max.kind === "failed") issues.push(max.issue);
    if (value.kind === "value" && max.kind === "value") {
      resources.push(Object.freeze({ id: resource.id, label, value: value.value, max: max.value }));
    }
  }
  return { resources: Object.freeze(resources), issues: Object.freeze(issues) };
}
