// Uses every part of the contract, and misbehaves on purpose where the runtime must
// hold: read-only handlers mutate, a command throws on request, and `save` forgets the
// `scratch` counter (only a cold start shows that).
import { defineModule } from "loreweaver/module";

interface State {
  hp: number;
  said: string[];
}

let state: State = { hp: 10, said: [] };
let scratch = 0;

export default defineModule({
  id: "kitchen",
  create() {
    state = { hp: 10, said: [] };
    scratch = 0;
  },
  load(snapshot) {
    state = structuredClone(snapshot) as unknown as State;
  },
  save() {
    return { hp: state.hp, said: state.said };
  },
  characters() {
    return [{ id: "hero", name: "Hero", blurb: "the one", resources: [{ id: "hp", label: "HP", value: state.hp, max: 10 }] }];
  },
  clock() {
    return { time: `hp ${state.hp}`, round: state.said.length };
  },
  on: {
    turnStart(event, fx) {
      state.said.push(event.text);
      fx.inject(`kitchen heard ${state.said.length}; clock ${event.clock?.time ?? "none"}`);
      fx.fact({ text: `turn ${event.turn}` }, { to: "table" });
      fx.setVar("kitchen.turn", event.turn);
    },
    toolUse(event, fx) {
      state.hp = -999;
      for (const call of event.calls) if (call.name === "forbidden") fx.deny(call.id, "not here");
    },
    replyPhase(event, fx) {
      const roll = fx.roll("1d20", "luck");
      fx.setVar("kitchen.luck", roll.total);
      fx.blocks([{ type: "text", text: `luck ${roll.total} after ${event.reply}` }], { id: "luck" });
    },
  },
  commands: {
    hit: {
      title: "Hit",
      description: "Lose some hp.",
      params: { type: "object", properties: { amount: { type: "integer" } } },
      text: ["hit {amount}"],
      run(args, who, fx) {
        state.hp -= typeof args.amount === "number" ? args.amount : 1;
        scratch += 1;
        fx.fact({ text: `${who.member?.name ?? "someone"} is hit` });
        if (args.fail === true) throw new Error("hit failed");
        return { text: `hp ${state.hp}`, data: { hp: state.hp } };
      },
    },
    reset: {
      title: "Reset",
      role: "admin",
      run() {
        state.hp = 10;
      },
    },
    sit: {
      title: "Sit",
      available(who) {
        state.hp = 0;
        return who.character ? true : "find a seat first";
      },
      run: () => ({ text: "seated" }),
    },
    echo: {
      title: "Echo",
      run: (args) => ({ data: { keys: Object.keys(args), args } }),
    },
  },
  views: {
    status: {
      title: "Status",
      schema: { type: "object" },
      for(who) {
        state.hp += 1000;
        return { hp: state.hp, viewer: who.member?.name ?? null };
      },
    },
    scratch: { schema: { type: "number" }, for: () => scratch },
  },
});
