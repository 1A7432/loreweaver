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

/**
 * Panels: a template panel reading a built-in view and the module's view (with a picture),
 * an admin-only template reading the variables, and a page with a template fallback.
 */
export const PANELS_YAML = `panels:
  - id: tide
    title: { en: The tide, zh: 潮汐 }
    slot: sidebar
    views: { me: me, tide: tally/tide }
    blocks:
      - { kind: meter, label: { en: Tide, zh: 潮位 }, value: { $view: tide.level }, min: 0, max: 10 }
      - kind: image
        src: art/chart.png
        caption: Harbor chart
      - repeat:
          each: me.character.resources
          as: r
          block: { kind: meter, label: { $view: r.label }, value: { $view: r.value }, min: 0, max: { $view: r.max } }
      - kind: choices
        prompt: Ring the bell?
        options:
          - { id: ring, label: Ring it, command: tally/ring, args: { times: 2 } }
        visible_when: "tide.level >= 5"
  - id: ledger
    title: Keeper ledger
    slot: tray
    audience: admin
    views: { vars: variables }
    blocks:
      - repeat: { each: vars.module, block: { kind: stat, label: { $view: item.label }, value: { $view: item.value } } }
  - id: chart
    title: Sea chart
    slot: modal
    views: { tide: tally/tide }
    entry: ui/chart.html
    fallback:
      - { kind: text, text: { $view: tide.level } }
  - id: notes
    title: Keeper notes
    slot: tray
    audience: admin
    views: { vars: variables }
    entry: ui/notes.html
    fallback: null
`;
export const NOTES_HTML = "<!doctype html><html><body>admin notes</body></html>\n";
export const PAGE_HTML = "<!doctype html><html><body><script>window.loreweaver && window.loreweaver.ready()</script></body></html>\n";
export const CHART_PNG = PNG_BYTES.map((byte, index) => (index < 8 ? byte : (byte + 5) % 256));

export function manifestYaml(overrides: { readonly id?: string; readonly version?: string; readonly entry?: string; readonly extra?: string; readonly panels?: boolean } = {}): string {
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
  presentation: [presentation.yaml]${overrides.panels === true ? "\n  panels: [ui/panels.yaml]" : ""}
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
  if (manifest.includes("ui/panels.yaml")) {
    files.set("ui/panels.yaml", text(PANELS_YAML));
    files.set("ui/chart.html", text(PAGE_HTML));
    files.set("ui/notes.html", text(NOTES_HTML));
    files.set("art/chart.png", CHART_PNG);
  }
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
