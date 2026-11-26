// Loading a pack's module inside the room worker. A module is written against
// `loreweaver/module`; a pack directory has no node_modules to find it in, so the
// worker answers that import itself with the SDK the server was built with. A module
// file with no other dependency therefore needs no build step, and a bundled one
// (dependencies inlined by the pack build) loads the same way.
import * as sdk from "loreweaver/module";

let registered = false;

function registerSdk(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "loreweaver-sdk",
    setup(build) {
      build.module("loreweaver/module", () => ({ exports: { ...sdk }, loader: "object" }));
    },
  });
}

/**
 * Import a module entry file (TypeScript or JavaScript) and return its default export.
 * Whether that is a usable definition is the runner's to judge, at load.
 */
export async function importModule(path: string): Promise<unknown> {
  registerSdk();
  const loaded = (await import(path)) as { default?: unknown };
  return loaded.default;
}
