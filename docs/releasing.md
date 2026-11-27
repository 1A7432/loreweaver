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

5. Once a release is published, the guides that say there is none are wrong: rewrite *Five minutes
   to a table* in `README.md` / `README.zh.md`, section 1 of `docs/play.md` / `docs/play.zh.md`, the
   opening and *Updating* in `docs/deploy.md` / `docs/deploy.zh.md`, and the *A release* item of
   `docs/roadmap.md` / `docs/roadmap.zh.md` around the installer.

A pre-release never becomes GitHub's "latest", so the one-line installers (which ask for the
latest release) do not pick it up; install one with `TRPG_RELEASE_TAG=<tag>`.

## Machines that have Loreweaver 2

Loreweaver 2 followed GitHub's "latest" release, so the first 3.x release that becomes
"latest" reaches every 2.x machine:

- **`loreweaver update` on 2.x runs the latest release's installer** — from then on, ours. So
  `install.sh` and `install.ps1` look for Loreweaver 2 (its client's files under
  `~/.loreweaver/clients`, or its launcher) on a machine that has no Loreweaver 3 yet, say
  that 3 is a new program that opens none of 2's rooms, saves or packs, and ask before
  installing; with nobody to ask they install nothing (`TRPG_UPGRADE_TO_3=1` answers
  beforehand). Loreweaver 2 is kept either way — its command as `loreweaver.old` (on Windows
  `loreweaver.cmd`), its files and data untouched — and can be reinstalled from its own last
  release (`LAST_V2_TAG` in both installers: the last 2.x release that holds an installer).
- **Both generations keep a hosted server's data in `~/.loreweaver/data`**, in a database
  file of the same name. The 3.x server reads whose database it is before it writes
  anything and refuses a 2.x one (`other_database`), leaving it as it was; the clients then
  ask for another folder.
- **A 2.x client that hosts a server downloads `loreweaver-server-<platform>` from the release
  its installer pinned** — unaffected. One that follows "latest" instead (Loreweaver Studio
  0.1.0, or a 2.x client installed from a checkout's installer) asks the latest release for
  that file and, failing that, for the source of `main`: neither is a 2.x server once 3.x
  is the latest release and `main`. A server it already downloaded keeps working.

## What is checked before a draft exists

- The type checks and tests of `ci.yml`, on the tagged commit.
- On each platform: the server's `selftest` (a real turn over a scripted model: the room
  worker, a module loaded from disk, the transport, the database) and the terminal client's
  `selftest` (one frame drawn off-screen, a loopback endpoint bound), both run from the
  compiled file, and both programs' `--version` against the tag's.
- On each platform: the installer, run against exactly the files the release will hold —
  install, run both programs from where they landed, install again over it, and a checksum
  that does not match must install nothing; on a machine made to look like it has Loreweaver 2,
  nothing is installed unasked, and with the answer given 2 is kept beside 3.

Nothing is signed or notarised. On macOS a copy downloaded with a browser is quarantined until
the person allows it (`xattr -d com.apple.quarantine <file>`); `install.sh` downloads with
`curl`, which does not quarantine.

## The protocol package

`loreweaver-protocol` on npm is released on its own, by `publish-protocol.yml` (the tag
`protocol-v<version>`); its `major.minor` is the protocol's, not the server's patch level.
