/**
 * Template rendering for imported lore: real EJS with the ST-Prompt-Template API, run in
 * a fresh `node:vm` context per prompt assembly. Content-supplied code; it runs only in
 * the room's worker thread.
 */

export * from "./assemble.ts";
export * from "./session.ts";
