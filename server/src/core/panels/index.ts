// Panels (protocol 3.0 §8.5): persistent UI beside the story, shipped by packs. A panel's
// data comes from views only. Pure: the panels file format and its checks (`format.ts`), and
// a panel as one viewer's `panels` view lists it (`wire.ts`). Instantiating a template
// against the views a client holds is the protocol package's `instantiate`, shared by every
// client.
export * from "./format.ts";
export * from "./wire.ts";
