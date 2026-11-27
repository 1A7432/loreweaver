// Building a source tree into a `.lwpack` (the same tree gives the same bytes), installing
// it into a data directory (the files on disk and the index), the install refusals, and
// loading the installed packs back at start-up — a damaged one skipped with a note.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/cli/main.ts";
import { buildPack, installPack, listPacks, loadInstalledPacks, uninstallPack } from "../../src/cli/packs.ts";
import { openServer } from "../../src/cli/compose.ts";
import { assemblePacks } from "../../src/gateway/packs.ts";
import { loadSettings } from "../../src/infra/config.ts";
import type { FetchLike } from "../../src/infra/packs/fetch.ts";
import { PackDirectory } from "../../src/infra/packs/files.ts";
import { readZip, writeZip } from "../../src/infra/zip.ts";
import { jsonFile, worldCard } from "../gateway/card_files.ts";
import { WORKER_ENTRY } from "../helpers.ts";
import { manifestYaml, packEntries, SKILL_MD, text, writeSourceTree } from "./fixture.ts";

const root = mkdtempSync(join(tmpdir(), "loreweaver-packs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fresh(name: string): string {
  counter += 1;
  return join(root, `${name}-${counter}`);
}

const NO_FETCH: FetchLike = () => Promise.reject(new Error("no network in tests"));

/** A pack archive on disk, from the in-memory fixture (`replace` and `manifest` as `packEntries`). */
function archiveFile(replace: Parameters<typeof packEntries>[0] = {}, manifest?: string): string {
  const file = `${fresh("archive")}.lwpack`;
  const entries = packEntries(replace, manifest);
  writeFileSync(file, writeZip([...entries].sort((a, b) => (a.path === "pack.yaml" ? -1 : b.path === "pack.yaml" ? 1 : a.path < b.path ? -1 : 1))));
  return file;
}

describe("build", () => {
  test("the same source tree gives the same bytes, wherever it is built to", async () => {
    const source = fresh("source");
    writeSourceTree(source, { extra: { "skills/harbor-guide/hooks.js": "module.exports = {}", "src/unused.ts": "export {}" } });
    const first = await buildPack(source, { out: `${fresh("out")}.lwpack` });
    const second = await buildPack(source, { out: `${fresh("out")}.lwpack` });
    if (!first.ok || !second.ok) throw new Error(JSON.stringify([first, second]));
    expect(first.sha256).toBe(second.sha256);
    expect(Buffer.from(readFileSync(first.out)).equals(Buffer.from(readFileSync(second.out)))).toBe(true);
    expect(first.ignored).toEqual(["skills/harbor-guide/hooks.js"]);
    expect(first.trust.runsCode).toBe(true);
  });

  test("the archive: pack.yaml first, the module bundled into one file, no source, no hooks.js", async () => {
    const source = fresh("source");
    writeSourceTree(source, { extra: { "skills/harbor-guide/hooks.js": "module.exports = {}" } });
    const built = await buildPack(source, { out: `${fresh("out")}.lwpack` });
    if (!built.ok) throw new Error(JSON.stringify(built));
    const read = readZip(new Uint8Array(readFileSync(built.out)));
    if (!read.ok) throw new Error(read.code);
    const paths = read.entries.map((entry) => entry.path);
    expect(paths[0]).toBe("pack.yaml");
    expect(paths.slice(1)).toEqual([...paths.slice(1)].sort());
    expect(paths).toContain("modules/tally.js");
    expect(paths.filter((path) => path.endsWith(".ts") || path.endsWith("hooks.js"))).toEqual([]);
    const bundled = new TextDecoder().decode(read.entries.find((entry) => entry.path === "modules/tally.js")?.bytes);
    // The host's SDK stays an import; the helper is inlined; no build machine's path leaks in.
    expect(bundled).toContain('from "loreweaver/module"');
    expect(bundled).toContain("tally saw turn");
    expect(bundled).not.toContain("./line");
    expect(bundled).not.toContain(root);
    const manifest = new TextDecoder().decode(read.entries[0]?.bytes);
    expect(manifest).toContain("entry: modules/tally.js");
  });

  test("refusals: no pack.yaml, a missing entry, a module that does not bundle, a pack that does not validate", async () => {
    expect(await buildPack(fresh("nowhere"))).toEqual({ ok: false, code: "source_not_found" });
    const empty = fresh("source");
    writeSourceTree(empty);
    rmSync(join(empty, "pack.yaml"));
    expect(await buildPack(empty)).toMatchObject({ ok: false, code: "no_manifest" });
    const missing = fresh("source");
    writeSourceTree(missing);
    rmSync(join(missing, "src", "tally.ts"));
    expect(await buildPack(missing)).toMatchObject({ ok: false, code: "missing_file", path: "src/tally.ts" });
    const broken = fresh("source");
    writeSourceTree(broken, { extra: { "src/tally.ts": 'import { nothing } from "./nowhere.ts";\nexport default nothing;\n' } });
    expect(await buildPack(broken, { out: `${fresh("out")}.lwpack` })).toMatchObject({ ok: false, code: "bundle_failed", path: "src/tally.ts" });
    const lying = fresh("source");
    writeSourceTree(lying, { extra: { "cards/sailor.json": jsonFile(worldCard("Sneaky")) } });
    expect(await buildPack(lying, { out: `${fresh("out")}.lwpack` })).toMatchObject({ ok: false, code: "invalid_pack", problems: [{ code: "card_kind_mismatch", path: "cards/sailor.json" }] });
    const old = fresh("source");
    writeSourceTree(old, { manifest: manifestYaml({ entry: "src/tally.ts" }).replace("manifest_version: 3", "manifest_version: 2") });
    expect(await buildPack(old)).toMatchObject({ ok: false, code: "invalid_manifest", problems: [{ code: "manifest_version_unsupported" }] });
  });
});

describe("install", () => {
  test("without yes: the trust card, and nothing written", async () => {
    const dataDir = fresh("data");
    const outcome = await installPack(dataDir, archiveFile(), { yes: false, fetch: NO_FETCH });
    expect(outcome).toMatchObject({ ok: true, installed: false, id: "harbor", version: "1.0.0", replaced: null, trust: { runsCode: true } });
    expect(existsSync(join(dataDir, "packs"))).toBe(false);
  });

  test("with yes: the declared files under packs/<id>/<version>/, private, and the index", async () => {
    const dataDir = fresh("data");
    const outcome = await installPack(dataDir, archiveFile({ "skills/harbor-guide/hooks.js": text("x"), "notes.txt": text("hi") }), { yes: true, fetch: NO_FETCH, now: () => 1234 });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.installed).toBe(true);
    const home = join(dataDir, "packs", "harbor", "1.0.0");
    for (const path of ["pack.yaml", "modules/tally.js", "skills/harbor-guide/SKILL.md", "rules/harbor-rules.yaml", "cards/drowned.json", "cards/sailor.json", "presentation.yaml", "art/quay.png", "art/cover.png", "sound/bell.ogg"]) {
      expect([path, existsSync(join(home, ...path.split("/")))]).toEqual([path, true]);
    }
    // Ignored files are not installed.
    expect(existsSync(join(home, "skills", "harbor-guide", "hooks.js"))).toBe(false);
    expect(existsSync(join(home, "notes.txt"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(join(home, "pack.yaml")).mode & 0o077).toBe(0);
      expect(statSync(join(dataDir, "packs", "index.json")).mode & 0o077).toBe(0);
    }
    const index = JSON.parse(readFileSync(join(dataDir, "packs", "index.json"), "utf8")) as unknown;
    expect(index).toEqual({ version: 1, packs: [{ id: "harbor", version: "1.0.0", sha256: outcome.sha256, installed_at: 1234 }] });
    expect(listPacks(dataDir)).toEqual({ ok: true, packs: [{ id: "harbor", version: "1.0.0", name: { en: "Harbor", zh: "港口" }, sha256: outcome.sha256, installedAt: 1234 }] });
  });

  test("install --force replaces the installed pack of the same id and version; without it the same version is refused", async () => {
    const dataDir = fresh("data");
    const env = { TRPG_DATA_DIR: dataDir };
    const first = archiveFile();
    expect((await run(["install", first, "--yes"], env)).code).toBe(0);
    const changed = archiveFile({ "skills/harbor-guide/SKILL.md": text(SKILL_MD.replace("Speak of the tides.", "Revised.")) });
    const refused = await run(["install", changed, "--yes"], env);
    expect([refused.code, JSON.parse(refused.out) as unknown]).toEqual([1, { ok: false, code: "already_installed", detail: "harbor@1.0.0" }]);
    // Without --yes, --force discloses and writes nothing.
    const shown = JSON.parse((await run(["install", changed, "--force"], env)).out) as { installed: boolean; replaced: string | null };
    expect([shown.installed, shown.replaced]).toEqual([false, "1.0.0"]);
    const home = join(dataDir, "packs", "harbor", "1.0.0");
    expect(readFileSync(join(home, "skills", "harbor-guide", "SKILL.md"), "utf8")).not.toContain("Revised.");
    const forced = await run(["install", changed, "--force", "--yes"], env);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.out)).toMatchObject({ ok: true, installed: true, id: "harbor", version: "1.0.0", replaced: "1.0.0" });
    expect(readFileSync(join(home, "skills", "harbor-guide", "SKILL.md"), "utf8")).toContain("Revised.");
    const listed = listPacks(dataDir);
    expect(listed.ok && listed.packs.map((pack) => [pack.id, pack.version])).toEqual([["harbor", "1.0.0"]]);
    // A flag the command does not know, or one given twice, is a usage error.
    expect((await run(["install", changed, "--yes", "--yes"], env)).code).toBe(2);
    expect((await run(["install", changed, "--overwrite"], env)).code).toBe(2);
  });

  test("refusals: http, a pack already installed at that version, an invalid pack, an engine too old, not a zip", async () => {
    const dataDir = fresh("data");
    expect(await installPack(dataDir, "http://example.org/harbor.lwpack", { yes: true, fetch: NO_FETCH })).toEqual({ ok: false, code: "not_https" });
    const file = archiveFile();
    expect((await installPack(dataDir, file, { yes: true, fetch: NO_FETCH })).ok).toBe(true);
    expect(await installPack(dataDir, file, { yes: true, fetch: NO_FETCH })).toEqual({ ok: false, code: "already_installed", detail: "harbor@1.0.0" });
    expect(await installPack(dataDir, archiveFile({}, manifestYaml().replace("manifest_version: 3", "manifest_version: 2")), { yes: true, fetch: NO_FETCH })).toMatchObject({
      ok: false,
      code: "invalid_pack",
      problems: [{ code: "manifest_version_unsupported" }],
    });
    expect(await installPack(dataDir, archiveFile({}, manifestYaml({ id: "future" }).replace('protocol: "3.0"', 'protocol: "9.1"')), { yes: true, fetch: NO_FETCH })).toEqual({
      ok: false,
      code: "engine_too_old",
      detail: "protocol 9.1",
    });
    const notZip = `${fresh("bad")}.lwpack`;
    writeFileSync(notZip, "not a zip");
    expect(await installPack(dataDir, notZip, { yes: true, fetch: NO_FETCH })).toEqual({ ok: false, code: "zip_not_a_zip" });
  });

  test("a gh: release with no pack asset is refused", async () => {
    const fetch: FetchLike = (url) => Promise.resolve(url.includes("api.github.com") ? Response.json({ assets: [{ name: "readme.md", browser_download_url: "https://x/readme.md" }] }) : new Response("", { status: 404 }));
    expect(await installPack(fresh("data"), "gh:ada/harbor@v1", { yes: true, fetch })).toEqual({ ok: false, code: "no_pack_asset" });
  });

  test("an oversized download is refused", async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response("x", { headers: { "content-length": String(600 * 1024 * 1024) } }));
    expect(await installPack(fresh("data"), "https://example.org/huge.lwpack", { yes: true, fetch })).toEqual({ ok: false, code: "too_large" });
  });

  test("a new version replaces the old one in its place; uninstall removes it", async () => {
    const dataDir = fresh("data");
    await installPack(dataDir, archiveFile({}, manifestYaml({ id: "first" })), { yes: true, fetch: NO_FETCH });
    await installPack(dataDir, archiveFile(), { yes: true, fetch: NO_FETCH });
    await installPack(dataDir, archiveFile({}, manifestYaml({ id: "last" })), { yes: true, fetch: NO_FETCH });
    const upgraded = await installPack(dataDir, archiveFile({}, manifestYaml({ version: "1.1.0" })), { yes: true, fetch: NO_FETCH });
    expect(upgraded).toMatchObject({ ok: true, installed: true, replaced: "1.0.0" });
    const listed = listPacks(dataDir);
    expect(listed.ok && listed.packs.map((pack) => `${pack.id}@${pack.version}`)).toEqual(["first@1.0.0", "harbor@1.1.0", "last@1.0.0"]);
    expect(existsSync(join(dataDir, "packs", "harbor", "1.0.0"))).toBe(false);
    expect(uninstallPack(dataDir, "harbor")).toEqual({ ok: true, id: "harbor" });
    expect(existsSync(join(dataDir, "packs", "harbor"))).toBe(false);
    expect(uninstallPack(dataDir, "harbor")).toEqual({ ok: false, code: "not_installed" });
  });

  test("what a pack would shadow is named: a built-in skill id, a rule system an earlier pack claims", async () => {
    const dataDir = fresh("data");
    await installPack(dataDir, archiveFile(), { yes: true, fetch: NO_FETCH });
    const second = manifestYaml({ id: "harbor-two" }).replace("skills: [skills/harbor-guide]", "skills: [skills/mature-mode]");
    const outcome = await installPack(dataDir, archiveFile({ "skills/mature-mode/SKILL.md": text("---\nname: Mine\n---\nBody.\n") }, second), { yes: false, fetch: NO_FETCH });
    expect(outcome).toMatchObject({ ok: true, shadowed: { ruleSystems: ["harbor-rules"], skills: ["mature-mode"] } });
  });
});

describe("loading installed packs", () => {
  test("every installed pack validates again; registries take built-ins first, then packs in install order", async () => {
    const dataDir = fresh("data");
    await installPack(dataDir, archiveFile(), { yes: true, fetch: NO_FETCH });
    await installPack(dataDir, archiveFile({}, manifestYaml({ id: "harbor-two" })), { yes: true, fetch: NO_FETCH });
    const loaded = loadInstalledPacks(dataDir);
    expect(loaded.notes).toEqual([]);
    expect(loaded.packs.map((entry) => entry.pack.manifest.id)).toEqual(["harbor", "harbor-two"]);
    const assembled = assemblePacks(loaded.packs);
    expect(assembled.ruleSystems.ids()).toEqual(["coc7", "dnd5e", "wod", "harbor-rules"]);
    expect(assembled.ruleSystems.get("harbor-rules")).toBe(loaded.packs[0]?.pack.ruleSystems[0]?.compiled ?? null);
    expect(assembled.notes).toEqual(["rule_system_shadowed:harbor-two:harbor-rules", "skill_shadowed:harbor-two:harbor-guide"]);
    expect(assembled.skills.get("harbor-guide")).toBe(loaded.packs[0]?.pack.skills[0]?.skill ?? null);
  });

  test("a pack damaged on disk is skipped with a note; a damaged index is one note", async () => {
    const dataDir = fresh("data");
    await installPack(dataDir, archiveFile(), { yes: true, fetch: NO_FETCH });
    await installPack(dataDir, archiveFile({}, manifestYaml({ id: "intact" })), { yes: true, fetch: NO_FETCH });
    writeFileSync(join(dataDir, "packs", "harbor", "1.0.0", "cards", "sailor.json"), jsonFile(worldCard("Changed")));
    writeFileSync(join(dataDir, "packs", "harbor", "1.0.0", "extra.js"), "planted");
    const loaded = loadInstalledPacks(dataDir);
    expect(loaded.packs.map((entry) => entry.pack.manifest.id)).toEqual(["intact"]);
    expect(loaded.notes).toEqual(["pack_invalid:harbor@1.0.0:card_kind_mismatch"]);
    writeFileSync(join(dataDir, "packs", "index.json"), "{ not json");
    expect(loadInstalledPacks(dataDir)).toEqual({ packs: [], notes: ["pack_index_unreadable"] });
  });

  test("the server starts with a damaged installed pack, and says so", async () => {
    const dataDir = fresh("data");
    await installPack(dataDir, archiveFile(), { yes: true, fetch: NO_FETCH });
    rmSync(join(dataDir, "packs", "harbor", "1.0.0", "modules", "tally.js"));
    const server = await openServer(loadSettings({ TRPG_DATA_DIR: dataDir }), { mode: "local", workerEntry: WORKER_ENTRY, report: () => undefined });
    try {
      expect(server.notes).toContain("pack_invalid:harbor@1.0.0:missing_file");
    } finally {
      await server.close();
    }
  });
});

test("build: a pack's panels files travel with their pages and pictures", async () => {
  const source = fresh("source");
  writeSourceTree(source, { manifest: manifestYaml({ entry: "src/tally.ts", panels: true }) });
  const built = await buildPack(source, { out: `${fresh("out")}.lwpack` });
  if (!built.ok) throw new Error(JSON.stringify(built));
  const read = readZip(new Uint8Array(readFileSync(built.out)));
  if (!read.ok) throw new Error(read.code);
  expect(read.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["ui/panels.yaml", "ui/chart.html", "art/chart.png"]));
  expect(built.trust.panels.map((panel) => panel.id)).toEqual(["tide", "ledger", "chart", "notes"]);
});

test("a pack directory is absolute whatever the data directory was written as", () => {
  // `./data` is the default data directory; the entry files under it are handed to a worker
  // thread and to the module loader, and must name the same file there.
  const root = new PackDirectory("data").root;
  expect(root.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(root)).toBe(true);
  expect(root.endsWith("packs")).toBe(true);
});
