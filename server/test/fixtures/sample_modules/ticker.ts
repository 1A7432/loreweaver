// Claims the room's clock, like `kitchen` does: the two cannot share a room.
import { defineModule } from "loreweaver/module";

export default defineModule({
  id: "ticker",
  clock: () => ({ time: "dawn" }),
});
