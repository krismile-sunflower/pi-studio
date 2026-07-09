#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEBUG=0
SKIP_VENDOR_PI=0
SMOKE=0

for arg in "$@"; do
  case "$arg" in
    --debug) DEBUG=1 ;;
    --skip-vendor-pi) SKIP_VENDOR_PI=1 ;;
    --smoke) SMOKE=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT"

if [[ "$SKIP_VENDOR_PI" -eq 0 ]]; then
  "$ROOT/scripts/vendor-pi-sidecar-unix.sh"
fi

npm install
npm install --omit=dev --prefix "$ROOT/src-tauri/extensions"

if [[ "$SMOKE" -eq 1 ]]; then
  echo "Smoke test is currently implemented for Windows PowerShell. Run the app or add a Unix smoke wrapper on this platform."
fi

if [[ "$DEBUG" -eq 1 ]]; then
  npx tauri build --debug
else
  npx tauri build
fi
