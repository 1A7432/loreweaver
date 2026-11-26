/**
 * An ordered name→value table, stored as a list of `[name, value]` pairs.
 *
 * Why not a plain object: stat names are content and can be anything — `constructor`,
 * `__proto__` (which an assignment would treat as the prototype), or number-like names,
 * which an object lists first in numeric order whatever order they were written in.
 * A pair list is plain JSON, keeps the written order, and has no inherited members.
 * Names are unique within a table; every helper here keeps them so, and none mutates
 * its input.
 */

export type Entry<V> = readonly [name: string, value: V];
export type Table<V> = readonly Entry<V>[];

/** The value stored under `name`, or `undefined`. */
export function tableGet<V>(table: Table<V>, name: string): V | undefined {
  for (const [key, value] of table) if (key === name) return value;
  return undefined;
}

export function tableHas<V>(table: Table<V>, name: string): boolean {
  return table.some(([key]) => key === name);
}

/** `table` with `name` set to `value`: replaced in place when present, else appended. */
export function tableWith<V>(table: Table<V>, name: string, value: V): Table<V> {
  let found = false;
  const out = table.map((entry): Entry<V> => {
    if (entry[0] !== name) return entry;
    found = true;
    return [name, value];
  });
  if (!found) out.push([name, value]);
  return out;
}

/** `table` without `name` (the same table when absent). */
export function tableWithout<V>(table: Table<V>, name: string): Table<V> {
  return tableHas(table, name) ? table.filter(([key]) => key !== name) : table;
}

/** A `Map` view, for lookups in a loop. */
export function tableMap<V>(table: Table<V>): Map<string, V> {
  return new Map(table);
}
