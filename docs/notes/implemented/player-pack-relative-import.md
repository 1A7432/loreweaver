# Implemented: players may import pack-relative character cards

- **Problem:** `.import <path> pc` keeper-gated every host-path argument BEFORE
  `resolve_installed_path`, so a player could not import a character card an
  installed pack ships (`harbour/cards/pilot.json`) even though that resolver is
  confined to `data_dir/packs/`. "The module shipped a PC card" was a
  keeper-only ceremony.
- **Verdict:** owner picked options 2+3 (2026-08-17) — a CONFINED pack-relative
  ref is player-open for the character half; raw host paths stay keeper-only;
  `world`/`companion` keep their keeper gates. Discovery is three surfaces:
  `.import list` (every client), and graphical pickers on TUI and Studio fed by
  the protocol v2.2 `list_pack_cards` → `pack_cards` lane (filenames only, never
  card content).
- **Reason:** a confined pack read is not a server-filesystem read, and the card
  split strips world machinery structurally either way (iron rule 3 holds by
  construction, not by the gate that was removed).
- **Rule home:** `gateway/commands/world.py::cmd_import` (gate order comment);
  sentinels in `tests/gateway/test_command_gates.py`.
- **Date:** 2026-08-17.
