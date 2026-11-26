// `pack.yaml`, manifest version 3: every field, and every refusal with its code and path.
import { describe, expect, test } from "bun:test";

import { MAX_ASSETS, MAX_MODULES, parseManifest, versionAtLeast } from "../../src/core/packs/index.ts";
import { manifestYaml } from "./fixture.ts";

function problems(text: string): { code: string; path: string; detail?: string }[] {
  const parsed = parseManifest(text);
  if (parsed.ok) throw new Error("expected problems");
  return [...parsed.problems];
}

const BASE = "manifest_version: 3\nid: p\nversion: 1.0.0\nname: P\ndescription: D\nlicense: MIT\n";

describe("a full manifest", () => {
  test("every field reads", () => {
    const parsed = parseManifest(manifestYaml({ extra: "homepage: https://example.org\n" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const m = parsed.manifest;
    expect(m.manifestVersion).toBe(3);
    expect(m.id).toBe("harbor");
    expect(m.version).toBe("1.0.0");
    expect(m.name).toEqual({ en: "Harbor", zh: "港口" });
    expect(m.description).toEqual({ en: "A small harbor town." });
    expect(m.authors).toEqual(["Ada"]);
    expect(m.license).toBe("CC-BY-4.0");
    expect(m.engine).toEqual({ protocol: "3.0", server: null });
    expect(m.modules).toEqual([{ id: "tally", entry: "modules/tally.js" }]);
    expect(m.skills).toEqual(["skills/harbor-guide"]);
    expect(m.rulepacks).toEqual(["rules/harbor-rules.yaml"]);
    expect(m.cards).toEqual([
      { path: "cards/drowned.json", kind: "world", notes: { en: "Import as the world." } },
      { path: "cards/sailor.json", kind: "character", notes: null },
    ]);
    expect(m.presentation).toBe("presentation.yaml");
    expect(m.assets).toEqual([{ path: "art/cover.png", mime: null, sha256: null, title: "Cover", license: "", tags: [] }]);
    expect(m.ignoredKeys).toEqual(["homepage"]);
  });

  test("the smallest manifest", () => {
    const parsed = parseManifest(BASE);
    expect(parsed.ok && parsed.manifest.modules).toEqual([]);
  });

  test("a module entry may be TypeScript in a source tree", () => {
    expect(parseManifest(`${BASE}modules: [{ id: a_b, entry: src/main.ts }]\n`).ok).toBe(true);
  });
});

describe("the version", () => {
  test("version 2 and version 1 are refused by code", () => {
    expect(problems(BASE.replace("manifest_version: 3", "manifest_version: 2"))).toEqual([{ code: "manifest_version_unsupported", path: "manifest_version", detail: "2" }]);
    expect(problems(BASE.replace("manifest_version: 3", "manifest_version: 1"))[0]?.code).toBe("manifest_version_unsupported");
  });

  test("a missing, later or malformed version", () => {
    expect(problems(BASE.replace("manifest_version: 3\n", ""))).toEqual([{ code: "manifest_version_missing", path: "manifest_version" }]);
    expect(problems(BASE.replace("manifest_version: 3", "manifest_version: 4"))[0]?.code).toBe("manifest_version_too_new");
    expect(problems(BASE.replace("manifest_version: 3", 'manifest_version: "3"'))[0]?.code).toBe("bad_field");
  });
});

describe("refusals", () => {
  const cases: [string, string, string][] = [
    ["not YAML", "id: [", "bad_yaml"],
    ["not a mapping", "- a\n- b\n", "not_a_mapping"],
    ["an alias", `${BASE}x: &a 1\ny: *a\n`, "bad_yaml"],
  ];
  for (const [label, source, code] of cases) test(label, () => expect(problems(source)[0]?.code).toBe(code as never));

  test("required fields", () => {
    const found = problems("manifest_version: 3\n").map((item) => `${item.code}@${item.path}`);
    expect(found).toEqual(["missing_field@id", "missing_field@version", "missing_field@name", "missing_field@description", "missing_field@license"]);
  });

  test("id and version shapes", () => {
    expect(problems(BASE.replace("id: p", "id: Bad_Id"))).toContainEqual({ code: "bad_id", path: "id" });
    expect(problems(BASE.replace("version: 1.0.0", "version: 1.0"))).toContainEqual({ code: "bad_version", path: "version" });
    expect(problems(BASE.replace("version: 1.0.0", "version: 1.0.0-rc.1+b2"))).toContainEqual({ code: "bad_version", path: "version" });
    expect(parseManifest(BASE.replace("version: 1.0.0", "version: 1.0.0-rc.1")).ok).toBe(true);
  });

  test("text over its cap is refused, not cut", () => {
    expect(problems(BASE.replace("name: P", `name: ${"名".repeat(2001)}`))).toContainEqual({ code: "too_long", path: "name" });
    expect(parseManifest(BASE.replace("name: P", `name: ${"名".repeat(2000)}`)).ok).toBe(true);
    expect(problems(BASE.replace("license: MIT", `license: ${"x".repeat(201)}`))).toContainEqual({ code: "too_long", path: "license" });
    expect(problems(`${BASE}authors: [${'"x",'.repeat(33)}]\n`)).toContainEqual({ code: "too_many", path: "authors" });
  });

  test("name in two languages, closed", () => {
    expect(problems(BASE.replace("name: P", "name: { fr: Le P }"))).toEqual([
      { code: "unknown_key", path: "name.fr" },
      { code: "missing_field", path: "name" },
    ]);
  });

  test("engine minimums", () => {
    expect(problems(`${BASE}engine: { protocol: "3.x" }\n`)).toContainEqual({ code: "bad_version", path: "engine.protocol" });
    expect(problems(`${BASE}engine: { client: "1" }\n`)).toContainEqual({ code: "unknown_key", path: "engine.client" });
  });

  test("modules", () => {
    expect(problems(`${BASE}modules: [{ id: Bad-Id, entry: a.js }]\n`)).toContainEqual({ code: "bad_id", path: "modules.0.id" });
    expect(problems(`${BASE}modules: [{ id: a, entry: a.py }]\n`)).toContainEqual({ code: "bad_path", path: "modules.0.entry", detail: "extension" });
    expect(problems(`${BASE}modules: [{ id: a, entry: ../a.js }]\n`)).toContainEqual({ code: "bad_path", path: "modules.0.entry", detail: "dot_segment" });
    expect(problems(`${BASE}modules: [{ id: a, entry: a.js }, { id: a, entry: b.js }]\n`)).toContainEqual({ code: "duplicate", path: "modules.1.id" });
    expect(problems(`${BASE}modules: [{ id: a, entry: a.js, deps: [] }]\n`)).toContainEqual({ code: "unknown_key", path: "modules.0.deps" });
    const many = Array.from({ length: MAX_MODULES + 1 }, (_, index) => `{ id: m${index}, entry: m${index}.js }`).join(", ");
    expect(problems(`${BASE}modules: [${many}]\n`)).toContainEqual({ code: "too_many", path: "modules" });
  });

  test("content kinds: 2.x kinds and unknown kinds", () => {
    expect(problems(`${BASE}contents: { panels: [p.yaml], presets: [x.json], prep: [p.js], lorebooks: [l.json] }\n`).map((item) => `${item.code}@${item.path}`)).toEqual([
      "unsupported_kind@contents.panels",
      "unsupported_kind@contents.presets",
      "unsupported_kind@contents.prep",
      "unsupported_kind@contents.lorebooks",
    ]);
    expect(problems(`${BASE}contents: { scripts: [a.js] }\n`)).toEqual([{ code: "unknown_kind", path: "contents.scripts" }]);
  });

  test("cards need a kind, and a known one", () => {
    expect(problems(`${BASE}contents: { cards: [c.json] }\n`)).toContainEqual({ code: "missing_field", path: "contents.cards.0.kind" });
    expect(problems(`${BASE}contents: { cards: [{ path: c.json, kind: npc }] }\n`)).toContainEqual({ code: "bad_field", path: "contents.cards.0.kind" });
    expect(problems(`${BASE}contents: { cards: [{ path: c.txt, kind: world }] }\n`)).toContainEqual({ code: "bad_path", path: "contents.cards.0.path", detail: "extension" });
  });

  test("rule packs and the presentation kit", () => {
    expect(problems(`${BASE}contents: { rulepacks: [r/Bad.yaml] }\n`)).toContainEqual({ code: "bad_id", path: "contents.rulepacks.0", detail: "Bad" });
    expect(problems(`${BASE}contents: { rulepacks: [a/x.yaml, b/x.yml] }\n`)).toContainEqual({ code: "duplicate", path: "contents.rulepacks.1", detail: "x" });
    expect(problems(`${BASE}contents: { presentation: [a.yaml, b.yaml] }\n`)).toContainEqual({ code: "too_many", path: "contents.presentation" });
  });

  test("one file, one role", () => {
    expect(problems(`${BASE}contents: { cards: [{ path: art/a.png, kind: character }] }\nassets: [art/a.png]\n`)).toContainEqual({ code: "duplicate", path: "assets.0.path", detail: "art/a.png" });
    expect(problems(`${BASE}contents: { skills: [a/guide, b/guide] }\n`)).toContainEqual({ code: "duplicate", path: "contents.skills.1", detail: "guide" });
  });

  test("assets", () => {
    expect(problems(`${BASE}assets: [{ path: a.png, sha256: nothex }]\n`)).toContainEqual({ code: "bad_field", path: "assets.0.sha256" });
    expect(problems(`${BASE}assets: [{ path: a.png, tags: [${'"t",'.repeat(17)}] }]\n`)).toContainEqual({ code: "too_many", path: "assets.0.tags" });
    const many = Array.from({ length: MAX_ASSETS + 1 }, (_, index) => `a${index}.png`).join(", ");
    expect(problems(`${BASE}assets: [${many}]\n`)).toContainEqual({ code: "too_many", path: "assets" });
    expect(problems(`${BASE}assets: [pack.yaml]\n`)).toContainEqual({ code: "bad_path", path: "assets.0.path", detail: "manifest" });
  });
});

test("engine minimums compare as integer tuples, ignoring the runtime's suffix", () => {
  expect(versionAtLeast("3.0.0-alpha.0", "3.0")).toBe(true);
  expect(versionAtLeast("3.0", "3.0.1")).toBe(false);
  expect(versionAtLeast("3.10", "3.9")).toBe(true);
});
