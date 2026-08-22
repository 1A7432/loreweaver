# Implemented: live reauth at the commit boundary

- **Problem:** long or destructive Keeper operations refresh authorization
  when the transport choke point takes the room lock, but another admin
  connection or ops process can revoke or demote that key during
  verification, backup, or analysis. Without a second check at the real
  mutation, a revoked connection could still `.undo`, `.save load`, import,
  or delete.
- **Verdict:** re-check live authorization after the expensive preflight and
  immediately before the first irreversible mutation or the final
  secret-artifact write. The last successful reauth is the linearization
  point — the operation is authorized. Do not try to kill a transaction
  that has already begun. Fail closed: no backup created or overwritten, no
  storage / key / vector / media change, existing forbidden / denied copy,
  no path or content leak. Ordinary short commands stay a single gate.
- **Reason:** the lock-time refresh is necessary and not sufficient. The
  window that matters is preflight → commit, and only the commit-boundary
  check closes it. `AdminService.reauthorize` and `_keeper_still_authorized`
  were already the model (config lock, `.reset`); the room-backup API now
  carries the same optional callback to the write that actually counts. The
  helper accepts a sync or awaitable callback so a future I/O refresh does
  not force a second shape.
- **Rule home:** `infra/live_auth.py` (the exception + sync/awaitable helper);
  `net.room_backup` commit calls (export write, import first store mutation,
  delete first store mutation, reset first hook);
  `gateway.commands.rooms._keeper_still_authorized` (`.undo` before
  reset/restore; tui/iroh fail closed without a callback);
  world/module import immediately before the first write after parse/progress.
- **Date:** 2026-08-22.
