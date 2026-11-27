// Who runs a command: a `keeper` command (Keeper machinery, with Keeper-only text in its
// answer), a player command that answers by `call.by`, and an admin command the Keeper
// may never run.
import { defineModule } from "loreweaver/module";

let hours = 0;

export default defineModule({
  id: "omens",
  create() {
    hours = 0;
  },
  load(snapshot) {
    hours = (snapshot as { hours: number }).hours;
  },
  save() {
    return { hours };
  },
  commands: {
    advance: {
      title: "Advance the omen clock",
      description: "Move the omen clock on by one hour.",
      role: "keeper",
      run(_args, who, fx, _room, call) {
        hours += 1;
        fx.fact({ text: `An hour passes (${hours}).` });
        return { text: `${call.by} for ${who.member?.name ?? "nobody"}: hour ${hours}, OMEN_DUE_AT_SIX` };
      },
    },
    look: {
      title: "Look",
      description: "Look around the well.",
      run(_args, _who, _fx, _room, call) {
        return { text: call.by === "keeper" ? "keeper: the letter is in the well" : "member: you see the well" };
      },
    },
    wipe: {
      title: "Wipe",
      description: "Start the omen clock over.",
      role: "admin",
      danger: true,
      run() {
        hours = 0;
        return { text: "wiped" };
      },
    },
  },
});
