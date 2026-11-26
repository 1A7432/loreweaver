// How one round's calls are grouped for execution (the 2.6 loop's `_concurrency_groups`,
// adapted to a server whose synchronous tools finish in one stretch).
//
// The calls are split, IN ORDER, into groups whose members may run at the same time. A
// call joins the current group when it writes nothing (read-only), or when it carries a
// concurrency key (`concurrentBy`) no member of the group holds; a call whose key the
// group already holds starts a new group; any other call — a writer, an uncatalogued or
// unreadable call — is a group of its own and a barrier for what follows. Overlap only
// matters for tools that suspend: the engine STARTS a group's calls in call order, so a
// synchronous member runs to completion at its start, and only suspending members are in
// flight together. Whatever the overlap, outcomes are RECORDED and published in call
// order. Two calls for the same NPC stay serial; two different NPCs speak at once.
import type { CallRequest, TurnCatalog } from "./catalog.ts";

/** One round's calls as groups of indexes into `calls`, in call order. */
export function concurrencyGroups(catalog: Pick<TurnCatalog, "isReadOnly" | "concurrencyKey">, calls: readonly CallRequest[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let keys = new Set<string>();
  calls.forEach((call, index) => {
    const independent = catalog.isReadOnly(call.name);
    const key = independent ? null : catalog.concurrencyKey(call);
    if (!independent && key === null) {
      if (current.length > 0) groups.push(current);
      groups.push([index]);
      current = [];
      keys = new Set();
      return;
    }
    if (key !== null && keys.has(key)) {
      groups.push(current);
      current = [];
      keys = new Set();
    }
    current.push(index);
    if (key !== null) keys.add(key);
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Run one round: groups one after another, each group's calls started in call order and
 * awaited together; the outcomes come back in call order. A convenience for the turn
 * engine, which records them in that order.
 */
export async function runRound<T>(groups: readonly (readonly number[])[], run: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (const group of groups) {
    const settled = await Promise.all(group.map((index) => run(index)));
    group.forEach((index, at) => {
      results[index] = settled[at] as T;
    });
  }
  return results;
}
