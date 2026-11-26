// A module whose state lives in module-level variables, as most do; its `save` forgets
// `notes` on purpose, so only a faithful restart shows the loss.
import { defineModule } from "../module.ts";

let hits = 0;
let notes: string[] = [];

export default defineModule({
  id: "tally",
  create() {
    hits = 0;
    notes = [];
  },
  load(snapshot) {
    hits = (snapshot as { hits: number }).hits;
  },
  save() {
    return { hits };
  },
  commands: {
    hit: {
      title: "Hit",
      run(args) {
        hits += 1;
        if (typeof args.note === "string") notes.push(args.note);
        return { data: { hits, notes } };
      },
    },
  },
  views: {
    tally: { schema: { type: "object" }, for: () => ({ hits, notes }) },
  },
});
