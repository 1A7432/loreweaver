// Counts the turns it has seen and says so in the Keeper prompt.
import { defineModule } from "loreweaver/module";

let turns = 0;

export default defineModule({
  id: "counter",
  create() {
    turns = 0;
  },
  load(snapshot) {
    turns = (snapshot as { turns: number }).turns;
  },
  save() {
    return { turns };
  },
  on: {
    turnStart(event, fx) {
      turns += 1;
      fx.inject(`counter: turn ${turns}, ${event.who.member?.name ?? "nobody"} said "${event.text}"`);
    },
  },
});
