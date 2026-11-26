// Changes its state, then fails or hangs when told to: the cases a broken module puts
// the engine in.
import { defineModule } from "loreweaver/module";

let seen: string[] = [];

export default defineModule({
  id: "moody",
  create() {
    seen = [];
  },
  load(snapshot) {
    seen = [...(snapshot as string[])];
  },
  save() {
    return seen;
  },
  on: {
    turnStart(event, fx) {
      seen.push(event.text);
      fx.inject(`moody has seen: ${seen.join(", ")}`);
      if (event.text === "throw") throw new Error("moody refuses");
      if (event.text === "spin") for (;;) {}
    },
  },
});
