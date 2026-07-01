# TRPG KP Clients

## Install

```sh
cd /Users/darthvader/ClaudeCode/trpg_kp/clients/protocol
bun install

cd /Users/darthvader/ClaudeCode/trpg_kp/clients/tui
bun install
```

## Test

```sh
cd /Users/darthvader/ClaudeCode/trpg_kp/clients/protocol
bun test

cd /Users/darthvader/ClaudeCode/trpg_kp/clients/tui
bun test
```

## Run

Start the Python WebSocket server in another terminal:

```sh
python -m app --serve
```

Connect the OpenTUI client:

```sh
cd /Users/darthvader/ClaudeCode/trpg_kp/clients/tui
bun run dev -- connect --host ws://127.0.0.1:8787 --key <k>
```

`--solo` prints the local server command:

```sh
bun run dev -- connect --solo
```

