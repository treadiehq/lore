#!/usr/bin/env bash

set -euo pipefail

DEFAULT_IMAGE_TAG="0.1.4"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_CONFIG="${SCRIPT_DIR}/api.fly.toml"
WEB_CONFIG="${SCRIPT_DIR}/web.fly.toml"

usage() {
  cat <<'EOF'
Deploy Lore's API and web apps to Fly.io without interactive prompts.

Usage:
  deploy/fly/deploy.sh \
    --api-app <name> \
    --web-app <name> \
    --fly-org <slug> \
    --region <code> \
    [options]

Required environment:
  DATABASE_URL                 PostgreSQL URL for a pgvector-enabled database
  LORE_WORKSPACE_TOKEN         Workspace token (at least 24 characters)
  LORE_OWNER_BOOTSTRAP_TOKEN   Distinct 256-bit base64url or hexadecimal token

Required flags:
  --api-app <name>             Fly app name for the Lore API
  --web-app <name>             Fly app name for the Lore dashboard
  --fly-org <slug>             Fly organization containing both apps
  --region <code>              Three-letter Fly region code

Options:
  --image-tag <semver>         Pinned canonical image tag (default: 0.1.4)
  --api-origin <origin>        Public API origin
                               (default: https://<api-app>.fly.dev)
  --web-origin <origin>        Public dashboard origin
                               (default: https://<web-app>.fly.dev)
  --workspace-organization <name>
                               Lore workspace organization (default: local)
  --workspace-name <name>      Lore workspace display name
                               (default: workspace organization)
  --dry-run                    Validate inputs and print a redacted plan only
  -h, --help                   Show this help

Examples:
  DATABASE_URL='postgresql://...' \
  LORE_WORKSPACE_TOKEN='lore_<43-base64url-characters>' \
  LORE_OWNER_BOOTSTRAP_TOKEN='<43-base64url-characters>' \
    deploy/fly/deploy.sh \
      --api-app my-lore-api \
      --web-app my-lore-web \
      --fly-org personal \
      --region ord \
      --dry-run

  deploy/fly/deploy.sh \
    --api-app my-lore-api \
    --web-app my-lore-web \
    --fly-org personal \
    --region ord \
    --web-origin https://lore.example.com

The helper creates missing apps, stages API secrets over stdin, deploys one
Machine per app, and never prints secret values.
EOF
}

die() {
  printf 'Error: %s\nTry: deploy/fly/deploy.sh --help\n' "$1" >&2
  exit 1
}

require_value() {
  local flag="$1"
  local value="${2-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    die "Missing value for ${flag}"
  fi
}

require_one_line() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    die "${name} must be a non-empty, single-line value"
  fi
}

print_command() {
  local argument
  printf '  '
  for argument in "$@"; do
    printf '%q ' "$argument"
  done
  printf '\n'
}

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    print_command "$@"
    return
  fi
  "$@"
}

ensure_app() {
  local app="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf 'Ensure app exists:\n'
    print_command flyctl apps create "$app" --org "$FLY_ORG" --yes
    return
  fi
  if flyctl status --app "$app" >/dev/null 2>&1; then
    printf 'App already exists: %s\n' "$app"
    return
  fi
  flyctl apps create "$app" --org "$FLY_ORG" --yes
}

stage_secret() {
  local app="$1"
  local name="$2"
  local value="$3"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf 'Stage secret for %s: %s=<redacted>\n' "$app" "$name"
    print_command flyctl secrets set --app "$app" --stage "${name}=-"
    return
  fi
  printf '%s' "$value" |
    flyctl secrets set --app "$app" --stage "${name}=-"
}

API_APP=""
WEB_APP=""
FLY_ORG=""
REGION=""
IMAGE_TAG="$DEFAULT_IMAGE_TAG"
API_ORIGIN=""
WEB_ORIGIN=""
WORKSPACE_ORGANIZATION="local"
WORKSPACE_NAME=""
DRY_RUN="false"

while (($# > 0)); do
  case "$1" in
    --api-app)
      require_value "$1" "${2-}"
      API_APP="$2"
      shift 2
      ;;
    --web-app)
      require_value "$1" "${2-}"
      WEB_APP="$2"
      shift 2
      ;;
    --fly-org)
      require_value "$1" "${2-}"
      FLY_ORG="$2"
      shift 2
      ;;
    --region)
      require_value "$1" "${2-}"
      REGION="$2"
      shift 2
      ;;
    --image-tag)
      require_value "$1" "${2-}"
      IMAGE_TAG="${2#v}"
      shift 2
      ;;
    --api-origin)
      require_value "$1" "${2-}"
      API_ORIGIN="$2"
      shift 2
      ;;
    --web-origin)
      require_value "$1" "${2-}"
      WEB_ORIGIN="$2"
      shift 2
      ;;
    --workspace-organization)
      require_value "$1" "${2-}"
      WORKSPACE_ORGANIZATION="$2"
      shift 2
      ;;
    --workspace-name)
      require_value "$1" "${2-}"
      WORKSPACE_NAME="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[[ -n "$API_APP" ]] || die "--api-app <name> is required"
[[ -n "$WEB_APP" ]] || die "--web-app <name> is required"
[[ -n "$FLY_ORG" ]] || die "--fly-org <slug> is required"
[[ -n "$REGION" ]] || die "--region <code> is required"

APP_PATTERN='^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
[[ "$API_APP" =~ $APP_PATTERN ]] ||
  die "--api-app must be a 3-63 character lowercase Fly app name"
[[ "$WEB_APP" =~ $APP_PATTERN ]] ||
  die "--web-app must be a 3-63 character lowercase Fly app name"
[[ "$API_APP" != "$WEB_APP" ]] ||
  die "--api-app and --web-app must be different"
[[ "$FLY_ORG" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] ||
  die "--fly-org must be a Fly organization slug"
[[ "$REGION" =~ ^[a-z]{3}$ ]] ||
  die "--region must be a three-letter lowercase Fly region code"
[[ "$IMAGE_TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]] ||
  die "--image-tag must be a pinned semantic version such as 0.1.4"

require_one_line "--fly-org" "$FLY_ORG"
require_one_line "--workspace-organization" "$WORKSPACE_ORGANIZATION"
if ((${#WORKSPACE_ORGANIZATION} > 200)); then
  die "--workspace-organization must contain at most 200 characters"
fi
if [[ -z "$WORKSPACE_NAME" ]]; then
  WORKSPACE_NAME="$WORKSPACE_ORGANIZATION"
fi
require_one_line "--workspace-name" "$WORKSPACE_NAME"
if ((${#WORKSPACE_NAME} > 200)); then
  die "--workspace-name must contain at most 200 characters"
fi

if [[ -z "$API_ORIGIN" ]]; then
  API_ORIGIN="https://${API_APP}.fly.dev"
fi
if [[ -z "$WEB_ORIGIN" ]]; then
  WEB_ORIGIN="https://${WEB_APP}.fly.dev"
fi
ORIGIN_PATTERN='^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
[[ "$API_ORIGIN" =~ $ORIGIN_PATTERN ]] ||
  die "--api-origin must be an HTTPS origin without a path"
[[ "$WEB_ORIGIN" =~ $ORIGIN_PATTERN ]] ||
  die "--web-origin must be an HTTPS origin without a path"
for origin in "$API_ORIGIN" "$WEB_ORIGIN"; do
  authority="${origin#https://}"
  if [[ "$authority" == *:* ]]; then
    port="${authority##*:}"
    if ((10#$port < 1 || 10#$port > 65535)); then
      die "HTTPS origin ports must be between 1 and 65535"
    fi
  fi
done

DATABASE_URL="${DATABASE_URL-}"
LORE_WORKSPACE_TOKEN="${LORE_WORKSPACE_TOKEN-}"
LORE_OWNER_BOOTSTRAP_TOKEN="${LORE_OWNER_BOOTSTRAP_TOKEN-}"

[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is required"
[[ "$DATABASE_URL" =~ ^postgres(ql)?://[^[:space:]]+$ ]] ||
  die "DATABASE_URL must be a single-line PostgreSQL URL"
[[ ${#LORE_WORKSPACE_TOKEN} -ge 24 ]] ||
  die "LORE_WORKSPACE_TOKEN must contain at least 24 characters"
[[ "$LORE_WORKSPACE_TOKEN" != *[[:space:]]* ]] ||
  die "LORE_WORKSPACE_TOKEN must not contain whitespace"
[[ "$LORE_OWNER_BOOTSTRAP_TOKEN" =~ ^([A-Za-z0-9_-]{43}|[A-Fa-f0-9]{64})$ ]] ||
  die "LORE_OWNER_BOOTSTRAP_TOKEN must be a 256-bit base64url or hexadecimal token"
[[ "$LORE_OWNER_BOOTSTRAP_TOKEN" != "$LORE_WORKSPACE_TOKEN" ]] ||
  die "LORE_OWNER_BOOTSTRAP_TOKEN must differ from LORE_WORKSPACE_TOKEN"

[[ -f "$API_CONFIG" ]] || die "Missing template: ${API_CONFIG}"
[[ -f "$WEB_CONFIG" ]] || die "Missing template: ${WEB_CONFIG}"

if [[ "$DRY_RUN" != "true" ]]; then
  command -v flyctl >/dev/null 2>&1 ||
    die "flyctl is required; install it from https://fly.io/docs/flyctl/install/"
  flyctl auth whoami >/dev/null 2>&1 ||
    die "flyctl is not authenticated; run flyctl auth login or set FLY_API_TOKEN"
fi

printf 'Preparing Fly apps in organization %s...\n' "$FLY_ORG"
ensure_app "$API_APP"
ensure_app "$WEB_APP"

printf 'Staging API secrets without exposing their values...\n'
stage_secret "$API_APP" "DATABASE_URL" "$DATABASE_URL"
stage_secret "$API_APP" "LORE_WORKSPACE_TOKEN" "$LORE_WORKSPACE_TOKEN"
stage_secret \
  "$API_APP" \
  "LORE_OWNER_BOOTSTRAP_TOKEN" \
  "$LORE_OWNER_BOOTSTRAP_TOKEN"

printf 'Deploying API...\n'
run flyctl deploy \
  --app "$API_APP" \
  --config "$API_CONFIG" \
  --image "ghcr.io/treadiehq/lore-api:${IMAGE_TAG}" \
  --primary-region "$REGION" \
  --ha=false \
  --yes \
  --env "AUTH_WEB_ORIGIN=${WEB_ORIGIN}" \
  --env "NUXT_ORIGIN=${WEB_ORIGIN}" \
  --env "LORE_WORKSPACE_ORGANIZATION=${WORKSPACE_ORGANIZATION}" \
  --env "LORE_WORKSPACE_NAME=${WORKSPACE_NAME}" \
  --env "LORE_SERVER_VERSION=${IMAGE_TAG}"
run flyctl scale count 1 --app "$API_APP" --yes

printf 'Deploying web dashboard...\n'
run flyctl deploy \
  --app "$WEB_APP" \
  --config "$WEB_CONFIG" \
  --image "ghcr.io/treadiehq/lore-web:${IMAGE_TAG}" \
  --primary-region "$REGION" \
  --ha=false \
  --yes \
  --env "NUXT_LORE_API_URL=http://${API_APP}.internal:3001" \
  --env "NUXT_PUBLIC_LORE_CONNECTOR_API_URL=${API_ORIGIN}"
run flyctl scale count 1 --app "$WEB_APP" --yes

if [[ "$DRY_RUN" == "true" ]]; then
  printf 'status: dry-run complete\n'
else
  printf 'status: deployed\n'
fi
printf 'api_url: %s\nweb_url: %s\nsetup_url: %s/setup\n' \
  "$API_ORIGIN" \
  "$WEB_ORIGIN" \
  "$WEB_ORIGIN"
