#!/usr/bin/env bash
#
# Download and install the standalone Lore CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash
#
# Environment overrides:
#   LORE_VERSION           release tag, for example v0.1.0 (default: latest)
#   LORE_BIN_DIR           install directory (default: /usr/local/bin or ~/.local/bin)
#   LORE_REPO              GitHub owner/repository (default: treadiehq/lore)
#   LORE_RELEASE_BASE_URL  alternate releases base URL
#
set -euo pipefail

REPO="${LORE_REPO:-treadiehq/lore}"
VERSION="${LORE_VERSION:-latest}"
BIN_NAME="lore"

if [ -t 1 ]; then
  bold=$(printf '\033[1m')
  dim=$(printf '\033[2m')
  green=$(printf '\033[32m')
  red=$(printf '\033[31m')
  reset=$(printf '\033[0m')
else
  bold=""; dim=""; green=""; red=""; reset=""
fi

say() { printf '%s\n' "${dim}→${reset} $*"; }
ok() { printf '%s\n' "${green}✓${reset} $*"; }
die() { printf '%s\n' "${red}✗${reset} $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH."; }

need curl
need awk

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin)
    os="darwin"
    macos_major="$(sw_vers -productVersion | awk -F. '{print $1}')"
    [ "$macos_major" -ge 13 ] || die "Lore requires macOS 13 or newer."
    ;;
  *) die "Unsupported operating system. Lore currently supports macOS and Linux." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "Unsupported architecture. Lore supports x64 and arm64." ;;
esac

asset="${BIN_NAME}-${os}-${arch}"
release_base="${LORE_RELEASE_BASE_URL:-https://github.com/${REPO}/releases}"
if [ "$VERSION" = "latest" ]; then
  download_base="${release_base}/latest/download"
else
  download_base="${release_base}/download/${VERSION}"
fi

if [ -n "${LORE_BIN_DIR:-}" ]; then
  bin_dir="$LORE_BIN_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  bin_dir="/usr/local/bin"
else
  bin_dir="$HOME/.local/bin"
fi
mkdir -p "$bin_dir"

tmp="$(mktemp -d)"
stage="$bin_dir/.lore-install.$$"
trap 'rm -rf "$tmp"; rm -f "$stage"' EXIT

say "Downloading ${bold}${asset}${reset} (${VERSION})…"
curl -fSL --progress-bar "$download_base/$asset" -o "$tmp/$asset" ||
  die "Could not download $download_base/$asset"
curl -fsSL "$download_base/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  die "Could not download release checksums."

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "The checksum manifest does not contain $asset."
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
else
  die "sha256sum or shasum is required to verify the download."
fi
[ "$actual" = "$expected" ] || die "Checksum verification failed for $asset."
ok "Verified SHA-256 checksum"

cp "$tmp/$asset" "$stage"
chmod 0755 "$stage"
mv -f "$stage" "$bin_dir/$BIN_NAME"
"$bin_dir/$BIN_NAME" --version >/dev/null 2>&1 ||
  die "The installed Lore binary could not run."

installed_version="$("$bin_dir/$BIN_NAME" --version)"
ok "Installed ${bold}Lore $installed_version${reset} at $bin_dir/$BIN_NAME"

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$bin_dir" >> "$GITHUB_PATH"
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    printf '\n'
    say "Add ${bold}$bin_dir${reset} to your PATH:"
    case "$(basename "${SHELL:-}")" in
      zsh) printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc && source ~/.zshrc\n' "$bin_dir" ;;
      bash) printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc && source ~/.bashrc\n' "$bin_dir" ;;
      fish) printf '    fish_add_path "%s"\n' "$bin_dir" ;;
      *) printf '    export PATH="%s:$PATH"\n' "$bin_dir" ;;
    esac
    ;;
esac

printf '\n'
ok "Lore is installed. Connect an agent with:"
printf '    %slore connect --url <url> --token <token>%s\n' "$bold" "$reset"
printf '%sUpdate later:%s  lore update\n' "$dim" "$reset"
