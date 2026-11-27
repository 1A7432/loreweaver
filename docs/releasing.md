# Releasing

What a release is, and how one is cut. The work is done by `.github/workflows/release.yml`;
a person decides twice — by pushing the tag, and by publishing the draft.

## What a release holds

| file | what |
|---|---|
| `loreweaver-linux-x64.tar.gz`, `loreweaver-linux-arm64.tar.gz`, `loreweaver-macos-arm64.tar.gz`, `loreweaver-windows-x64.zip` | One folder with two programs, each one file: `loreweaver` (the server) and `loreweaver-tui` (the terminal client), plus `LICENSE`, `NOTICE` and a short `README.txt`. No Bun and no checkout are needed to run them. |
| `SHA256SUMS` | The SHA-256 of every archive. |
| `install.sh`, `install.ps1` | The installers (`scripts/`): they download the archive for the machine they run on, check it against `SHA256SUMS`, and put the two programs in `~/.loreweaver/bin`. |

The file names carry no version, so `releases/latest/download/<name>` always names the latest
release's file. There is no build for Intel Macs or for musl Linux; the installer says so.

The two programs belong together: *Host locally & play* in the terminal client runs the
`loreweaver` beside it. The desktop client (Loreweaver Studio) hosts with the `loreweaver` it
finds on `PATH`, which is where the installers put it.

## Cutting one

1. The version is the one `server/package.json` and `clients/tui/package.json` state (and
   `SERVER_VERSION`; tests hold them together). Change it in a commit of its own if it changes.
2. Rehearse: run the `release` workflow by hand on the commit (*Actions → release → Run
   workflow*). It builds, self-tests, packs and installs on every platform and keeps the files as
   the run's artifacts; it touches no release.
3. Push the tag: `v<version>` for a release, `v<version>-<suffix>` (`v3.0.0-rc.1`) for a
   pre-release. A tag that does not match the packages fails the workflow before anything is
   built.
4. The workflow leaves a **draft** release with every file attached. Read it, write the notes,
   and publish it. Running the workflow again for the same tag replaces the draft's files and
   leaves its text; a release that has been published is never changed — tag a new version.

A pre-release never becomes GitHub's "latest", so the one-line installers (which ask for the
latest release) do not pick it up; install one with `TRPG_RELEASE_TAG=<tag>`.

## What is checked before a draft exists

- The type checks and tests of `ci.yml`, on the tagged commit.
- On each platform: the server's `selftest` (a real turn over a scripted model: the room
  worker, a module loaded from disk, the transport, the database) and the terminal client's
  `selftest` (one frame drawn off-screen, a loopback endpoint bound), both run from the
  compiled file, and both programs' `--version` against the tag's.
- On each platform: the installer, run against exactly the files the release will hold —
  install, run both programs from where they landed, install again over it, and a checksum
  that does not match must install nothing.

Nothing is signed or notarised. On macOS a copy downloaded with a browser is quarantined until
the person allows it (`xattr -d com.apple.quarantine <file>`); `install.sh` downloads with
`curl`, which does not quarantine.

## The protocol package

`loreweaver-protocol` on npm is released on its own, by `publish-protocol.yml` (the tag
`protocol-v<version>`); its `major.minor` is the protocol's, not the server's patch level.
