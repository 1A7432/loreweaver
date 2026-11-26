import { describe, expect, test } from "bun:test";

import {
  activeSkills,
  builtInSkillIds,
  builtInSkillRegistry,
  builtInSkills,
  disableSkill,
  enableSkill,
  ENABLED_SKILLS,
  liftsOutputFilter,
  MAX_ALLOWED_TOOLS,
  parseSkillDirectory,
  parseSkillText,
  readEnabledSkills,
  skillDescription,
  skillName,
  unlockedTools,
  writeEnabledSkills,
} from "../../../src/core/skills/index.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { Store } from "../../../src/infra/store.ts";

const SAMPLE = `---
name: Sample
description: A test skill.
name-zh: 样例
allowed-tools: [roll_secret, roll_secret, peek]
metadata:
  scope: room
  systems: [coc7]
  content-rating: Mature
---

# Sample

Do the thing.
`;

describe("the built-in skills", () => {
  test("the first release's three load from the embedded text, and nothing else is built in", () => {
    expect(builtInSkillIds()).toEqual(["mature-mode", "romance-relationships", "image-gen"]);
    const skills = builtInSkills();
    expect(skills.map((skill) => [skill.id, skill.contentRating, skill.allowedTools])).toEqual([
      ["mature-mode", "explicit", []],
      ["romance-relationships", "mature", ["adjust_relationship", "set_relationship", "get_relationships"]],
      ["image-gen", "", ["generate_image"]],
    ]);
    for (const skill of skills) {
      expect(skill.body.startsWith("# ")).toBe(true);
      expect(skillName(skill, "zh-CN")).not.toBe(skill.name);
    }
    expect(skillName(skills[0]!, "fr")).toBe("Mature mode");
  });

  test("unlocked tools and the output-filter lift follow the enabled set", () => {
    const registry = builtInSkillRegistry();
    expect([...unlockedTools(registry, ["image-gen"])]).toEqual(["generate_image"]);
    expect(unlockedTools(registry, []).size).toBe(0);
    expect(liftsOutputFilter(registry, ["image-gen"])).toBe(false);
    expect(liftsOutputFilter(registry, ["image-gen", "mature-mode"])).toBe(true);
    expect(liftsOutputFilter(registry, ["romance-relationships"])).toBe(true);
    // An id no longer in the registry (an uninstalled pack) unlocks nothing.
    expect(activeSkills(registry, ["gone", "image-gen"]).map((skill) => skill.id)).toEqual(["image-gen"]);
  });
});

describe("parsing", () => {
  test("front matter, localized names, deduplicated tools and the body", () => {
    const parsed = parseSkillText("sample", SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skill).toMatchObject({
      id: "sample",
      name: "Sample",
      description: "A test skill.",
      allowedTools: ["roll_secret", "peek"],
      systems: ["coc7"],
      contentRating: "mature",
      body: "# Sample\n\nDo the thing.",
    });
    expect(skillName(parsed.skill, "zh")).toBe("样例");
    expect(skillDescription(parsed.skill, "zh")).toBe("A test skill.");
    expect(parsed.warnings).toEqual([]);
  });

  test("malformed front matter is refused with a code", () => {
    expect(parseSkillText("x", "# no front matter")).toMatchObject({ ok: false, code: "no_front_matter" });
    expect(parseSkillText("x", "---\nname: x\n# never closed")).toMatchObject({ ok: false, code: "unclosed_front_matter" });
    expect(parseSkillText("x", "---\nname: [unclosed\n---\nbody")).toMatchObject({ ok: false, code: "yaml", detail: "syntax" });
    expect(parseSkillText("x", "---\na: &x 1\nb: *x\n---\nbody")).toMatchObject({ ok: false, code: "yaml", detail: "alias" });
    expect(parseSkillText("x", "---\n- a list\n---\nbody")).toMatchObject({ ok: false, code: "not_a_mapping" });
    expect(parseSkillText("x", "---\nallowed-tools: generate_image\n---\nbody")).toMatchObject({ ok: false, code: "bad_field", path: "allowed-tools" });
    expect(parseSkillText("x", "---\nname: 7\n---\nbody")).toMatchObject({ ok: false, code: "bad_field", path: "name" });
    const tools = Array.from({ length: MAX_ALLOWED_TOOLS + 1 }, (_, index) => `t${index}`).join(", ");
    expect(parseSkillText("x", `---\nallowed-tools: [${tools}]\n---\nbody`)).toMatchObject({ ok: false, code: "too_many", path: "allowed-tools" });
    expect(parseSkillText("x", `---\nname: ${"n".repeat(101)}\n---\nbody`)).toMatchObject({ ok: false, code: "too_long", path: "name" });
    expect(parseSkillText("Bad Id", SAMPLE)).toMatchObject({ ok: false, code: "bad_id" });
  });

  test("a directory with hooks.js loads, with a warning that the script is ignored", () => {
    const parsed = parseSkillDirectory({ id: "sample", files: ["SKILL.md", "hooks.js"], skillFile: SAMPLE });
    expect(parsed).toMatchObject({ ok: true, warnings: [{ code: "hooks_ignored" }] });
    expect(parseSkillDirectory({ id: "sample", files: ["hooks.js"], skillFile: null })).toEqual({ ok: false, code: "no_skill_file" });
    expect(parseSkillDirectory({ id: "odd", files: ["SKILL.md"], skillFile: "---\nmetadata:\n  scope: global\n---\n" })).toMatchObject({
      ok: true,
      warnings: [{ code: "unknown_scope" }],
    });
  });
});

describe("the registry and the enabled set", () => {
  test("built-ins win: an installed skill cannot replace one", () => {
    const parsed = parseSkillText("mature-mode", SAMPLE);
    if (!parsed.ok) throw new Error(parsed.code);
    const added = builtInSkillRegistry().with([parsed.skill]);
    expect(added.refused).toEqual([{ id: "mature-mode", code: "duplicate_id" }]);
    expect(added.registry.get("mature-mode")?.name).toBe("Mature mode");
  });

  test("enable and disable are pure; the set is a never-reset room setting", () => {
    const registry = builtInSkillRegistry();
    expect(enableSkill(registry, [], "nope")).toEqual({ ok: false, code: "unknown_skill" });
    const enabled = enableSkill(registry, [], "image-gen");
    expect(enabled).toEqual({ ok: true, enabled: ["image-gen"], changed: true });
    expect(enableSkill(registry, ["image-gen"], "image-gen")).toEqual({ ok: true, enabled: ["image-gen"], changed: false });
    expect(disableSkill(["gone", "image-gen"], "gone")).toEqual({ ok: true, enabled: ["image-gen"], changed: true });

    expect(ENABLED_SKILLS.lifecycle.reset).toBe("never");
    const store = new Store(openDatabase(":memory:"));
    expect(readEnabledSkills(store, "r")).toEqual([]);
    writeEnabledSkills(store.writer("r"), ["image-gen", "mature-mode"]);
    expect(readEnabledSkills(store, "r")).toEqual(["image-gen", "mature-mode"]);
    writeEnabledSkills(store.writer("r"), []);
    expect(readEnabledSkills(store, "r")).toEqual([]);
  });
});
