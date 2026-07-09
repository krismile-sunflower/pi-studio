#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="$(pwd)"
PORT=3991
TIMEOUT_SECONDS=20
USE_SYSTEM_PI=0
MIRROR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-path)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --project-path=*)
      PROJECT_PATH="${1#*=}"
      shift
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --timeout-seconds=*)
      TIMEOUT_SECONDS="${1#*=}"
      shift
      ;;
    --use-system-pi)
      USE_SYSTEM_PI=1
      shift
      ;;
    --mirror)
      MIRROR=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

LOG_DIR="$ROOT/src-tauri/target/smoke"
SESSION_DIR="$LOG_DIR/sessions"
STDOUT_LOG="$LOG_DIR/pi-smoke.out.log"
STDERR_LOG="$LOG_DIR/pi-smoke.err.log"
mkdir -p "$SESSION_DIR"
: >"$STDOUT_LOG"
: >"$STDERR_LOG"

case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) PLATFORM_DIR="macos-x64" ;;
  Darwin-arm64 | Darwin-aarch64) PLATFORM_DIR="macos-arm64" ;;
  Linux-x86_64) PLATFORM_DIR="linux-x64" ;;
  *)
    echo "Unsupported smoke platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

ARGS=("--mode" "rpc" "--session-dir" "$SESSION_DIR" "--no-approve")

if [[ "$MIRROR" -eq 1 ]]; then
  EXTENSION="$ROOT/src-tauri/extensions/mirror-server.ts"
  STATIC_DIR="$ROOT/src"
  if [[ ! -f "$EXTENSION" ]]; then
    echo "Tau extension not found: $EXTENSION" >&2
    exit 1
  fi
  export TAU_MIRROR_PORT="$PORT"
  export TAU_HOST="127.0.0.1"
  export TAU_STATIC_DIR="$STATIC_DIR"
  ARGS+=("--extension" "$EXTENSION")
fi
export TAU_DESKTOP=1

resolve_pi_command() {
  if [[ -n "${PI_DESKTOP_CLI:-}" ]]; then
    PI_FILE="$PI_DESKTOP_CLI"
    PI_ARGS=("${ARGS[@]}")
    return
  fi

  local bundled_dir="$ROOT/src-tauri/binaries/$PLATFORM_DIR"
  local bundled_node="$bundled_dir/node"
  local bundled_cli="$bundled_dir/pi-package/dist/cli.js"
  if [[ "$USE_SYSTEM_PI" -eq 0 && -x "$bundled_node" && -f "$bundled_cli" ]]; then
    PI_FILE="$bundled_node"
    PI_ARGS=("$bundled_cli" "${ARGS[@]}")
    return
  fi

  if [[ "$USE_SYSTEM_PI" -eq 0 && -z "${PI_DESKTOP_CLI:-}" ]]; then
    echo "Warning: bundled Pi runtime not found for $PLATFORM_DIR; falling back to system pi." >&2
    echo "Run scripts/vendor-pi-sidecar-unix.sh on the target platform to test the packaged runtime." >&2
  fi

  PI_FILE="$(command -v pi || true)"
  if [[ -z "$PI_FILE" ]]; then
    echo "Could not find system pi on PATH." >&2
    exit 1
  fi
  PI_ARGS=("${ARGS[@]}")
}

require_node_for_json() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required for smoke JSON checks." >&2
    exit 1
  fi
}

json_response_matches() {
  local id="$1"
  local line="$2"
  node -e '
const id = process.argv[1];
const line = process.argv[2];
try {
  const value = JSON.parse(line);
  process.exit(value.type === "response" && value.id === id ? 0 : 1);
} catch {
  process.exit(1);
}
' "$id" "$line"
}

assert_success() {
  local name="$1"
  local line="$2"
  node -e '
const name = process.argv[1];
const value = JSON.parse(process.argv[2]);
if (value.success !== true) {
  console.error(`${name} failed: ${value.error || "unknown error"}`);
  process.exit(1);
}
' "$name" "$line"
}

assert_models_payload() {
  local line="$1"
  node -e '
const value = JSON.parse(process.argv[1]);
if (!value.data || !Array.isArray(value.data.models)) {
  console.error("get_available_models returned an unexpected payload");
  process.exit(1);
}
' "$line"
}

wait_rpc_response() {
  local id="$1"
  local deadline="$2"
  local line
  while (( "$(date +%s)" < deadline )); do
    local remaining=$((deadline - $(date +%s)))
    if (( remaining <= 0 )); then
      break
    fi
    if ! IFS= read -r -t "$remaining" line <&"${PI_PROC[0]}"; then
      break
    fi
    printf '%s\n' "$line" >>"$STDOUT_LOG"
    if json_response_matches "$id" "$line"; then
      RPC_RESPONSE="$line"
      return 0
    fi
  done

  echo "Timed out waiting for RPC response $id" >&2
  return 1
}

send_rpc_line() {
  local json="$1"
  printf '%s\n' "$json" >&"${PI_PROC[1]}"
}

resolve_pi_command
require_node_for_json

coproc PI_PROC {
  cd "$PROJECT_PATH"
  exec "$PI_FILE" "${PI_ARGS[@]}" 2>"$STDERR_LOG"
}
PI_PID="$PI_PROC_PID"

cleanup() {
  if kill -0 "$PI_PID" >/dev/null 2>&1; then
    kill "$PI_PID" >/dev/null 2>&1 || true
    wait "$PI_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))

send_rpc_line '{"id":"pi-smoke-state","type":"get_state"}'
wait_rpc_response "pi-smoke-state" "$DEADLINE"
assert_success "get_state" "$RPC_RESPONSE"

send_rpc_line '{"id":"pi-smoke-models","type":"get_available_models"}'
wait_rpc_response "pi-smoke-models" "$DEADLINE"
assert_success "get_available_models" "$RPC_RESPONSE"
assert_models_payload "$RPC_RESPONSE"

send_rpc_line '{"id":"pi-smoke-entries","type":"get_entries"}'
wait_rpc_response "pi-smoke-entries" "$DEADLINE"
assert_success "get_entries" "$RPC_RESPONSE"

if [[ "$MIRROR" -eq 1 ]]; then
  HEALTH="http://127.0.0.1:$PORT/api/health"
  curl -fsS --max-time 2 "$HEALTH" >/dev/null
  echo "Mirror health check passed at $HEALTH"
fi

echo "Pi native RPC smoke test passed"
