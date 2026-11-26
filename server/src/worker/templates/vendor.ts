/**
 * The vendored template libraries (EJS, Apache-2.0; lodash, MIT — licences beside the
 * files in `assets/vendor/`) and the two scripts of this engine, each compiled ONCE per
 * worker into a `vm.Script` and run into every fresh context.
 */

import vm from "node:vm";

import ejsSource from "../../../../assets/vendor/ejs.min.js" with { type: "text" };
import lodashSource from "../../../../assets/vendor/lodash.min.js" with { type: "text" };
import { API_SOURCE, ENVIRONMENT_SOURCE } from "./prelude.ts";

export interface CompiledScripts {
  /** Run first: seeds `Math.random`, fixes `Date`, removes host-reaching and nondeterministic globals. */
  readonly environment: vm.Script;
  readonly ejs: vm.Script;
  readonly lodash: vm.Script;
  /** Run last: the ST-Prompt-Template API over the payload, frozen as `__lw`. */
  readonly api: vm.Script;
}

let compiled: CompiledScripts | undefined;

/** The four scripts, compiled on first use. */
export function compiledScripts(): CompiledScripts {
  compiled ??= {
    environment: new vm.Script(ENVIRONMENT_SOURCE, { filename: "lw-environment.js" }),
    ejs: new vm.Script(ejsSource, { filename: "ejs.min.js" }),
    lodash: new vm.Script(lodashSource, { filename: "lodash.min.js" }),
    api: new vm.Script(API_SOURCE, { filename: "lw-api.js" }),
  };
  return compiled;
}
