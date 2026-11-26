// Declares commands and views under names every object already has. They must never be
// offered or dispatched; `ok` must still work.
import { defineModule } from "loreweaver/module";

export default defineModule({
  id: "bad_names",
  commands: {
    constructor: { title: "Constructor", run: () => ({ text: "should not run" }) },
    ["__proto__"]: { title: "Proto", run: () => ({ text: "should not run" }) },
    Shout: { title: "Shout", run: () => ({ text: "should not run" }) },
    ok: { title: "Ok", run: () => ({ text: "ok" }) },
  },
  views: {
    constructor: { schema: { type: "null" }, for: () => null },
    ["__proto__"]: { schema: { type: "null" }, for: () => null },
  },
});
