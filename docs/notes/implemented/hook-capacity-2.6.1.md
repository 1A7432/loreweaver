# Implemented: hook capacity for a large simulation kernel (2.6.1)

- **Problem:** a real module's hook kernel plus data is already 1.46M characters with half
  its systems unwritten and heading for 3–4M; 2.6.0 allowed 400,000 per script and 2,000,000
  per room. Raising the script caps alone would not have been enough: a native bundle was
  capped at the SillyTavern card size (16 MiB — CJK-heavy data is up to 3 bytes a character),
  and a room's backup refused a room_state section past 12 MiB, which 8M characters of
  card-installed `room_hooks` plus a full 4 MiB private store exceed.
- **Verdict (owner):** 1,000,000 characters per script and 8,000,000 per room (16 scripts,
  unchanged); a native bundle (`*.lorecard.json`) may be up to 32 MiB while a SillyTavern card
  keeps 16 MiB (pack build, pack install, pack lint and `.import`, whose read is now bounded);
  the backup's room_state section gets its own 32 MiB cap. State caps, the 64 MiB QuickJS limit
  and the fresh-interpreter-per-turn contract are unchanged. Two avoidable engine builds go:
  the Scribe's `tool_use` veto engine is not built for a room whose scripts never contain the
  text `tool_use`, and `.act` alone lists from the cached manifest.
- **Reason:** measured on an Apple M5 Pro (median of 5): an engine for 7.95M characters of
  mixed code and JSON-in-string data builds in ~173 ms with a 2 MiB store and ~191 ms with
  4 MiB, using ~35–38 MiB of the 64 MiB QuickJS heap (a build fails at a 40 MiB limit and
  succeeds at 48), so the limit holds with ~20 MiB for handlers' working sets. The Python
  `quickjs` binding (1.19.4) exposes no bytecode compile/load, so re-parsing cannot be avoided
  without leaving the contract. Pack builds and caps are relaxations: every valid pack stays
  valid. Undo snapshots still copy the whole room_state (~85 ms per turn at full capacity).
- **Rule home:** `core/hooks.py` (`MAX_HOOK_SOURCE_CHARS`, `MAX_HOOK_TOTAL_SOURCE_CHARS`),
  `core/lorecard.py` (`MAX_LORECARD_FILE_BYTES`), `core/pack.py` (`_check_card_size`),
  `net/room_backup.py` (`MAX_BACKUP_ROOM_STATE_BYTES`), `agent/hook_runtime.py`
  (`require_event`); tests `tests/agent/test_hook_capacity.py`, `tests/agent/test_hook_state.py`.
- **Date:** 2026-11-25.
