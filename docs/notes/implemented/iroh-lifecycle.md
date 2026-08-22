# Implemented: Iroh close drains tasks; join fatals close the QUIC connection

- **Problem:** a real p2p round-trip logged `RuntimeWarning: coroutine
  Endpoint.close was never awaited`. `IrohServer.close` called the async
  `endpoint.close()` without awaiting it and cancelled `_tasks` without
  draining them, so cleanup raced past the function return and `serve()`'s
  accept loop could not exit. Separately, `_authenticate` swallowed
  `TimeoutError` as `None`, so the default Iroh carrier never sent the
  `error{code:'join_timeout'}` that `docs/protocol.md` promises — clients
  treated it as a drop and redialed. Handshake failures (bad key / bad
  frame / live-authorization revoke) also left the QUIC connection half-open;
  WebSocket closes the socket on those paths.
- **Decision:** `close()` snapshots `_tasks` (done callbacks mutate the set),
  cancels and `gather`s them (`CancelledError` from children is consumed;
  other `BaseException`s re-raise), then `await`s `endpoint.close()`, then
  drains once more for a late `_handle` spawned while accept was still live.
  The call is idempotent. `_authenticate` distinguishes `asyncio.TimeoutError`
  (best-effort `join_timeout` then fail), propagates `CancelledError`, and
  fails cleanly on any other read error. `_handle` always `_close_transport`s
  the control stream + QUIC connection on exit; `IrohMember.deliver` does the
  same on revoke, matching `WsMember` + `ws.close()`. Post-join recoverable
  errors (`rate_limited`, `bad_frame` after join, …) stay on the live stream.
- **`IrohMember.send_frame` write-failure raise: not in this change.**
  RoomHub drops a member when `deliver` raises, so making every write failure
  raise would expand drop policy beyond handshake teardown. WS `_send`
  already swallows `ConnectionClosed`. Handshake writes go through
  `_write_line`, which returns `False` on a dead stream so the caller can
  still close the connection.
- **Reason:** the documented join fatals have to be distinguishable from a
  dropped socket, and a default-carrier close has to actually stop accepting.
- **Rule home:** `net/iroh_server.py` (`close`, `_authenticate`,
  `_close_transport`).
- **Date:** 2026-08-22.
