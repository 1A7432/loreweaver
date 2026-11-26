// The module contract. Only the entry point exists so far; the contract's types land
// with the module runtime.

/** A module's definition, as its entry file's default export. */
export interface ModuleDefinition {
  /** Stable id; a module's commands and views are namespaced `<id>/<name>`. */
  readonly id: string;
}

/**
 * Declare a module. Returns its argument unchanged: the call exists so an entry file is
 * checked against the contract where it is written.
 */
export function defineModule<const T extends ModuleDefinition>(definition: T): T {
  return definition;
}
