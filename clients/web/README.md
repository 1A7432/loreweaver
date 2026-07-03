# TRPG KP — Web client

A zero-install browser client (React + Vite + TypeScript) for the TRPG KP
system. It speaks the same v1 WebSocket protocol as the terminal and chat
clients, reusing `@loreweaver/protocol` (the browser's native `WebSocket` powers
the default `WsClient` factory). Same rooms, same session.

The UI mirrors the OpenTUI client's **Hybrid** layout — a narrative column plus
a right rail (character / party / scene) over a command bar and status bar — and
ships the **DF-16** palette by default (plus phosphor / amber / paperwhite,
switchable from the status bar).

## Install

```sh
cd clients/web
bun install
```

## Test

DOM-only tests (vitest + jsdom, no network / WS server). Exits when done:

```sh
bun run test
```

## Build

Produces static assets in `dist/` (deployable to any static host):

```sh
bun run build
```

## Run

1. Start the Python WebSocket server in another terminal:

   ```sh
   python -m app --serve
   ```

2. Mint a room key (deployer):

   ```sh
   python -m app --tui-key add --room R
   ```

3. Serve the web app — either the Vite dev server:

   ```sh
   bun run dev
   ```

   or a static host over the built `dist/`:

   ```sh
   bun run build && bun run preview
   ```

4. Open the app, enter the server URL (default `ws://127.0.0.1:8787/`), the key,
   and an optional display name, then **Connect**.

## Layout

- `src/App.tsx` — connect screen; builds a `WsClient`, connects + joins, and
  switches to the game view on `welcome`. Accepts an injected `client` prop for
  tests.
- `src/GameView.tsx` — the Hybrid layout; subscribes to server frames and keeps
  React state (log, character, party, scene, clock, initiative, online).
- `src/components/` — `NarrativeLog`, `CharacterPanel`, `PartyPanel`,
  `ScenePanel`, `StatusBar`.
- `src/markdown.tsx` — a tiny, XSS-safe markdown-to-JSX renderer for KP text.
- `src/themes.css` — CSS-variable palettes applied on `body[data-theme]`.

## Scope

A clean SPA that talks the v1 protocol. No auth beyond the WS key, no SSR/PWA,
no server-side static route (the server could serve `dist/` later; out of scope
here).
