import { describe, expect, test } from "bun:test";

import {
  addStatus,
  type Character,
  type CharacterTableView,
  characterData,
  characterDocumentType,
  claim,
  claimableData,
  claimableDocument,
  createCharacter,
  EMPTY_CLAIMABLE,
  EMPTY_SEATING,
  MAX_CLAIMABLE,
  MAX_SEATS,
  MAX_STATUS_CHARS,
  MAX_STATUS_EFFECTS,
  memberOf,
  characterOf,
  offerCharacter,
  readCharacter,
  readSeating,
  release,
  releaseCharacter,
  removeStatus,
  type Seating,
  seatingData,
  seatingDocument,
  setAvatar,
  setOwner,
  setStatus,
  switchCharacter,
  updateSheet,
  withdrawCharacter,
  type ClaimableList,
} from "../../../src/core/characters/index.ts";
import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import { builtInPacks } from "../../../src/core/rulepacks/index.ts";
import type { SheetSpec } from "../../../src/core/sheets/index.ts";

const packs = builtInPacks();
const coc = packs.find((pack) => pack.id === "coc7");
if (coc === undefined) throw new Error("coc7 is a built-in pack");
const SPEC: SheetSpec = coc.sheet;
const specFor = (id: string): SheetSpec | null => packs.find((pack) => pack.id === id)?.sheet ?? null;
const characterType = characterDocumentType(specFor);

const HASH = "a".repeat(64);
const OWNER = "m-owner";

function doc(type: string, data: JsonObject, id = "doc-1"): Document {
  return { type, id, version: 1, data, meta: {}, corrupt: false };
}

const keeper: Viewer = KEEPER;
const owner: Viewer = playerViewer("en", OWNER);
const ownerAsAdmin: Viewer = { grade: "admin", memberId: OWNER, locale: "en" };
const admin: Viewer = { grade: "admin", memberId: "m-admin", locale: "en" };
const otherPlayer: Viewer = playerViewer("en", "m-other");
const anonymousPlayer: Viewer = playerViewer("en");
const observerWithOwnerId: Viewer = { grade: "observer", memberId: OWNER, locale: "en" };
const actor: Viewer = actorViewer("npc-1", "en");
// An actor that somehow carries the owner's member id is still an actor, never the owner.
const actorWithOwnerId: Viewer = { grade: "player", actorId: "npc-1", memberId: OWNER, locale: "en" };

const MARKERS = ["BG-SECRET-MARKER", "NOTES-SECRET-MARKER", "OCC-SECRET-MARKER", "SKILL-SECRET-MARKER", "EQUIP-SECRET-MARKER"];

function input(name = "Ada Lovelace"): JsonObject {
  return {
    name,
    system: "CoC",
    attributes: { STR: 50, CON: 60, SIZ: 60, DEX: 70, APP: 50, INT: 70, POW: 60, EDU: 70, LUC: 50 },
    skills: { 侦查: 60, "SKILL-SECRET-MARKER": 40 },
    fields: { occupation: "OCC-SECRET-MARKER", age: 31 },
    equipment: ["EQUIP-SECRET-MARKER"],
    background: "BG-SECRET-MARKER",
    notes: "NOTES-SECRET-MARKER",
  };
}

function made(options: Parameters<typeof createCharacter>[2] = { owner: OWNER, avatar: HASH }): Character {
  const result = createCharacter(SPEC, input(), options);
  if (!result.ok) throw new Error(result.code);
  return result.data;
}

function stored(character: Character): Document {
  return doc("character", characterData(character), "ada");
}

describe("creating and changing a character", () => {
  test("a created character is stored as a settled, valid payload", () => {
    const result = createCharacter(SPEC, input(), { owner: OWNER, avatar: HASH });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pack).toBe("coc7");
    expect(result.data.sheet.system).toBe("coc7");
    expect(result.data.sheet.avatar).toBeNull();
    expect(result.data.status).toEqual([]);
    expect(characterType.validate?.(characterData(result.data))).toEqual([]);
    // Vitals start full at creation.
    const hp = result.data.sheet.attributes.find(([key]) => key === "HP");
    expect(hp?.[1]).toBeGreaterThan(0);
  });

  test("a sheet without a name, or one past the cap, is refused", () => {
    expect(createCharacter(SPEC, input("   ")).ok).toBe(false);
    const long = createCharacter(SPEC, input("名".repeat(65)));
    expect(long).toEqual({ ok: false, code: "bad_name" });
    expect(createCharacter(SPEC, input("名".repeat(64))).ok).toBe(true);
  });

  test("an owner and avatar must be well formed", () => {
    expect(createCharacter(SPEC, input(), { avatar: "not-a-hash" })).toEqual({ ok: false, code: "bad_avatar" });
    expect(createCharacter(SPEC, input(), { owner: " padded " })).toEqual({ ok: false, code: "bad_owner" });
    const character = made();
    expect(setAvatar(character, "ABC")).toEqual({ ok: false, code: "bad_avatar" });
    const cleared = setAvatar(character, null);
    expect(cleared.ok && cleared.data.avatar).toBeNull();
    const handed = setOwner(character, "m-next");
    expect(handed.ok && handed.data.owner).toBe("m-next");
  });

  test("status effects: idempotent add, capped count and length in code points, no mutation", () => {
    const character = made();
    const once = addStatus(character, " poisoned ");
    if (!once.ok) throw new Error(once.code);
    expect(once.data.status).toEqual(["poisoned"]);
    expect(character.status).toEqual([]);
    const twice = addStatus(once.data, "poisoned");
    expect(twice.ok && twice.data).toBe(once.data);
    expect(addStatus(character, "😵".repeat(MAX_STATUS_CHARS)).ok).toBe(true);
    expect(addStatus(character, "😵".repeat(MAX_STATUS_CHARS + 1))).toEqual({ ok: false, code: "bad_status" });
    expect(addStatus(character, "  ")).toEqual({ ok: false, code: "bad_status" });
    const full = setStatus(character, Array.from({ length: MAX_STATUS_EFFECTS }, (_, i) => `s${i}`));
    if (!full.ok) throw new Error(full.code);
    expect(addStatus(full.data, "one more")).toEqual({ ok: false, code: "too_many_status" });
    expect(setStatus(character, Array.from({ length: MAX_STATUS_EFFECTS + 1 }, (_, i) => `s${i}`))).toEqual({ ok: false, code: "too_many_status" });
    const deduped = setStatus(character, ["a", "a", "b"]);
    expect(deduped.ok && deduped.data.status).toEqual(["a", "b"]);
    expect(removeStatus(once.data, "stunned")).toEqual({ ok: false, code: "status_absent" });
    const removed = removeStatus(once.data, "poisoned");
    expect(removed.ok && removed.data.status).toEqual([]);
  });

  test("a sheet edit keeps owner, avatar and status, and refuses another pack's spec", () => {
    const character = made();
    const withStatus = addStatus(character, "bleeding");
    if (!withStatus.ok) throw new Error(withStatus.code);
    const edited = updateSheet(SPEC, withStatus.data, { ...input(), notes: "new notes" });
    if (!edited.ok) throw new Error(edited.code);
    expect(edited.data.sheet.notes).toBe("new notes");
    expect([edited.data.owner, edited.data.avatar, edited.data.status]).toEqual([OWNER, HASH, ["bleeding"]]);
    const dnd = specFor("dnd5e");
    if (dnd === null) throw new Error("dnd5e is a built-in pack");
    expect(updateSheet(dnd, character, input())).toEqual({ ok: false, code: "wrong_pack" });
    expect(updateSheet(SPEC, character, input(""))).toEqual({ ok: false, code: "bad_name" });
  });

  test("the payload reads back to the same character", () => {
    const character = made();
    const read = readCharacter(SPEC, characterData(character));
    expect(read === null ? null : characterData(read)).toEqual(characterData(character));
    expect(readCharacter(SPEC, { pack: "coc7" })).toBeNull();
  });
});

describe("who sees what of a character (sentinels)", () => {
  const character = made();
  const document = stored(character);

  test("the Keeper, the owner and an admin who owns it see the whole sheet", () => {
    for (const viewer of [keeper, owner, ownerAsAdmin]) {
      const text = JSON.stringify(characterType.project(document, viewer));
      for (const marker of MARKERS) expect(text).toContain(marker);
      const view = characterType.project(document, viewer) as { owner: string; derived: readonly unknown[] };
      expect(view.owner).toBe(OWNER);
      expect(view.derived.length).toBeGreaterThan(0);
    }
  });

  test("everyone else sees name, pack, avatar, status and meters, nothing more", () => {
    const withStatus = addStatus(character, "poisoned");
    if (!withStatus.ok) throw new Error(withStatus.code);
    const doc2 = stored(withStatus.data);
    for (const viewer of [admin, otherPlayer, anonymousPlayer, observerWithOwnerId, actor, actorWithOwnerId]) {
      const view = characterType.project(doc2, viewer);
      const text = JSON.stringify(view);
      for (const marker of MARKERS) expect(text).not.toContain(marker);
      expect(text).not.toContain("STR");
      expect(text).not.toContain(OWNER);
      expect(Object.keys(view as object).sort()).toEqual(["avatar", "name", "pack", "resources", "status"]);
      expect(view).toMatchObject({ name: "Ada Lovelace", pack: "coc7", avatar: HASH, status: ["poisoned"] });
      const ids = (view as CharacterTableView).resources.map((resource) => resource.id);
      expect(ids).toEqual(["hp", "san", "mp"]);
    }
  });

  test("a field added to the payload later stays private", () => {
    const withExtra = doc("character", { ...characterData(character), privateLater: "LATER-SECRET-MARKER" }, "ada");
    for (const viewer of [admin, otherPlayer, actor]) expect(JSON.stringify(characterType.project(withExtra, viewer))).not.toContain("LATER-SECRET-MARKER");
  });

  test("a pack no longer loaded: no meters for the table, the stored sheet for the owner", () => {
    const orphan = characterDocumentType(() => null);
    const table = orphan.project(document, otherPlayer) as CharacterTableView;
    expect(table.resources).toEqual([]);
    expect(JSON.stringify(table)).not.toContain("NOTES-SECRET-MARKER");
    expect(JSON.stringify(orphan.project(document, owner))).toContain("NOTES-SECRET-MARKER");
  });
});

describe("validating a stored character", () => {
  const good = characterData(made());
  const sheet = good.sheet as JsonObject;
  const codes = (data: JsonObject): string[] => (characterType.validate?.(data) ?? []).map((v) => v.code);

  test("refusals carry codes", () => {
    expect(codes({ ...good, pack: "nope" })).toContain("unknown_pack");
    expect(codes({ ...good, avatar: "x" })).toContain("bad_avatar");
    expect(codes({ ...good, extra: 1 })).toContain("unknown_field");
    expect(codes({ ...good, status: ["a", "a"] })).toContain("duplicate_status");
    expect(codes({ ...good, status: Array.from({ length: MAX_STATUS_EFFECTS + 1 }, (_, i) => `s${i}`) })).toContain("too_many_status");
    expect(codes({ ...good, sheet: { ...sheet, system: "dnd5e" } })).toContain("system_mismatch");
    expect(codes({ ...good, sheet: { ...sheet, avatar: { hash: HASH } } })).toContain("sheet_avatar");
    expect(codes({ ...good, sheet: { ...sheet, skills: [["侦查", "lots"]] } })).toContain("sheet_skill_not_numeric");
    expect(codes({ ...good, sheet: "nope" })).toContain("bad_sheet");
  });

  test("the type resets with characters", () => {
    expect(characterType.lifecycle).toEqual({ reset: "chars" });
  });
});

describe("seating", () => {
  const seated = (seating: Seating, member: string, character: string): Seating => {
    const result = claim(seating, member, character, `name-${member}`);
    if (!result.ok) throw new Error(result.code);
    return result.data;
  };

  test("claim, refuse a held character, one character per member, release", () => {
    const one = seated(EMPTY_SEATING, "m1", "ada");
    expect(characterOf(one, "m1")).toBe("ada");
    expect(memberOf(one, "ada")).toBe("m1");
    expect(characterOf(one, "m2")).toBeNull();
    expect(claim(one, "m2", "ada", "Bob")).toEqual({ ok: false, code: "taken" });
    expect(claim(one, "m1", "bob", "Ann")).toEqual({ ok: false, code: "already_seated" });
    const refreshed = claim(one, "m1", "ada", "Ann the Second");
    expect(refreshed.ok && refreshed.data.seats[0]?.memberName).toBe("Ann the Second");
    expect(EMPTY_SEATING.seats).toEqual([]);
    const released = release(one, "m1");
    expect(released.ok && released.data.seats).toEqual([]);
    expect(release(EMPTY_SEATING, "m1")).toEqual({ ok: false, code: "not_seated" });
  });

  test("the admin's release and a switch", () => {
    const two = seated(seated(EMPTY_SEATING, "m1", "ada"), "m2", "bob");
    const freed = releaseCharacter(two, "ada");
    expect(freed.ok && freed.data.seats.map((seat) => seat.member)).toEqual(["m2"]);
    expect(releaseCharacter(two, "cid")).toEqual({ ok: false, code: "unclaimed" });
    expect(switchCharacter(two, "m1", "bob", "Ann")).toEqual({ ok: false, code: "taken" });
    const switched = switchCharacter(two, "m1", "cid", "Ann");
    expect(switched.ok && switched.data.seats.map((seat) => [seat.member, seat.character])).toEqual([
      ["m1", "cid"],
      ["m2", "bob"],
    ]);
    const fromSpectator = switchCharacter(two, "m3", "dee", "Dee");
    expect(fromSpectator.ok && characterOf(fromSpectator.data, "m3")).toBe("dee");
  });

  test("hostile ids are ordinary keys, in order, through a round trip", () => {
    let seating = EMPTY_SEATING;
    for (const [member, character] of [
      ["__proto__", "constructor"],
      ["10", "2"],
      ["constructor", "__proto__"],
    ] as const) {
      seating = seated(seating, member, character);
    }
    const back = readSeating(seatingData(seating));
    expect(back?.seats.map((seat) => seat.member)).toEqual(["__proto__", "10", "constructor"]);
    expect(memberOf(seating, "__proto__")).toBe("constructor");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("ids and names are capped and refused", () => {
    expect(claim(EMPTY_SEATING, "", "ada", "x")).toEqual({ ok: false, code: "bad_member" });
    expect(claim(EMPTY_SEATING, "m1", "a".repeat(129), "x")).toEqual({ ok: false, code: "bad_character" });
    expect(claim(EMPTY_SEATING, "m1", "ada", "n".repeat(65))).toEqual({ ok: false, code: "bad_member_name" });
    let seating = EMPTY_SEATING;
    for (let i = 0; i < MAX_SEATS; i++) seating = seated(seating, `m${i}`, `c${i}`);
    expect(claim(seating, "late", "late-c", "x")).toEqual({ ok: false, code: "full" });
  });

  test("everyone sees every seat; a stored seating must keep the invariants", () => {
    const seating = seated(EMPTY_SEATING, "m1", "ada");
    const document = doc("seating", seatingData(seating), "seating");
    const keeperView = seatingDocument.project(document, keeper);
    for (const viewer of [admin, otherPlayer, actor, observerWithOwnerId]) expect(seatingDocument.project(document, viewer)).toEqual(keeperView);
    const codes = (data: JsonObject) => (seatingDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(seatingData(seating))).toEqual([]);
    expect(
      codes({
        seats: [
          { member: "m1", character: "ada", memberName: "" },
          { member: "m1", character: "bob", memberName: "" },
          { member: "m2", character: "ada", memberName: "" },
        ],
      }),
    ).toEqual(["already_seated", "taken"]);
    expect(codes({ seats: [{ member: "m1", character: "ada" }] })).toEqual(["bad_seat"]);
    expect(seatingDocument.lifecycle).toEqual({ reset: "chars" });
  });
});

describe("claimable characters", () => {
  const entry = (id: string, keeperNote = "") => ({ id, name: `Pregen ${id}`, blurb: "A retired sailor with a past.", source: { kind: "pack" as const, id: "harbor" }, keeperNote });

  const offered = (list: ClaimableList, id: string, note = ""): ClaimableList => {
    const result = offerCharacter(list, entry(id, note));
    if (!result.ok) throw new Error(result.code);
    return result.data;
  };

  test("offering replaces in place, withdrawing removes, the list is capped", () => {
    const list = offered(offered(EMPTY_CLAIMABLE, "a"), "b");
    const replaced = offerCharacter(list, { ...entry("a"), blurb: "Updated." });
    expect(replaced.ok && replaced.data.characters.map((item) => [item.id, item.blurb])).toEqual([
      ["a", "Updated."],
      ["b", "A retired sailor with a past."],
    ]);
    expect(withdrawCharacter(list, "zz")).toEqual({ ok: false, code: "unknown" });
    const withdrawn = withdrawCharacter(list, "a");
    expect(withdrawn.ok && withdrawn.data.characters.map((item) => item.id)).toEqual(["b"]);
    let full = EMPTY_CLAIMABLE;
    for (let i = 0; i < MAX_CLAIMABLE; i++) full = offered(full, `c${i}`);
    expect(offerCharacter(full, entry("late"))).toEqual({ ok: false, code: "full" });
    expect(offerCharacter(EMPTY_CLAIMABLE, { ...entry("x"), blurb: "b".repeat(201) })).toEqual({ ok: false, code: "bad_blurb" });
    expect(offerCharacter(EMPTY_CLAIMABLE, { ...entry("x"), source: { kind: "card" as "pack", id: "p" } })).toEqual({ ok: false, code: "bad_source" });
  });

  test("an author's keeper note reaches the Keeper and nobody else (sentinel)", () => {
    const list = offered(EMPTY_CLAIMABLE, "a", "PREGEN-NOTE-SECRET-MARKER");
    const document = doc("claimable_characters", claimableData(list), "claimables");
    expect(JSON.stringify(claimableDocument.project(document, keeper))).toContain("PREGEN-NOTE-SECRET-MARKER");
    for (const viewer of [admin, owner, otherPlayer, observerWithOwnerId, actor]) {
      const view = claimableDocument.project(document, viewer);
      expect(JSON.stringify(view)).not.toContain("PREGEN-NOTE-SECRET-MARKER");
      expect(view).toEqual({ characters: [{ id: "a", name: "Pregen a", blurb: "A retired sailor with a past.", source: { kind: "pack", id: "harbor" } }] });
    }
    const first = (claimableData(list).characters as JsonObject[])[0];
    const later = doc("claimable_characters", { characters: [{ ...first, sheet: "LATER-SECRET-MARKER" }] }, "claimables");
    expect(JSON.stringify(claimableDocument.project(later, otherPlayer))).not.toContain("LATER-SECRET-MARKER");
  });

  test("validation and lifecycle", () => {
    const list = offered(EMPTY_CLAIMABLE, "a");
    const codes = (data: JsonObject) => (claimableDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(claimableData(list))).toEqual([]);
    const one = claimableData(list).characters as JsonObject[];
    expect(codes({ characters: [...one, ...one] })).toEqual(["duplicate_id"]);
    expect(codes({ characters: [{ ...one[0], name: " padded " }] })).toEqual(["untrimmed"]);
    expect(codes({ characters: [{ ...one[0], sheet: {} }] })).toEqual(["bad_entry"]);
    expect(claimableDocument.lifecycle).toEqual({ reset: "all" });
  });
});
