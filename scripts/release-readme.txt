Loreweaver @VERSION@ (@PLATFORM@)
https://github.com/1A7432/loreweaver

Two programs, each one file. Keep them in the same folder.

  loreweaver-tui   The terminal client. Run it to join a table with the ticket and the key
                   its admin gave you, or choose "Host locally & play" to start a table on
                   this machine (it runs the server beside it).

  loreweaver       The server. `loreweaver serve` runs a table others can join and prints
                   its ticket; `loreweaver --help` lists the rest. Its settings are TRPG_*
                   environment variables, also read from a `.env` file in the folder you
                   start it in. The model can be set from a client's admin screens instead.

macOS: a copy downloaded with a browser is held back by the system until you allow it:
  xattr -d com.apple.quarantine loreweaver loreweaver-tui
The installer (install.sh on the release page) does not have this problem.

Documentation: https://github.com/1A7432/loreweaver#readme
Licence: MIT (LICENSE); notices for what the programs contain are in NOTICE.
