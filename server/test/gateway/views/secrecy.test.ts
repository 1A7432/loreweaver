// Sentinels: a marker sits in every non-public field of every document type a view reads.
// No view computed for a player or an observer carries one; an admin is shown only what
// §8.4 allows — the unexposed variables, each flagged hidden.
import { describe, expect, test } from "bun:test";
import type { VariablesView } from "loreweaver-protocol/v3";

import { KEEPER } from "../../../src/core/documents/index.ts";
import { BUILT_IN_VIEWS, type ViewerContext } from "../../../src/gateway/views/index.ts";
import type { Member } from "../commands/bench.ts";
import { ADA, ADMIN, ADMIN_ALLOWED, BAO, EVE, leaks, MARK, ROOM, type Room, seededRoom, TABLE_SECRETS } from "./fixture.ts";

async function everyView(room: Room, viewer: ViewerContext): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const view of BUILT_IN_VIEWS) out.set(view.name, await view.compute(room.source(), viewer));
  return out;
}

const PRIVATE_SHEETS = [MARK.adaNotes, MARK.adaBackground, MARK.baoNotes, MARK.baoBackground];

test("control: every marker is in the room, as the Keeper sees it", () => {
  const room = seededRoom();
  const services = room.b.services;
  const everything = services.types.names().map((type) => services.views.views(ROOM, type, KEEPER));
  expect(leaks(everything, [...TABLE_SECRETS, ...PRIVATE_SHEETS]).sort()).toEqual([...TABLE_SECRETS, ...PRIVATE_SHEETS].sort());
});

describe("players and observers", () => {
  const cases: [string, Member, string[]][] = [
    ["Ada (player)", ADA, [MARK.baoNotes, MARK.baoBackground]],
    ["Bao (player)", BAO, [MARK.adaNotes, MARK.adaBackground]],
    ["Eve (observer)", EVE, PRIVATE_SHEETS],
  ];
  for (const [label, member, others] of cases) {
    test(`${label}: no secret marker and no other member's sheet in any view`, async () => {
      const room = seededRoom();
      for (const locale of ["en", "zh"]) {
        for (const [name, value] of await everyView(room, room.viewer(member, locale))) {
          expect({ name, leaks: leaks(value, [...TABLE_SECRETS, ...others]) }).toEqual({ name, leaks: [] });
        }
      }
    });
  }

  test("even one's own sheet notes stay out: views name fields, they do not copy projections", async () => {
    const room = seededRoom();
    const views = await everyView(room, room.viewer(ADA));
    expect(leaks([...views.values()], [MARK.adaNotes, MARK.adaBackground])).toEqual([]);
  });

  test("the party shows every character at table grade, the viewer's own included", async () => {
    const room = seededRoom();
    const party = (await everyView(room, room.viewer(ADA))).get("party") as { characters: Record<string, unknown>[] };
    for (const entry of party.characters) expect(Object.keys(entry).sort()).toEqual(["id", "name", "pack", "player", "resources", "status"]);
  });
});

describe("the admin", () => {
  test("no Keeper secret and no player's sheet in any view", async () => {
    const room = seededRoom();
    const forbidden = [...TABLE_SECRETS.filter((marker) => !ADMIN_ALLOWED.includes(marker)), ...PRIVATE_SHEETS];
    for (const [name, value] of await everyView(room, room.viewer(ADMIN))) {
      expect({ name, leaks: leaks(value, forbidden) }).toEqual({ name, leaks: [] });
      if (name !== "variables") expect({ name, leaks: leaks(value, ADMIN_ALLOWED) }).toEqual({ name, leaks: [] });
    }
  });

  test("the unexposed variables appear only flagged hidden", async () => {
    const room = seededRoom();
    const variables = (await everyView(room, room.viewer(ADMIN))).get("variables") as VariablesView;
    for (const entry of [...variables.module, ...variables.tree]) {
      if (leaks(entry, ADMIN_ALLOWED).length > 0) expect(entry.hidden).toBe(true);
    }
    expect(leaks(variables, ADMIN_ALLOWED).sort()).toEqual([...ADMIN_ALLOWED].sort());
  });
});
