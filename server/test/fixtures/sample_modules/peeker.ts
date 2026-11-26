// Reports the room snapshot it is handed, in every kind of call.
import { defineModule } from "loreweaver/module";

export default defineModule({
  id: "peeker",
  on: {
    turnStart(event, fx) {
      fx.inject(`turnStart ${event.turn} ${JSON.stringify(event.variables)}`);
    },
    replyPhase(event, fx) {
      fx.log(`replyPhase ${event.turn} ${JSON.stringify(event.variables)} ${event.clock?.time ?? "none"}`);
    },
  },
  commands: {
    vars: { title: "Variables", run: (_args, _who, _fx, room) => ({ data: room.variables }) },
  },
  views: {
    vars: { schema: { type: "object" }, for: (_who, room) => ({
        turn: room.turn,
        variables: room.variables,
        clock: room.clock === null ? null : { time: room.clock.time, round: room.clock.round ?? null },
      }),
    },
  },
});
