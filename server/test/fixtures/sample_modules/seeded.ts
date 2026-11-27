// Shows what `create` and `load` were given (`init`), and the seed a command call carries.
import { defineModule, type ModuleInit } from "loreweaver/module";

let how = "none";
let given: ModuleInit = { options: {}, seed: "" };
let runs = 0;

export default defineModule({
  id: "seeded",
  create(init) {
    how = "create";
    given = init;
    runs = 0;
  },
  load(snapshot, init) {
    how = "load";
    given = init;
    runs = (snapshot as { runs: number }).runs;
  },
  save: () => ({ runs }),
  commands: {
    seed: {
      title: "Seed",
      run(_args, _who, _fx, _room, call) {
        runs += 1;
        return { text: call.seed };
      },
    },
  },
  views: {
    init: { schema: { type: "object" }, for: () => ({ how, options: given.options, seed: given.seed }) },
  },
});
