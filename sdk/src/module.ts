// The module contract: what a pack's module entry file exports, and what the engine
// hands it. A module never calls the engine. The engine notifies it; it answers through
// the effects object it was given, and those effects are applied only if the call
// succeeds.
//
// This is the part of the contract that exists so far: lifecycle, the turn-start event
// and prompt injection. Commands, views, claimable characters and clock ownership join
// it as the runtime grows.

/** Anything that survives `JSON.stringify` unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The way out of a handler. Nothing else a module does reaches the room. */
export interface Effects {
  /** Add a section to THIS turn's Keeper prompt. */
  inject(text: string): void;
  /** A line for the operator's log; never shown at the table. */
  log(text: string): void;
}

export interface TurnStartEvent {
  /** The turn now starting, counted from 1. */
  readonly turn: number;
  /** Derived from persisted inputs only: the same room state replays the same seed. */
  readonly seed: string;
  /** What the player said. */
  readonly text: string;
  /** The speaker's display name. */
  readonly speaker: string;
}

/** A module's definition, as its entry file's default export. */
export interface ModuleDefinition {
  /** Stable id; a module's commands and views are namespaced `<id>/<name>`. */
  readonly id: string;
  /** A fresh room: build the initial state. */
  create?(): void;
  /** Restore from a value `save` returned earlier. */
  load?(snapshot: Json): void;
  /**
   * Hand over the module's whole state. Called after every successful call; when a
   * call throws, the module is `load`-ed back from the last value returned here.
   */
  save?(): Json;
  readonly on?: {
    turnStart?(event: TurnStartEvent, fx: Effects): void | Promise<void>;
  };
}

/**
 * Declare a module. Returns its argument unchanged: the call exists so an entry file is
 * checked against the contract where it is written.
 */
export function defineModule<const T extends ModuleDefinition>(definition: T): T {
  return definition;
}
