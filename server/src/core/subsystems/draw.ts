/**
 * `table_draw`: one uniform draw (`1d<count>`) from a pack table. Entries are opaque game
 * data the pack wrote; the result carries the entry and its index.
 */

import { type Roll, rollDice } from "../dice/index.ts";
import type { RandomSource } from "../random.ts";
import type { RulePack } from "../rulepacks/types.ts";
import { foldCase, stripSpace } from "../sheets/text.ts";
import { subsystemOf } from "./common.ts";
import type { DrawTable, TableDrawSpec } from "./spec.ts";

export interface TableDrawRequest {
  /** A table id or alias (trimmed, case-insensitive); empty or absent = the pack's default table. */
  readonly table?: string | null;
}

export interface TableDrawRefusal {
  readonly ok: false;
  readonly subsystem: string;
  readonly refusal: "unknown_table";
  readonly table: string;
  /** The table ids the subsystem declares, in pack order. */
  readonly known: readonly string[];
}

export interface TableDrawResult {
  readonly ok: true;
  readonly subsystem: string;
  /** The table's id. */
  readonly table: string;
  readonly roll: Roll;
  /** 0-based index of the entry drawn. */
  readonly index: number;
  readonly entry: string;
}

/** The table a caller's reference names: by id, then by alias, in pack order. */
export function findTable(spec: TableDrawSpec, reference: string | null | undefined): DrawTable | null {
  const wanted = foldCase(stripSpace(reference ?? ""));
  const key = wanted === "" ? spec.defaultTable : wanted;
  for (const table of spec.tables.values()) if (table.id === key || table.aliases.includes(key)) return table;
  return null;
}

export function runTableDraw(pack: RulePack, id: string, request: TableDrawRequest, random: RandomSource): TableDrawResult | TableDrawRefusal {
  const spec = subsystemOf(pack, id, "table_draw");
  const table = findTable(spec, request.table);
  if (table === null) return { ok: false, subsystem: id, refusal: "unknown_table", table: request.table ?? "", known: Object.freeze([...spec.tables.keys()]) };
  const roll = rollDice(`1d${table.entries.length}`, random);
  const index = roll.total - 1;
  return Object.freeze({ ok: true, subsystem: id, table: table.id, roll, index, entry: table.entries[index] as string });
}
