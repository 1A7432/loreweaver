// The built-in skills are imported as TEXT (`with { type: "text" }`) so a compiled binary
// carries them; the file is parsed by `parse.ts`, never run.
declare module "*/SKILL.md" {
  const source: string;
  export default source;
}
