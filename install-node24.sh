#!/usr/bin/env bash
set -euo pipefail

target="$HOME/.local/node24"
if [[ -x "$target/bin/node" ]] && "$target/bin/node" --version | grep -Eq '^v24\.'; then
  "$target/bin/node" --version
  exit 0
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
cd "$temp_dir"
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
archive="$(awk '$2 ~ /^node-v24[0-9.]*-linux-x64\.tar\.xz$/ { print $2; exit }' SHASUMS256.txt)"
if [[ -z "$archive" ]]; then
  echo 'Не найден архив Node.js 24 для Linux x64' >&2
  exit 1
fi
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$archive"
grep -F "  $archive" SHASUMS256.txt | sha256sum --check -
mkdir -p "$target"
tar -xJf "$archive" --strip-components=1 -C "$target"
"$target/bin/node" --version
