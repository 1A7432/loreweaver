// `readPack` over an in-memory pack of every content kind, each mismatch refused, and the
// trust card.
import { describe, expect, test } from "bun:test";

import { readPack, trustCard, type PackProblem } from "../../src/core/packs/index.ts";
import { jsonFile, plainCard, worldCard } from "../gateway/card_files.ts";
import { KIT_YAML, manifestYaml, packEntries, text } from "./fixture.ts";

function problems(entries: Parameters<typeof readPack>[0]): PackProblem[] {
  const read = readPack(entries);
  if (read.ok) throw new Error("expected problems");
  return [...read.problems];
}

describe("a valid pack", () => {
  test("every kind reads", () => {
    const read = readPack(packEntries({ "skills/harbor-guide/hooks.js": text("module.exports = {}"), "notes/readme.txt": text("hi") }));
    if (!read.ok) throw new Error(JSON.stringify(read.problems));
    const pack = read.pack;
    expect(pack.modules.map((module) => [module.id, module.path])).toEqual([["tally", "modules/tally.js"]]);
    expect(pack.ruleSystems.map((system) => [system.id, system.extends, system.compiled.names])).toEqual([["harbor-rules", "coc7", ["Harbor Rules"]]]);
    expect(pack.skills.map((skill) => [skill.id, skill.skill.name, skill.skill.allowedTools])).toEqual([["harbor-guide", "Harbor guide", ["generate_image"]]]);
    expect(pack.cards.map((card) => [card.path, card.kind, card.name])).toEqual([
      ["cards/drowned.json", "world", "Drowned City"],
      ["cards/sailor.json", "character", "Mara"],
    ]);
    expect(pack.presentation?.kit.subjects.map((subject) => subject.ref)).toEqual(["art/quay.png"]);
    // Declared assets first, then the kit's pictures and sounds.
    expect(pack.assets.map((asset) => [asset.path, asset.mime])).toEqual([
      ["art/cover.png", "image/png"],
      ["art/quay.png", "image/png"],
      ["sound/bell.ogg", "audio/ogg"],
    ]);
    expect(pack.ignored).toEqual([
      { path: "notes/readme.txt", reason: "unknown_file" },
      { path: "skills/harbor-guide/hooks.js", reason: "hooks_js" },
    ]);
    expect(pack.skillWarnings).toEqual([{ id: "harbor-guide", warning: { code: "hooks_ignored" } }]);
    // The files it installs: pack.yaml first, then by path; nothing ignored among them.
    expect(pack.files[0]?.path).toBe("pack.yaml");
    expect(pack.files.map((file) => file.path)).not.toContain("skills/harbor-guide/hooks.js");
    expect(pack.files.map((file) => file.path)).not.toContain("notes/readme.txt");
    expect(pack.files).toHaveLength(10);
  });

  test("a rule pack may extend another rule pack of the same pack", () => {
    const manifest = manifestYaml().replace("rulepacks: [rules/harbor-rules.yaml]", "rulepacks: [rules/harbor-rules.yaml, rules/harbor-strict.yaml]");
    const read = readPack(packEntries({ "rules/harbor-strict.yaml": text("extends: harbor-rules\nnames: [Strict Harbor]\n") }, manifest));
    expect(read.ok && read.pack.ruleSystems.map((system) => system.extends)).toEqual(["coc7", "harbor-rules"]);
  });
});

describe("mismatches", () => {
  test("no pack.yaml", () => {
    expect(problems(packEntries({ "pack.yaml": null }))).toEqual([{ code: "no_manifest", path: "pack.yaml" }]);
  });

  test("a version 2 manifest is refused by code", () => {
    expect(problems(packEntries({}, manifestYaml().replace("manifest_version: 3", "manifest_version: 2")))).toEqual([
      { code: "manifest_version_unsupported", path: "pack.yaml:manifest_version", detail: "2" },
    ]);
  });

  test("a card whose kind lies", () => {
    expect(problems(packEntries({ "cards/sailor.json": jsonFile(worldCard("Sneaky")) }))).toEqual([{ code: "card_kind_mismatch", path: "cards/sailor.json", detail: "world" }]);
    expect(problems(packEntries({ "cards/drowned.json": jsonFile(plainCard("Plain")) }))).toEqual([{ code: "card_kind_mismatch", path: "cards/drowned.json", detail: "character" }]);
  });

  test("a card that is not a card", () => {
    expect(problems(packEntries({ "cards/sailor.json": text("[1,2,3]") }))[0]).toMatchObject({ code: "card_invalid", path: "cards/sailor.json" });
  });

  test("a module entry that is missing", () => {
    expect(problems(packEntries({ "modules/tally.js": null }))).toEqual([{ code: "missing_file", path: "modules/tally.js" }]);
  });

  test("a module entry that is not bundled", () => {
    expect(problems(packEntries({ "src/tally.ts": text("export default {}") }, manifestYaml({ entry: "src/tally.ts" })))).toContainEqual({ code: "module_not_bundled", path: "src/tally.ts" });
  });

  test("an undeclared script", () => {
    expect(problems(packEntries({ "lib/extra.js": text("console.log(1)") }))).toEqual([{ code: "undeclared_script", path: "lib/extra.js" }]);
    expect(problems(packEntries({ "skills/harbor-guide/helper.ts": text("x") }))).toEqual([{ code: "undeclared_script", path: "skills/harbor-guide/helper.ts" }]);
  });

  test("a rule pack that does not compile", () => {
    expect(problems(packEntries({ "rules/harbor-rules.yaml": text("extends: nowhere\n") }))).toEqual([{ code: "rulepack_invalid", path: "rules/harbor-rules.yaml", detail: "EXTENDS_UNKNOWN@extends" }]);
    // The rules-script lane is not built: a pack that needs it is refused, by code.
    expect(problems(packEntries({ "rules/harbor-rules.yaml": text("resolution:\n  script: roll.js\n") }))).toEqual([
      { code: "rulepack_invalid", path: "rules/harbor-rules.yaml", detail: "SCRIPT_UNSUPPORTED@resolution.script" },
    ]);
  });

  test("a skill that does not parse", () => {
    expect(problems(packEntries({ "skills/harbor-guide/SKILL.md": text("no front matter") }))).toEqual([{ code: "skill_invalid", path: "skills/harbor-guide/SKILL.md", detail: "no_front_matter" }]);
  });

  test("a presentation kit that does not parse, or names what is not there", () => {
    expect(problems(packEntries({ "presentation.yaml": text("version: 1\n") }))).toEqual([{ code: "presentation_invalid", path: "presentation.yaml", detail: "bad_version@version" }]);
    expect(problems(packEntries({ "art/quay.png": null }))).toEqual([{ code: "kit_asset_missing", path: "art/quay.png" }]);
    expect(problems(packEntries({ "presentation.yaml": text(KIT_YAML.replace("asset: sound/bell.ogg", "asset: art/quay.png")) }))).toContainEqual({
      code: "kit_asset_type",
      path: "art/quay.png",
      detail: "image/png",
    });
  });

  test("assets: type, signature, digest, size", () => {
    const withAsset = (extra: string): string => manifestYaml().replace("  - { path: art/cover.png, title: Cover }", extra);
    expect(problems(packEntries({ "doc/page.html": text("<p>") }, withAsset("  - doc/page.html")))).toEqual([{ code: "asset_type", path: "doc/page.html" }]);
    expect(problems(packEntries({ "art/cover.png": text("not a png") }))).toEqual([{ code: "asset_bad_signature", path: "art/cover.png", detail: "image/png" }]);
    expect(problems(packEntries({}, withAsset(`  - { path: art/cover.png, sha256: \"${"0".repeat(64)}\" }`)))).toEqual([{ code: "asset_digest_mismatch", path: "art/cover.png" }]);
    expect(problems(packEntries({}, withAsset("  - { path: art/cover.png, mime: image/jpeg }")))).toEqual([{ code: "asset_mime_mismatch", path: "art/cover.png", detail: "image/png" }]);
    expect(problems(packEntries({ "art/cover.png": new Uint8Array(9 * 1024 * 1024).fill(0x89, 0, 1) }))).toEqual([{ code: "asset_too_large", path: "art/cover.png" }]);
    expect(problems(packEntries({ "art/cover.svg": text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, withAsset("  - art/cover.svg")))).toEqual([
      { code: "asset_bad_signature", path: "art/cover.svg", detail: "image/svg+xml" },
    ]);
  });

  test("two entries that are one file on a case-insensitive filesystem", () => {
    expect(problems([...packEntries(), { path: "Art/Quay.PNG", bytes: text("x") }])).toContainEqual({ code: "duplicate_file", path: "Art/Quay.PNG" });
  });
});

test("the trust card says what installing means", () => {
  const read = readPack(packEntries({ "skills/harbor-guide/hooks.js": text("x") }));
  if (!read.ok) throw new Error("expected a pack");
  const card = trustCard(read.pack);
  expect(card).toMatchObject({
    id: "harbor",
    version: "1.0.0",
    name: { en: "Harbor", zh: "港口" },
    authors: ["Ada"],
    license: "CC-BY-4.0",
    engine: { protocol: "3.0", server: null },
    runsCode: true,
    ruleSystems: [{ id: "harbor-rules", extends: "coc7" }],
    skills: [{ id: "harbor-guide", name: "Harbor guide", tools: ["generate_image"], mature: false }],
    presentation: { subjects: 1, cues: 1, generation: "allow" },
    ignored: [{ path: "skills/harbor-guide/hooks.js", reason: "hooks_js" }],
  });
  expect(card.modules).toEqual([{ id: "tally", entry: "modules/tally.js", bytes: read.pack.modules[0]?.size ?? -1, sha256: read.pack.modules[0]?.sha256 ?? "" }]);
  expect(card.cards[0]).toEqual({ path: "cards/drowned.json", kind: "world", name: "Drowned City", machinery: { variableDeclarations: 1, templates: 1, secretEntries: 1, moduleVariables: 0, hooks: 1 } });
  expect(card.cards[1]?.machinery).toEqual({ variableDeclarations: 0, templates: 0, secretEntries: 0, moduleVariables: 0, hooks: 0 });
  expect(card.assets.count).toBe(3);
  expect(card.files.count).toBe(10);
  // Plain data: it survives JSON unchanged.
  expect(JSON.parse(JSON.stringify(card))).toEqual(card);
});
