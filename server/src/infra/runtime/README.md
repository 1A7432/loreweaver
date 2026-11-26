# infra/runtime

The only directory allowed to touch Bun-specific APIs — `bun:*` imports and the `Bun`
global: SQLite, the HTTP/WebSocket server, workers, the filesystem and process helpers
that have no portable form. Everything else imports the wrappers defined here.

The rule is a test (`test/architecture/imports.test.ts`), and its purpose is an exit:
if a long-running Bun server turns out to behave badly, this directory is what gets a
second implementation.
