import { expect, test } from "bun:test";

import { selftest } from "../../src/cli/selftest.ts";
import { WORKER_ENTRY } from "../helpers.ts";

test("one turn end to end: iroh in, database on disk, a module in a room worker, the reply out", async () => {
  const report = await selftest(WORKER_ENTRY);
  expect(report).toMatchObject({
    ok: true,
    steps: {
      rule_packs_embedded: true,
      transport_bound: true,
      welcomed: true,
      turn_answered: true,
      module_loaded_and_injected: true,
      module_state_stored: true,
      log_stored: true,
      media_uploaded: true,
      media_fetched: true,
      no_problems: true,
    },
  });
}, 20_000);
