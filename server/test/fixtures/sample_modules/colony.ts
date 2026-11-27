// A simulation that keeps its own characters: settlers it seats members on (`fx.seat`), and
// a long action that runs in steps (`more: true`).
import { defineModule } from "loreweaver/module";

type Settler = {
  id: string;
  name: string;
  hp: number;
  alive: boolean;
};

let settlers: Settler[] = [];
let years = 0;

function fresh(): Settler[] {
  return [
    { id: "ana", name: "Ana", hp: 5, alive: true },
    { id: "bo", name: "Bo", hp: 3, alive: true },
    { id: "cy", name: "Cy", hp: 4, alive: true },
  ];
}

export default defineModule({
  id: "colony",
  create() {
    settlers = fresh();
    years = 0;
  },
  load(snapshot) {
    const state = snapshot as unknown as { settlers: Settler[]; years: number };
    settlers = structuredClone(state.settlers);
    years = state.years;
  },
  save() {
    return { settlers, years };
  },
  characters() {
    return settlers
      .filter((settler) => settler.alive)
      .map((settler) => ({
        id: settler.id,
        name: settler.name,
        blurb: `a settler of ${years} years`,
        resources: [
          { id: "hp", label: "HP", value: settler.hp, max: 5 },
          { id: "food", label: "Food", value: years },
        ],
      }));
  },
  commands: {
    join: {
      title: "Join as a settler",
      params: { type: "object", properties: { settler: { type: "string" }, member: { type: "string" } }, required: ["settler"] },
      text: ["join {settler}"],
      run(args, who, fx) {
        fx.seat(typeof args.member === "string" ? args.member : (who.member?.id ?? ""), String(args.settler));
        return { text: "joined" };
      },
    },
    leave: {
      title: "Leave the colony",
      params: { type: "object", properties: { member: { type: "string" } } },
      run(args, who, fx) {
        fx.seat(typeof args.member === "string" ? args.member : (who.member?.id ?? ""), null);
        return { text: "left" };
      },
    },
    seat: {
      title: "Seat anyone on anything",
      params: { type: "object", properties: { member: { type: "string" }, character: { type: ["string", "null"] } }, required: ["member", "character"] },
      run(args, _who, fx) {
        fx.seat(String(args.member), args.character === null ? null : String(args.character));
      },
    },
    die: {
      title: "A settler dies",
      params: { type: "object", properties: { settler: { type: "string" } }, required: ["settler"] },
      run(args) {
        for (const settler of settlers) if (settler.id === args.settler) settler.alive = false;
      },
    },
    hurt: {
      title: "A settler is hurt",
      params: { type: "object", properties: { settler: { type: "string" } }, required: ["settler"] },
      run(args) {
        for (const settler of settlers) if (settler.id === args.settler) settler.hp -= 1;
      },
    },
    whoami: {
      title: "Who am I to the colony",
      run: (_args, who) => ({ data: who.character }),
    },
    advance: {
      title: "Advance the colony by some years, one a step",
      params: { type: "object", properties: { years: { type: "integer" }, fail_at: { type: "integer" }, hang_at: { type: "integer" } }, required: ["years"] },
      run(args, _who, fx, _room, call) {
        if (args.fail_at === call.step) throw new Error(`step ${call.step} failed`);
        // Never returns: the call limit ends the worker.
        if (args.hang_at === call.step) for (;;);
        years += 1;
        const roll = fx.roll("1d100", "harvest");
        fx.fact({ text: `year ${years}`, data: { step: call.step, seed: call.seed, harvest: roll.total } });
        const done = call.step + 1 >= Number(args.years);
        return done ? { text: `year ${years}`, data: { years } } : { text: `year ${years}`, data: { years }, more: true };
      },
    },
    forever: {
      title: "Never ends by itself",
      run(_args, _who, fx, _room, call) {
        years += 1;
        fx.fact({ text: `tick ${call.step}` });
        return { text: `tick ${call.step}`, more: true };
      },
    },
  },
});
