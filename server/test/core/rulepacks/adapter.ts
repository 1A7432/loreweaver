// Loads the packs the reference vectors use through the rule-pack compiler: the three
// built-ins (from the embedded text) and the literal packs the exporter wrote
// (`oraclesynth`, `oraclepool` in `rules_synthetic`; `oraclescript` in
// `rules_script_lane`).
import { builtInPacks, compileRulePack, type RulePack, RulePackRegistry } from "../../../src/core/rulepacks/index.ts";
import { readReference } from "../../reference.ts";

interface PackRow {
  kind: string;
  pack: string;
  yaml: string;
}

/** The literal packs' YAML text by id, in the order the exporter wrote them. */
export function literalPackSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of ["rules_synthetic", "rules_script_lane"]) {
    for (const row of readReference<PackRow>(name)) if (row.kind === "pack") out.set(row.pack, row.yaml);
  }
  return out;
}

let cache: Map<string, RulePack> | null = null;

/** Every pack the vectors use that compiles (the script pack is refused), by id. */
export function vectorPacks(): Map<string, RulePack> {
  if (cache !== null) return cache;
  cache = new Map(builtInPacks().map((pack) => [pack.id, pack]));
  for (const [id, yaml] of literalPackSources()) {
    if (id === "oraclescript") continue;
    cache.set(id, compileRulePack(id, yaml));
  }
  return cache;
}

export function vectorPack(id: string): RulePack {
  const pack = vectorPacks().get(id);
  if (pack === undefined) throw new Error(`no compiled pack ${id}`);
  return pack;
}

/** Built-ins first (their names win), then the literal packs, as the reference discovered them. */
export function vectorRegistry(): RulePackRegistry {
  return new RulePackRegistry(vectorPacks().values());
}
