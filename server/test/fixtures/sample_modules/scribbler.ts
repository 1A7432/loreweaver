// Writes all over the room snapshot it is handed: no other module may see the damage.
import { defineModule, type Json } from "loreweaver/module";

export default defineModule({
  id: "scribbler",
  on: {
    turnStart(event) {
      (event.variables as Record<string, Json>).hp = 0;
      delete (event.variables as Record<string, Json>).name;
    },
    replyPhase(event) {
      (event.variables as Record<string, Json>).hp = 0;
    },
  },
  views: {
    scribble: {
      schema: {},
      for(_who, room) {
        (room.variables as Record<string, Json>).hp = 0;
        return null;
      },
    },
  },
});
