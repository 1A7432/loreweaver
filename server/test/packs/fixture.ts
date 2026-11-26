// A small pack of every content kind, as literals: as archive entries (for `readPack` and
// installation) and as an authoring source tree on disk (for the build). Never read from
// the untracked content directories.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PackEntry } from "../../src/core/packs/index.ts";
import { jsonFile, plainCard, worldCard } from "../gateway/card_files.ts";

const encoder = new TextEncoder();
export const text = (value: string): Uint8Array => encoder.encode(value);

/** The bytes of a PNG as far as any signature check reads them. */
export const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, i) => (i * 13) % 256)]);
export const OGG_BYTES = Uint8Array.from([...text("OggS"), ...Array.from({ length: 64 }, (_, i) => (i * 7) % 256)]);

/** A bundled module (already one file) that injects a line and counts turns. */
export const BUNDLED_MODULE = `import { defineModule } from "loreweaver/module";
let turns = 0;
export default defineModule({
  id: "tally",
  create() { turns = 0; },
  load(snapshot) { turns = snapshot.turns; },
  save() { return { turns }; },
  on: { turnStart(event, fx) { turns += 1; fx.inject("tally saw turn " + turns); } },
});
`;

export const SKILL_MD = `---
name: Harbor guide
name-zh: 港口向导
description: How the harbor works.
allowed-tools: [generate_image]
---
Speak of the tides.
`;

export const RULEPACK_YAML = "extends: coc7\nnames: [Harbor Rules]\n";

export const KIT_YAML = `version: 2
style:
  keywords: { en: ink wash }
subjects:
  - { id: quay, kind: location, name: The quay, ref: art/quay.png }
audio:
  - { id: bell, layer: ambience, asset: sound/bell.ogg, title: Harbor bell }
`;

export function manifestYaml(overrides: { readonly id?: string; readonly version?: string; readonly entry?: string; readonly extra?: string } = {}): string {
  return `manifest_version: 3
id: ${overrides.id ?? "harbor"}
version: ${overrides.version ?? "1.0.0"}
name: { en: Harbor, zh: 港口 }
description: A small harbor town.
authors: [Ada]
license: CC-BY-4.0
engine: { protocol: "3.0" }
modules:
  - { id: tally, entry: ${overrides.entry ?? "modules/tally.js"} }
contents:
  skills: [skills/harbor-guide]
  rulepacks: [rules/harbor-rules.yaml]
  cards:
    - { path: cards/drowned.json, kind: world, notes: Import as the world. }
    - { path: cards/sailor.json, kind: character }
  presentation: [presentation.yaml]
assets:
  - { path: art/cover.png, title: Cover }
${overrides.extra ?? ""}`;
}

/** The pack as archive entries, with `replace` overriding (or, with null, removing) files by path. */
export function packEntries(replace: Readonly<Record<string, Uint8Array | null>> = {}, manifest = manifestYaml()): PackEntry[] {
  const files = new Map<string, Uint8Array>([
    ["pack.yaml", text(manifest)],
    ["modules/tally.js", text(BUNDLED_MODULE)],
    ["skills/harbor-guide/SKILL.md", text(SKILL_MD)],
    ["rules/harbor-rules.yaml", text(RULEPACK_YAML)],
    ["cards/drowned.json", jsonFile(worldCard("Drowned City"))],
    ["cards/sailor.json", jsonFile(plainCard("Mara"))],
    ["presentation.yaml", text(KIT_YAML)],
    ["art/quay.png", PNG_BYTES],
    ["art/cover.png", PNG_BYTES.map((byte, index) => (index < 8 ? byte : (byte + 1) % 256))],
    ["sound/bell.ogg", OGG_BYTES],
  ]);
  for (const [path, bytes] of Object.entries(replace)) {
    if (bytes === null) files.delete(path);
    else files.set(path, bytes);
  }
  return [...files].map(([path, bytes]) => ({ path, bytes }));
}

/** A module's TypeScript source that imports a helper: the authoring form the build bundles. */
export const MODULE_SOURCE = `import { defineModule } from "loreweaver/module";
import { line } from "./line.ts";
let turns: number = 0;
export default defineModule({
  id: "tally",
  create() { turns = 0; },
  load(snapshot) { turns = (snapshot as { turns: number }).turns; },
  save() { return { turns }; },
  on: { turnStart(_event, fx) { turns += 1; fx.inject(line(turns)); } },
});
`;
export const MODULE_HELPER = `export function line(turns: number): string { return "tally saw turn " + turns; }\n`;

/** Write the pack as an authoring source tree under `dir` (module in TypeScript, not bundled). */
export function writeSourceTree(dir: string, options: { readonly manifest?: string; readonly extra?: Readonly<Record<string, Uint8Array | string>> } = {}): void {
  const files = new Map<string, Uint8Array | string>(packEntries({ "modules/tally.js": null }, options.manifest ?? manifestYaml({ entry: "src/tally.ts" })).map((entry) => [entry.path, entry.bytes]));
  files.set("src/tally.ts", MODULE_SOURCE);
  files.set("src/line.ts", MODULE_HELPER);
  for (const [path, bytes] of Object.entries(options.extra ?? {})) files.set(path, bytes);
  for (const [path, bytes] of files) {
    const target = join(dir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}
