// A module's characters outside the module: namespaced ids that can never name an engine
// character or another module's, and the claimable document that never holds one.
import { expect, test } from "bun:test";

import { DEFAULT_CAPS } from "../../../src/agent/modules.ts";
import {
  claim,
  EMPTY_CLAIMABLE,
  EMPTY_SEATING,
  findModuleCharacter,
  isModuleCharacterId,
  MAX_MODULE_CHARACTER_ID_CHARS,
  MAX_MODULE_ID_CHARS,
  MAX_SEAT_CHARACTER_CHARS,
  moduleCharacterId,
  moduleCharacterName,
  offerCharacter,
  splitModuleCharacterId,
} from "../../../src/core/characters/index.ts";

test("a namespaced id splits back into its module and the module's own id; an engine id is none", () => {
  expect(moduleCharacterId("colony", "ana")).toBe("colony:ana");
  expect(splitModuleCharacterId("colony:ana")).toEqual({ module: "colony", id: "ana" });
  // The module's own id may hold a colon of its own, and any script.
  expect(splitModuleCharacterId("colony:a:b")).toEqual({ module: "colony", id: "a:b" });
  expect(splitModuleCharacterId("colony:阿娜")).toEqual({ module: "colony", id: "阿娜" });
  for (const id of ["ch-id-1", "ch-1:x", "Colony:ana", "colony:", ":ana", "9lives:x", `${"m".repeat(MAX_MODULE_ID_CHARS + 1)}:x`, "__proto__"]) {
    expect([id, isModuleCharacterId(id)]).toEqual([id, false]);
  }
});

test("the room's list is found by namespaced id; a seat it no longer lists reads as its id", () => {
  const list = [
    { module: "colony", id: "ana", name: "Ana", blurb: null, resources: [] },
    { module: "rival", id: "ana", name: "Rival Ana", blurb: null, resources: [] },
  ];
  expect(findModuleCharacter(list, "rival:ana")?.name).toBe("Rival Ana");
  expect(findModuleCharacter(list, "colony:bo")).toBeNull();
  expect(moduleCharacterName(list, "colony:bo")).toBe("colony:bo");
});

test("a seat holds the longest namespaced id; the module caps agree with it", () => {
  expect(DEFAULT_CAPS.characterTextChars).toBe(MAX_MODULE_CHARACTER_ID_CHARS);
  const longest = moduleCharacterId("m".repeat(MAX_MODULE_ID_CHARS), "c".repeat(MAX_MODULE_CHARACTER_ID_CHARS));
  expect([...longest].length).toBe(MAX_SEAT_CHARACTER_CHARS);
  expect(claim(EMPTY_SEATING, "m1", longest, "Ada").ok).toBe(true);
});

test("the claimable document holds a pack's pregens only: never a module's source or a namespaced id", () => {
  const entry = { id: "pregen", name: "Pregen", blurb: "", source: { kind: "pack" as const, id: "harbor" }, keeperNote: "" };
  expect(offerCharacter(EMPTY_CLAIMABLE, entry).ok).toBe(true);
  expect(offerCharacter(EMPTY_CLAIMABLE, { ...entry, id: "colony:ana" })).toEqual({ ok: false, code: "bad_id" });
  expect(offerCharacter(EMPTY_CLAIMABLE, { ...entry, source: { kind: "module" as "pack", id: "colony" } })).toEqual({ ok: false, code: "bad_source" });
});
