// Bundling a module at pack-build time: the entry and everything it imports become ONE
// file, with Bun's bundler (decision 24 — a pack carries its dependencies, and nothing is
// installed when a pack is installed). `loreweaver/module` stays an import: the room
// worker answers it with the SDK the server was built with (`module_loader.ts`), so a
// module never carries a copy of its own. Node built-ins stay imports too.
//
// The bundler marks where each part came from with a comment naming its path relative to
// the working directory; those comments are rewritten to be relative to the source tree,
// so the same tree bundles to the same bytes wherever the build is run from.
import { relative, sep } from "node:path";

/** The one specifier a module imports from the host instead of bundling. */
export const HOST_SDK = "loreweaver/module";

export type Bundled = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly code: "bundle_failed"; readonly detail: string };

/** Bundle `entry` (an absolute path inside `root`, the pack's source tree) into one ESM file. */
export async function bundleModule(entry: string, root: string): Promise<Bundled> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      splitting: false,
      sourcemap: "none",
      minify: false,
      external: [HOST_SDK],
      throw: false,
    });
  } catch (error) {
    return { ok: false, code: "bundle_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!result.success) return { ok: false, code: "bundle_failed", detail: result.logs.map((log) => String(log)).join("\n") || "the bundler failed" };
  const outputs = result.outputs.filter((output) => output.kind === "entry-point");
  if (outputs.length !== 1 || result.outputs.length !== 1) return { ok: false, code: "bundle_failed", detail: "the module did not bundle into exactly one file" };
  const code = await (outputs[0] as (typeof outputs)[number]).text();
  return { ok: true, code: rebase(code, root) };
}

/** Path comments relative to `root` instead of the working directory. */
function rebase(code: string, root: string): string {
  const fromCwd = relative(process.cwd(), root);
  if (fromCwd === "") return code;
  const forms = new Set([fromCwd, fromCwd.split(sep).join("/"), fromCwd.split(sep).join("\\")]);
  return code
    .split("\n")
    .map((line) => {
      if (!line.startsWith("// ")) return line;
      for (const form of forms) {
        for (const separator of ["/", "\\"]) {
          const prefix = `// ${form}${separator}`;
          if (line.startsWith(prefix)) return `// ${line.slice(prefix.length).split("\\").join("/")}`;
        }
      }
      return line;
    })
    .join("\n");
}
