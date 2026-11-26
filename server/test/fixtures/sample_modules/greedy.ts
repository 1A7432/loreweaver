// Asks for more of everything than the engine allows.
import { defineModule } from "loreweaver/module";

export default defineModule({
  id: "greedy",
  on: {
    turnStart(_event, fx) {
      for (let i = 0; i < 10; i++) fx.inject(`section ${i}`);
      fx.inject("x".repeat(4001));
      for (let i = 0; i < 33; i++) fx.fact({ text: `fact ${i}` });
      for (let i = 0; i < 17; i++) fx.roll("1d6");
    },
  },
});
