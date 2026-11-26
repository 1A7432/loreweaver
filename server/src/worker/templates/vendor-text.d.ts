// The vendored template libraries are imported as TEXT (`with { type: "text" }`) and run
// inside a `node:vm` context, never as modules of this program.
declare module "*/vendor/ejs.min.js" {
  const source: string;
  export default source;
}

declare module "*/vendor/lodash.min.js" {
  const source: string;
  export default source;
}
