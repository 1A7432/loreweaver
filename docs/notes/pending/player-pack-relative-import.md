# Pending: player import of pack-relative character cards

- **Problem:** `.import <path> pc` is keeper-gated whenever the argument is a host path, and the gate runs *before* `resolve_installed_path`. A player therefore cannot import a character card shipped in an installed pack via `harbour-bell/cards/foo.json`, even though that resolver is confined to `data_dir/packs/`. Players can still claim a pregen or import an *attachment*. The card-split itself works on the attachment path (walked 2026-08-17: world machinery stripped, secret lore dropped).
- **Options:**
  1. Keep the host-path gate as-is. Pregen claim + attachment remain the player routes. Pack-relative refs stay a keeper convenience.
  2. Allow pack-relative refs (only those `resolve_installed_path` accepts) for `pc` imports, still deny raw host paths and `world`/`companion`.
  3. Add a first-class “import from installed pack” picker on both clients so players never type a path.
- **Recommendation:** (2) plus a Studio picker. A confined pack-relative character card is not a server-filesystem read; treating it like one makes “the module shipped a PC card” a keeper-only ceremony, which fights the card-split story.
- **Impact:** `gateway/commands.py::cmd_import` gate order; Studio/TUI import UI; tests in `tests/gateway/test_command_gates.py`. Does not reopen keeper world-import.
- **Date:** 2026-08-17 (three-persona review).
