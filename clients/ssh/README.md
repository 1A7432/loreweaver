# @trpg-kp/ssh — Rich SSH front-end

`ssh -p 2222 anything@host` renders the **full OpenTUI TUI**. Zero client install,
no registration. The SSH public key **is** the credential (public-key auth only —
no passwords). Each SSH session lands in a shared RoomHub room, live alongside
WS/chat players.

All-Bun (Bun 1.3.14). No Node, no `node-pty`, no native build: the server uses
Bun's built-in native PTY (`Bun.Terminal`) and `ssh2` for the wire protocol.

## How it works

The SSH server does **not** reimplement the game. Per authenticated session it:

1. maps the offered SSH public key → `{room, ws_key, name}` (from `ssh_keys.toml`),
2. spawns the existing OpenTUI client (`clients/tui`) inside a `Bun.Terminal`,
   pointed at the local WS server, and
3. bridges the ssh2 channel ↔ the PTY (keystrokes → client stdin, TUI frames →
   ssh output, window resizes → PTY resize).

The spawned client command is exactly:

```
bun run <clients/tui/src/index.tsx> connect --host <ws-url> --key <ws_key> --name <name>
```

Because the client joins with that room's WS join key, the SSH player shares the
hub room with everyone else.

## Deployer flow

From the repo root (`trpg_kp/`):

1. **Start the WS server** (terminal 1):

   ```
   python -m app --serve            # ws://127.0.0.1:8787/ by default
   ```

2. **Mint a WS join key** for the room (terminal 2):

   ```
   python -m app --tui-key add --room blackmoor --name Nora
   # prints a ws_key like: GiAZWUeR...
   ```

3. **Register the player** — copy `ssh_keys.example.toml` to `data/ssh_keys.toml`
   and add a block with the player's `~/.ssh/id_ed25519.pub`, the room, the minted
   `ws_key`, and a display name:

   ```toml
   [[user]]
   pubkey = "ssh-ed25519 AAAAC3... nora@laptop"
   room   = "blackmoor"
   ws_key = "GiAZWUeR..."
   name   = "Nora"
   ```

4. **Run the SSH front-end** (terminal 2):

   ```
   cd clients/ssh
   bun install
   bun run src/index.ts --keys ./data/ssh_keys.toml
   #   --port 2222 --ws-url ws://127.0.0.1:8787/ --client ../tui/src/index.tsx
   ```

   A persistent ed25519 host key is created at `data/ssh_host_key` on first run.

5. **Player connects** (any username; the key decides identity):

   ```
   ssh -p 2222 anything@your-host
   ```

   → the full OpenTUI TUI, in the `blackmoor` room, next to the WS/chat players.

## CLI flags

| flag        | default                     | meaning                                   |
| ----------- | --------------------------- | ----------------------------------------- |
| `--port`    | `2222`                      | SSH listen port                           |
| `--host`    | `127.0.0.1`                 | SSH bind address                          |
| `--ws-url`  | `ws://127.0.0.1:8787/`      | local WS server the TUI client connects to |
| `--keys`    | `./data/ssh_keys.toml`      | authorized keys file (TOML or JSON)       |
| `--client`  | `../tui/src/index.tsx`      | absolute path to the OpenTUI client entry |
| `--host-key`| `./data/ssh_host_key`       | persistent host key (auto-generated)      |

## Tests

```
cd clients/ssh
bun install
bun test
```

In-process only — an `ssh2` client/server pair on an ephemeral port, closed in a
`finally`. No foreground server, no real client process, no real PTY (both
`spawn` and the terminal factory are injected in tests).

## Layout

- `src/keys.ts` — `loadSshKeys(path)` → `Map<fingerprint, entry>`; `authorize()`.
- `src/host_key.ts` — load-or-generate a persistent ed25519 host key.
- `src/bridge.ts` — `bridgeSession(channel, ptyInfo, entry, opts, spawnFn?, terminalFactory?)`.
- `src/server.ts` — `startSshServer(opts)` → `{ port, close() }`.
- `src/index.ts` — CLI entrypoint (`trpg-kp-ssh`).
