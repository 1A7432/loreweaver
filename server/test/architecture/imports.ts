// Import rules of the server tree, as a pure function over (path → source) so the
// rules themselves can be tested against synthetic trees.
//
//   1. Layer direction: infra < core < agent < gateway < net < cli. A file imports only
//      from its own layer or a lower one. `worker` is the other thread's entry: it may
//      import `infra` and `core`, and nothing may import it.
//   2. Bun-specific APIs (`bun:*` imports, the `Bun` global) appear only under
//      `infra/runtime/`.
//   3. Nothing reachable from `worker/` imports the database: the room worker runs
//      content code beside pure engine code and never holds the store.
//   4. A relative import names its file with the extension, so the tree also loads
//      under a runtime that strips types without resolving extensions.
//   5. The only thing imported from outside `src/` by path is data — message catalogs
//      (`.json`), the built-in content a compiled binary must carry (`.yaml`, `.md`,
//      `.txt`), and the vendored libraries under `assets/vendor/`, which are imported AS
//      TEXT to be run inside a template context, never as modules. Code outside `src/`
//      is reached as a package or not at all.
//   6. Stored documents are read whole only by the code that defines what they mean
//      (`core/`) and by the Keeper's tools (`agent/`). The gateway, the transports and
//      the worker reach room content through projections (`core/documents/views.ts`),
//      so a whole payload cannot reach a connection by oversight (iron rule 3).

const LAYERS = ["infra", "core", "agent", "gateway", "net", "cli"] as const;
const WORKER = "worker";
const WORKER_MAY_IMPORT = new Set(["infra", "core", WORKER]);
const WORKER_FORBIDDEN_SPECIFIERS = new Set(["bun:sqlite"]);
const RUNTIME_DIR = "infra/runtime/";
const RAW_DOCUMENTS = "core/documents/raw.ts";
const RAW_DOCUMENT_READERS = new Set(["core", "agent"]);

export interface Violation {
  readonly file: string;
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6;
  readonly detail: string;
}

interface Scanned {
  readonly specifiers: readonly string[];
  readonly usesBunGlobal: boolean;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

function scan(source: string): Scanned {
  const specifiers = transpiler.scan(source).imports.map((entry) => entry.path);
  // Transpiled output carries no comments and no types, so a mention of `Bun` in
  // either cannot trip the rule.
  const usesBunGlobal = /(?<![.\w$])Bun\s*\./.test(transpiler.transformSync(source));
  return { specifiers, usesBunGlobal };
}

function layerOf(file: string): string {
  return file.split("/", 1)[0] ?? "";
}

/** The target's path relative to `src/`, or null when the import leaves `src/`. */
function resolveRelative(from: string, specifier: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/** `files` maps a path relative to `src/` (forward slashes) to its source text. */
export function checkImports(files: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];
  const edges = new Map<string, string[]>();
  const external = new Map<string, string[]>();

  for (const [file, source] of files) {
    const { specifiers, usesBunGlobal } = scan(source);
    const layer = layerOf(file);
    const inRuntime = file.startsWith(RUNTIME_DIR);
    const targets: string[] = [];
    const packages: string[] = [];

    if (usesBunGlobal && !inRuntime) {
      violations.push({ file, rule: 2, detail: "uses the Bun global outside infra/runtime/" });
    }

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        packages.push(specifier);
        if (specifier.startsWith("bun:") && !inRuntime) {
          violations.push({ file, rule: 2, detail: `imports ${specifier} outside infra/runtime/` });
        }
        continue;
      }
      if (!/\.(ts|js|json|yaml|md|txt)$/.test(specifier)) {
        violations.push({ file, rule: 4, detail: `relative import without an extension: ${specifier}` });
      }
      const target = resolveRelative(file, specifier);
      if (target === null) {
        const vendored = /(^|\/)assets\/vendor\/[^/]+\.js$/.test(specifier);
        if (!vendored && !/\.(json|yaml|md|txt)$/.test(specifier)) {
          violations.push({ file, rule: 5, detail: `imports code from outside src/: ${specifier}` });
        }
        continue;
      }
      targets.push(target);
      if (target === RAW_DOCUMENTS && !RAW_DOCUMENT_READERS.has(layer)) {
        violations.push({ file, rule: 6, detail: `${layer} reads stored documents directly: ${target}` });
      }
      const targetLayer = layerOf(target);
      if (targetLayer === layer) continue;
      if (targetLayer === WORKER) {
        violations.push({ file, rule: 1, detail: `imports the worker entry tree: ${target}` });
      } else if (layer === WORKER) {
        if (!WORKER_MAY_IMPORT.has(targetLayer)) {
          violations.push({ file, rule: 1, detail: `worker imports ${targetLayer}: ${target}` });
        }
      } else {
        const from = LAYERS.indexOf(layer as (typeof LAYERS)[number]);
        const to = LAYERS.indexOf(targetLayer as (typeof LAYERS)[number]);
        if (from < 0 || to < 0) {
          violations.push({ file, rule: 1, detail: `outside the known layers: ${file} -> ${target}` });
        } else if (to > from) {
          violations.push({ file, rule: 1, detail: `${layer} imports the higher layer ${targetLayer}: ${target}` });
        }
      }
    }
    edges.set(file, targets);
    external.set(file, packages);
  }

  const seen = new Set<string>();
  const queue = [...files.keys()].filter((file) => layerOf(file) === WORKER);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of external.get(file) ?? []) {
      if (WORKER_FORBIDDEN_SPECIFIERS.has(specifier)) {
        violations.push({ file, rule: 3, detail: `reachable from worker/ and imports ${specifier}` });
      }
    }
    queue.push(...(edges.get(file) ?? []));
  }
  return violations;
}
