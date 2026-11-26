// The two variable kinds as documents, and who sees what of them (iron rule 3).
//
// `variable_tree` (one per room): the tree an imported world card declared, and which of
// its branches the admin exposed. Payload `{ tree: <JSON text>, exposed: [prefix, ...] }`
// — the tree is stored as order-preserving JSON TEXT because a plain object cannot keep
// number-like keys in written order (see `tree.ts`).
//   - keeper: every leaf, each flagged `exposed`, the whole tree, the exposure list;
//   - admin: every leaf, the unexposed ones flagged `hidden: true` (managing exposure is
//     the admin's job, so they see what is still hidden), the exposure list, and the
//     PLAYER-grade tree (a template renderer never reads a hidden branch);
//   - player, observer, an NPC actor: only exposed leaves and the pruned tree. Nothing
//     exposed (the default) means nothing at all.
//
// `module_variables` (one per room): the declared trackers.
// Payload `{ variables: [{ spec, value }, ...] }`, in declaration order.
//   - keeper: every variable;
//   - admin: every variable, keeper-only ones flagged `hidden: true`;
//   - player, observer, an NPC actor: only `player`-visibility variables, spec and value
//     — a keeper-only tracker leaves no trace (not even its id).
// Labels are resolved for the viewer's locale in every view.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { normalizeExposed, pathIsExposed, pruneToExposed } from "./exposure.ts";
import {
  labelFor,
  MAX_VARIABLES,
  moduleVariablesData,
  normalizeModuleVariables,
  normalizeSpec,
  optionLabelFor,
  type ModuleVariables,
  type VariableKind,
  type VariableValue,
} from "./modvars.ts";
import { decodeTree, encodeTree, flattenLeaves, type Leaf, type VarMap } from "./tree.ts";

export const VARIABLE_TREE_TYPE = "variable_tree";
export const VARIABLE_TREE_ID = "tree";
export const MODULE_VARIABLES_TYPE = "module_variables";
export const MODULE_VARIABLES_ID = "variables";

// ---------------------------------------------------------------------------
// variable_tree
// ---------------------------------------------------------------------------

export interface TreeLeafView extends Leaf {
  /** Keeper view: whether the leaf is on the players' panel. */
  readonly exposed?: boolean;
  /** Admin view: the leaf is not exposed (players do not see it). */
  readonly hidden?: boolean;
}

export interface VariableTreeView {
  readonly leaves: readonly TreeLeafView[];
  /** The tree as order-preserving JSON text (whole for the keeper, pruned otherwise). */
  readonly treeJson: string;
  /** The exposure prefixes (keeper and admin only). */
  readonly exposed?: readonly string[];
}

export interface StoredTree {
  readonly tree: VarMap;
  readonly exposed: readonly string[];
}

/** The payload for a tree and its exposure list. */
export function variableTreeData(tree: VarMap, exposed: readonly string[]): JsonObject {
  return { tree: encodeTree(tree), exposed: [...exposed] };
}

/** A stored payload read back; an unreadable tree reads as empty, an unreadable list as nothing exposed. */
export function readVariableTree(data: JsonObject): StoredTree {
  const tree = typeof data.tree === "string" ? decodeTree(data.tree) : null;
  return { tree: tree ?? new Map(), exposed: normalizeExposed(data.exposed) };
}

function projectTree(document: Document, viewer: Viewer): VariableTreeView {
  const { tree, exposed } = readVariableTree(document.data);
  const leaves = flattenLeaves(tree);
  if (viewer.grade === "keeper") {
    return { leaves: leaves.map((leaf) => ({ ...leaf, exposed: pathIsExposed(leaf.path, exposed) })), treeJson: encodeTree(tree), exposed };
  }
  const pruned = encodeTree(pruneToExposed(tree, exposed));
  if (viewer.grade === "admin" && viewer.actorId === undefined) {
    return { leaves: leaves.map((leaf) => (pathIsExposed(leaf.path, exposed) ? leaf : { ...leaf, hidden: true })), treeJson: pruned, exposed };
  }
  return { leaves: leaves.filter((leaf) => pathIsExposed(leaf.path, exposed)), treeJson: pruned };
}

function validateTree(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  if (typeof data.tree !== "string" || decodeTree(data.tree) === null) violations.push({ code: "bad_tree", path: "tree" });
  if (!Array.isArray(data.exposed)) violations.push({ code: "bad_exposed", path: "exposed" });
  else if (normalizeExposed(data.exposed).length !== data.exposed.length) violations.push({ code: "bad_exposed", path: "exposed" });
  return violations;
}

export const variableTreeDocument: DocumentType<VariableTreeView> = {
  name: VARIABLE_TREE_TYPE,
  // A reset of the whole room removes the imported world, and its variables with it.
  lifecycle: { reset: "all" },
  version: 1,
  project: projectTree,
  validate: validateTree,
};

// ---------------------------------------------------------------------------
// module_variables
// ---------------------------------------------------------------------------

export interface ModuleVariableView {
  readonly id: string;
  readonly kind: VariableKind;
  readonly label: string;
  readonly value: VariableValue;
  /** An enum value's display name, when the spec names it. */
  readonly valueLabel?: string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  /** Keeper view only. */
  readonly visibility?: "player" | "keeper";
  /** Admin view: a keeper-only variable (players do not see it). */
  readonly hidden?: boolean;
}

export interface ModuleVariablesView {
  readonly variables: readonly ModuleVariableView[];
}

function variableView(state: ModuleVariables["variables"][number], locale: string): ModuleVariableView {
  const { spec, value } = state;
  const valueLabel = optionLabelFor(spec, value, locale);
  return {
    id: spec.id,
    kind: spec.kind,
    label: labelFor(spec, locale),
    value,
    ...(valueLabel !== null ? { valueLabel } : {}),
    ...(spec.minimum !== undefined ? { min: spec.minimum } : {}),
    ...(spec.maximum !== undefined ? { max: spec.maximum } : {}),
    ...(spec.options !== undefined ? { options: [...spec.options] } : {}),
  };
}

function projectModuleVariables(document: Document, viewer: Viewer): ModuleVariablesView {
  const state = normalizeModuleVariables(document.data);
  if (viewer.grade === "keeper") {
    return { variables: state.variables.map((variable) => ({ ...variableView(variable, viewer.locale), visibility: variable.spec.visibility })) };
  }
  if (viewer.grade === "admin" && viewer.actorId === undefined) {
    return {
      variables: state.variables.map((variable) => {
        const view = variableView(variable, viewer.locale);
        return variable.spec.visibility === "keeper" ? { ...view, hidden: true } : view;
      }),
    };
  }
  return { variables: state.variables.filter((variable) => variable.spec.visibility === "player").map((variable) => variableView(variable, viewer.locale)) };
}

function validateModuleVariables(data: JsonObject): WriteViolation[] {
  if (!Array.isArray(data.variables)) return [{ code: "bad_variables", path: "variables" }];
  const violations: WriteViolation[] = [];
  const seen = new Set<string>();
  data.variables.forEach((item, index) => {
    const record = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as JsonObject) : null;
    const spec = record === null ? null : normalizeSpec(record.spec);
    if (spec === null) {
      violations.push({ code: "bad_spec", path: `variables.${index}.spec` });
      return;
    }
    if (seen.has(spec.id)) violations.push({ code: "duplicate_id", path: `variables.${index}.spec.id` });
    seen.add(spec.id);
    const normalized = normalizeModuleVariables({ variables: [record] }).variables[0];
    if (normalized === undefined || normalized.value !== record?.value) violations.push({ code: "bad_value", path: `variables.${index}.value` });
  });
  if (data.variables.length > MAX_VARIABLES) violations.push({ code: "too_many", path: "variables" });
  return violations;
}

export const moduleVariablesDocument: DocumentType<ModuleVariablesView> = {
  name: MODULE_VARIABLES_TYPE,
  // A reset of the whole room removes the imported world, and its variables with it.
  lifecycle: { reset: "all" },
  version: 1,
  project: projectModuleVariables,
  validate: validateModuleVariables,
};

/** The payload for a state (re-exported here so callers pair it with the type). */
export const moduleVariablesPayload = (state: ModuleVariables): JsonObject => moduleVariablesData(state) as unknown as JsonObject;
