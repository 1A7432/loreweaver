# TRPG KP Clients

## Install

```sh
cd clients/protocol
bun install

cd clients/tui
bun install
```

## Test

```sh
cd clients/protocol
bun test

cd clients/tui
bun test
```

## Run

Start the Python WebSocket server in another terminal:

```sh
python -m app --serve
```

Connect the OpenTUI client:

```sh
cd clients/tui
bun run dev -- connect --host ws://127.0.0.1:8787 --key <k>
```

`--solo` prints the local server command:

```sh
bun run dev -- connect --solo
```

