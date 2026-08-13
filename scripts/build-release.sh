#!/usr/bin/env bash
#
# Build standalone Lore CLI binaries for macOS and Linux.
#
# Usage:
#   bash scripts/build-release.sh
#   bash scripts/build-release.sh lore-darwin-arm64
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$ROOT/packages/cli/src/main.ts"
OUT="$ROOT/dist/release"
FILTER="${1:-}"
EXPECTED_BUN_VERSION="${LORE_BUN_VERSION:-1.3.5}"

command -v bun >/dev/null 2>&1 || {
  echo "Bun $EXPECTED_BUN_VERSION is required to build Lore binaries." >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Node.js is required to generate embedded CLI assets." >&2
  exit 1
}

ACTUAL_BUN_VERSION="$(bun --version)"
if [ "$ACTUAL_BUN_VERSION" != "$EXPECTED_BUN_VERSION" ]; then
  echo "Expected Bun $EXPECTED_BUN_VERSION, found $ACTUAL_BUN_VERSION." >&2
  exit 1
fi

VERSION="$(node -p "require('$ROOT/packages/cli/package.json').version")"
[ -n "$VERSION" ] || { echo "Could not read the Lore CLI version." >&2; exit 1; }

node "$SCRIPT_DIR/generate-cli-assets.mjs"
rm -rf "$OUT"
mkdir -p "$OUT"

PLATFORMS=(
  "lore-linux-x64:bun-linux-x64-baseline"
  "lore-linux-arm64:bun-linux-arm64"
  "lore-darwin-x64:bun-darwin-x64"
  "lore-darwin-arm64:bun-darwin-arm64"
)

built=0
echo "Building Lore v$VERSION with Bun $ACTUAL_BUN_VERSION"
for entry in "${PLATFORMS[@]}"; do
  name="${entry%%:*}"
  target="${entry##*:}"
  if [ -n "$FILTER" ] && [ "$FILTER" != "$name" ] && [ "$FILTER" != "$target" ]; then
    continue
  fi

  outfile="$OUT/$name"
  printf '  %-24s' "$name"
  unset BUN_NO_CODESIGN_MACHO_BINARY
  case "$name" in
    *darwin*) export BUN_NO_CODESIGN_MACHO_BINARY=1 ;;
  esac

  bun build "$ENTRY" \
    --compile \
    --target="$target" \
    --outfile="$outfile" \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --no-compile-autoload-package-json \
    --define __LORE_VERSION__="\"$VERSION\"" \
    --define __LORE_STANDALONE__=true >/dev/null

  if [[ "$name" == *darwin* ]] && [ "$(uname -s)" = "Darwin" ]; then
    codesign --force --sign - "$outfile"
    codesign --verify --strict "$outfile"
  fi
  chmod +x "$outfile"
  echo "done"
  built=$((built + 1))
done

if [ "$built" -eq 0 ]; then
  echo "Unknown Lore binary target: $FILTER" >&2
  exit 1
fi

echo "Binaries written to $OUT"
