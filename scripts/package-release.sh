#!/usr/bin/env bash
# Packs one platform's release archive: the server and the terminal client, each one file,
# with the licence, the notices and a short readme, in a folder named like the archive.
#
#   scripts/package-release.sh <platform> <version> <server binary> <client binary> <out dir>
#
# `<platform>` is the name the installers ask for (linux-x64, linux-arm64, macos-arm64,
# windows-x64). Windows gets a .zip, the others a .tar.gz. The release workflow runs this on
# each platform's own runner; nothing here builds anything.
set -euo pipefail

[ "$#" -eq 5 ] || { echo "usage: $0 <platform> <version> <server binary> <client binary> <out dir>" >&2; exit 2; }
platform="$1" version="$2" server="$3" client="$4"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$5"
out="$(cd "$5" && pwd)"

case "$platform" in
  linux-x64|linux-arm64|macos-arm64) exe="" ;;
  windows-x64) exe=".exe" ;;
  *) echo "unknown platform: $platform" >&2; exit 2 ;;
esac
[ -f "$server" ] || { echo "no server binary at $server" >&2; exit 1; }
[ -f "$client" ] || { echo "no client binary at $client" >&2; exit 1; }

name="loreweaver-$platform"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/$name"
cp "$server" "$work/$name/loreweaver$exe"
cp "$client" "$work/$name/loreweaver-tui$exe"
chmod 755 "$work/$name/loreweaver$exe" "$work/$name/loreweaver-tui$exe"
cp "$root/LICENSE" "$root/NOTICE" "$work/$name/"
sed -e "s/@VERSION@/$version/g" -e "s/@PLATFORM@/$platform/g" "$root/scripts/release-readme.txt" > "$work/$name/README.txt"

if [ -n "$exe" ]; then
  # The archive the Windows installer opens with Expand-Archive is made by its counterpart.
  (cd "$work" && pwsh -NoProfile -Command "Compress-Archive -Path '$name' -DestinationPath '$name.zip'")
  mv "$work/$name.zip" "$out/$name.zip"
  echo "$out/$name.zip"
else
  tar -czf "$out/$name.tar.gz" -C "$work" "$name"
  echo "$out/$name.tar.gz"
fi
