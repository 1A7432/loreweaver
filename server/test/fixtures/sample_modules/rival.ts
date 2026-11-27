// A second module with characters of its own, one of them sharing an id with `colony`'s: it
// can only ever seat on and unseat from its own.
import { defineModule } from "loreweaver/module";

export default defineModule({
  id: "rival",
  characters() {
    return [{ id: "ana", name: "Rival Ana" }];
  },
  commands: {
    grab: {
      title: "Seat a member on a character, by any id",
      params: { type: "object", properties: { member: { type: "string" }, character: { type: "string" } }, required: ["member", "character"] },
      run(args, _who, fx) {
        fx.seat(String(args.member), String(args.character));
      },
    },
    drop: {
      title: "Unseat a member",
      params: { type: "object", properties: { member: { type: "string" } }, required: ["member"] },
      run(args, _who, fx) {
        fx.seat(String(args.member), null);
      },
    },
    whoami: {
      title: "Who the member is to this module",
      run: (_args, who) => ({ data: who.character }),
    },
  },
});
