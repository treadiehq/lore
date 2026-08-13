#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
LOCK_DIR="$ROOT_DIR/.tmp/project-lifecycle.lock"

COMMAND=""
DRY_RUN=0
BUILD=1
HEADLESS=0

usage() {
  cat <<'EOF'
lore project lifecycle

Usage:
  ./scripts/project.sh <command> [options]

Commands:
  start      Build and start PostgreSQL, migrations, API, and web
  stop       Stop and remove project containers; preserve database data
  restart    Stop, rebuild, and start the complete project
  status     Show current Compose service status
  logs       Follow logs from all Compose services

Options:
  --no-build   Reuse existing images for start or restart
  --headless   Limit start/restart/status/logs to PostgreSQL, migrations, and API
  --dry-run    Print commands without changing anything
  -h, --help   Show this help

Examples:
  ./scripts/project.sh start
  ./scripts/project.sh start --headless
  ./scripts/project.sh restart --no-build
  ./scripts/project.sh stop
  ./scripts/project.sh status
  ./scripts/project.sh logs

Equivalent pnpm commands:
  pnpm project:start
  pnpm project:headless:start
  pnpm project:stop
  pnpm project:restart
  pnpm project:status
  pnpm project:logs
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_command "$@"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

parse_arguments() {
  if [[ "$#" -eq 0 ]]; then
    usage
    exit 0
  fi

  COMMAND="$1"
  shift

  case "$COMMAND" in
    start|stop|restart|status|logs) ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown command \"$COMMAND\". Try: ./scripts/project.sh --help"
      ;;
  esac

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --)
        ;;
      --no-build)
        BUILD=0
        ;;
      --headless)
        HEADLESS=1
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option \"$1\". Try: ./scripts/project.sh $COMMAND --help"
        ;;
    esac
    shift
  done

  if [[ "$BUILD" -eq 0 && "$COMMAND" == "status" ]]; then
    fail "--no-build is not valid with status"
  fi
  if [[ "$HEADLESS" -eq 1 && "$COMMAND" == "stop" ]]; then
    fail "--headless is not valid with stop; stopping always tears down the complete stack"
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 ||
    fail "Docker is required. Install Docker Desktop and try again."

  if [[ "$DRY_RUN" -eq 0 ]]; then
    docker compose version >/dev/null 2>&1 ||
      fail "Docker Compose is unavailable. Start Docker Desktop and try again."
    docker info >/dev/null 2>&1 ||
      fail "The Docker daemon is unavailable. Start Docker Desktop and try again."
  fi
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_environment() {
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ENV_EXAMPLE" ]] ||
      fail "Missing $ENV_EXAMPLE; cannot initialize local configuration."
    printf 'Creating .env from .env.example\n'
    run cp "$ENV_EXAMPLE" "$ENV_FILE"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      chmod 600 "$ENV_FILE"
    fi
  fi

  if [[ -n "${LORE_WORKSPACE_TOKEN:-}" || "$DRY_RUN" -eq 1 ]]; then
    return
  fi

  local current_token
  current_token="$(
    awk -F= '/^LORE_WORKSPACE_TOKEN=/{sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE"
  )"
  if [[ -n "$current_token" && "$current_token" != "replace-with-a-long-random-workspace-token" ]]; then
    return
  fi

  local token temporary
  token="$(generate_token)"
  temporary="${ENV_FILE}.tmp.$$"
  awk -v token="$token" '
    BEGIN { replaced = 0 }
    /^LORE_WORKSPACE_TOKEN=/ {
      print "LORE_WORKSPACE_TOKEN=" token
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        print "LORE_WORKSPACE_TOKEN=" token
      }
    }
  ' "$ENV_FILE" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
  printf 'Generated a local LORE_WORKSPACE_TOKEN in .env\n'
}

acquire_lock() {
  if [[ "$DRY_RUN" -eq 1 || "$COMMAND" == "status" || "$COMMAND" == "logs" ]]; then
    return
  fi

  mkdir -p "$(dirname "$LOCK_DIR")"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    trap release_lock EXIT
    return
  fi

  local owner=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    owner="$(<"$LOCK_DIR/pid")"
  fi
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    fail "Another lifecycle command is already running with PID $owner."
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null ||
    fail "Could not clear stale lifecycle lock at $LOCK_DIR."
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  trap release_lock EXIT
}

release_lock() {
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

env_value() {
  local name="$1"
  local fallback="$2"
  local value

  value="$(printenv "$name" 2>/dev/null || true)"
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(
      awk -F= -v name="$name" '
        $1 == name {
          sub(/^[^=]*=/, "")
          gsub(/^["'"'"']|["'"'"']$/, "")
          print
          exit
        }
      ' "$ENV_FILE"
    )"
  fi
  printf '%s' "${value:-$fallback}"
}

service_is_running() {
  local expected="$1"
  local service
  while IFS= read -r service; do
    if [[ "$service" == "$expected" ]]; then
      return 0
    fi
  done < <(docker compose ps --services --status running 2>/dev/null || true)
  return 1
}

port_is_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return
  fi
  return 1
}

require_available_port() {
  local service="$1"
  local variable="$2"
  local port="$3"

  if service_is_running "$service" || ! port_is_in_use "$port"; then
    return
  fi

  if [[ "$variable" == "POSTGRES_PORT" ]]; then
    fail "Port $port is already in use. Set POSTGRES_PORT and the matching DATABASE_URL port in .env, then try again."
  fi
  fail "Port $port is already in use. Set $variable to a free port in .env and try again."
}

preflight_ports() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return
  fi

  require_available_port postgres POSTGRES_PORT "$(env_value POSTGRES_PORT 5432)"
  require_available_port api API_PORT "$(env_value API_PORT 3004)"
  if [[ "$HEADLESS" -eq 0 ]]; then
    require_available_port web NUXT_PORT "$(env_value NUXT_PORT 3002)"
  fi
}

compose_up() {
  ensure_environment
  preflight_ports

  local arguments=(compose up -d --wait --remove-orphans)
  if [[ "$BUILD" -eq 1 ]]; then
    arguments+=(--build)
  fi
  if [[ "$HEADLESS" -eq 1 ]]; then
    arguments+=(postgres migrate api)
  fi

  if [[ "$HEADLESS" -eq 1 ]]; then
    printf 'Starting the headless lore stack...\n'
  else
    printf 'Starting the complete lore stack...\n'
  fi
  run docker "${arguments[@]}"

  if [[ "$DRY_RUN" -eq 0 ]]; then
    local api_port
    api_port="$(env_value API_PORT 3004)"
    printf '\nstatus: started\n'
    if [[ "$HEADLESS" -eq 0 ]]; then
      local ui_port
      ui_port="$(env_value NUXT_PORT 3002)"
      printf 'ui_url: http://localhost:%s\n' "$ui_port"
      printf 'signup_url: http://localhost:%s/signup\n' "$ui_port"
      printf 'login_url: http://localhost:%s/login\n' "$ui_port"
      printf 'local_magic_links: docker compose logs -f api\n'
    fi
    printf 'api_url: http://localhost:%s\n' "$api_port"
    if [[ "$HEADLESS" -eq 1 ]]; then
      printf 'services: postgres migrate api\n'
      printf 'logs: pnpm project:headless:logs\n'
    else
      printf 'logs: docker compose logs -f\n'
    fi
  fi
}

compose_down() {
  printf 'Stopping the complete lore stack...\n'
  run docker compose down --remove-orphans
  if [[ "$DRY_RUN" -eq 0 ]]; then
    printf '\nstatus: stopped\n'
    printf 'database_data: preserved\n'
  fi
}

main() {
  parse_arguments "$@"
  cd "$ROOT_DIR"
  require_docker
  acquire_lock

  case "$COMMAND" in
    start)
      compose_up
      ;;
    stop)
      compose_down
      ;;
    restart)
      compose_down
      compose_up
      ;;
    status)
      if [[ "$HEADLESS" -eq 1 ]]; then
        run docker compose ps postgres migrate api
      else
        run docker compose ps
      fi
      ;;
    logs)
      if [[ "$HEADLESS" -eq 1 ]]; then
        run docker compose logs --follow postgres migrate api
      else
        run docker compose logs --follow
      fi
      ;;
  esac
}

main "$@"
