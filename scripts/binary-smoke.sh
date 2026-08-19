#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) asset="lore-darwin-arm64" ;;
  Darwin:x86_64) asset="lore-darwin-x64" ;;
  Linux:aarch64|Linux:arm64) asset="lore-linux-arm64" ;;
  Linux:x86_64) asset="lore-linux-x64" ;;
  *) echo "Unsupported binary smoke-test host." >&2; exit 1 ;;
esac

binary="$ROOT/dist/release/$asset"
expected="$(node -p "require('$ROOT/packages/cli/package.json').version")"
installed_version=""
if [ -x "$binary" ]; then
  installed_version="$("$binary" --version 2>/dev/null || true)"
fi
if [ "$installed_version" != "$expected" ]; then
  bash "$SCRIPT_DIR/build-release.sh" "$asset"
fi

actual="$("$binary" --version)"
[ "$actual" = "$expected" ] || {
  echo "Version mismatch: expected $expected, received $actual" >&2
  exit 1
}
"$binary" --help >/dev/null
"$binary" update --help >/dev/null

tmp="$(mktemp -d)"
mock_pid=""
cleanup() {
  if [ -n "$mock_pid" ]; then
    kill "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

release="$tmp/releases/download/v$expected"
mkdir -p "$release"
cp "$binary" "$release/$asset"
if command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "$release/$asset" | awk '{print $1}')"
else
  checksum="$(shasum -a 256 "$release/$asset" | awk '{print $1}')"
fi
printf '%s  %s\n' "$checksum" "$asset" > "$release/SHA256SUMS"
LORE_VERSION="v$expected" \
LORE_RELEASE_BASE_URL="file://$tmp/releases" \
LORE_BIN_DIR="$tmp/installed" \
  bash "$SCRIPT_DIR/install.sh" >/dev/null
"$tmp/installed/lore" --version | grep -Fx "$expected" >/dev/null || {
  echo "The installer did not produce a working Lore binary." >&2
  exit 1
}

mock_port_file="$tmp/mock-port"
node -e '
  const { writeFileSync } = require("node:fs");
  const { createServer } = require("node:http");
  const [version, portFile] = process.argv.slice(1);
  const server = createServer((request, response) => {
    if (
      request.url !== "/v1/workspace/identity" ||
      request.headers.authorization !== "Bearer binary-smoke-token"
    ) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      workspaceName: "Binary smoke",
      organization: "release",
      credentialType: "workspace_token",
      server: { version, revision: null },
    }));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") process.exit(1);
    writeFileSync(portFile, String(address.port));
  });
' "$expected" "$mock_port_file" &
mock_pid="$!"
for _ in $(seq 1 50); do
  [ -s "$mock_port_file" ] && break
  sleep 0.1
done
[ -s "$mock_port_file" ] || {
  echo "The binary smoke identity server did not start." >&2
  exit 1
}
mock_port="$(<"$mock_port_file")"

HOME="$tmp/home" "$binary" connect \
  --url "http://127.0.0.1:$mock_port" \
  --token "binary-smoke-token" \
  --agent codex >/dev/null

hooks="$tmp/home/.codex/hooks.json"
[ -f "$hooks" ] || { echo "Codex hooks were not installed." >&2; exit 1; }
grep -F "'$binary' hook --agent codex --owner lore" "$hooks" >/dev/null || {
  echo "Installed hooks do not invoke the standalone Lore binary." >&2
  exit 1
}
[ ! -e "$tmp/home/.lore/bin/lore-hook.mjs" ] || {
  echo "The standalone connector installed a legacy JavaScript hook." >&2
  exit 1
}

repo="$tmp/repository"
mkdir -p "$repo"
"$binary" connect github --repo-root "$repo" >/dev/null
[ -s "$repo/.github/workflows/lore-codex-review.yml" ] || {
  echo "Embedded GitHub workflow templates were not installed." >&2
  exit 1
}
[ -s "$repo/.github/lore/review-output.schema.json" ] || {
  echo "The embedded review schema was not installed." >&2
  exit 1
}

printf '{}\n' | HOME="$tmp/home" "$binary" hook --agent codex --owner lore >/dev/null
HOME="$tmp/home" "$binary" disconnect >/dev/null

echo "Standalone Lore binary smoke test passed ($asset $actual)."
