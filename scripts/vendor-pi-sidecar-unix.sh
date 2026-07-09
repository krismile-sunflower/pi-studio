#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_HOME="${NODE_HOME:-}"
NODE_BIN="${NODE_BIN:-}"
PI_PACKAGE="${PI_PACKAGE:-}"
OUT_DIR="${OUT_DIR:-}"

case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) PLATFORM_DIR="macos-x64" ;;
  Darwin-arm64) PLATFORM_DIR="macos-arm64" ;;
  Darwin-aarch64) PLATFORM_DIR="macos-arm64" ;;
  Linux-x86_64) PLATFORM_DIR="linux-x64" ;;
  *)
    echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$ROOT/src-tauri/binaries/$PLATFORM_DIR"
elif [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$ROOT/$OUT_DIR"
fi

resolve_realpath() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
  else
    local target="$1"
    if [[ -d "$target" ]]; then
      (cd "$target" && pwd -P)
    else
      local dir
      dir="$(cd "$(dirname "$target")" && pwd -P)"
      echo "$dir/$(basename "$target")"
    fi
  fi
}

add_candidate() {
  local value="${1:-}"
  [[ -n "$value" ]] && CANDIDATES+=("$value")
}

PI_BIN="$(command -v pi || true)"
if [[ -z "$PI_BIN" && -z "$PI_PACKAGE" ]]; then
  echo "Could not find pi on PATH. Install @earendil-works/pi-coding-agent or set PI_PACKAGE." >&2
  exit 1
fi

PI_BIN_REAL=""
PI_BIN_DIR=""
PI_BIN_REAL_DIR=""
if [[ -n "$PI_BIN" ]]; then
  PI_BIN_REAL="$(resolve_realpath "$PI_BIN")"
  PI_BIN_DIR="$(cd "$(dirname "$PI_BIN")" && pwd)"
  PI_BIN_REAL_DIR="$(cd "$(dirname "$PI_BIN_REAL")" && pwd)"
fi

if [[ -z "$NODE_HOME" && -n "$PI_BIN_DIR" ]]; then
  NODE_HOME="$PI_BIN_DIR"
fi

CANDIDATES=()
add_candidate "$NODE_BIN"
if [[ -n "$NODE_HOME" ]]; then
  add_candidate "$NODE_HOME/node"
  add_candidate "$NODE_HOME/bin/node"
fi
add_candidate "$(command -v node || true)"

NODE_BIN=""
for candidate in "${CANDIDATES[@]}"; do
  [[ -x "$candidate" ]] || continue
  NODE_BIN="$(resolve_realpath "$candidate")"
  break
done

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node executable not found. Set NODE_BIN or make node available on PATH." >&2
  exit 1
fi

GLOBAL_ROOT=""
NPM_PREFIX=""
if command -v npm >/dev/null 2>&1; then
  GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
fi

CANDIDATES=()
add_candidate "$PI_PACKAGE"
if [[ -n "$GLOBAL_ROOT" ]]; then
  add_candidate "$GLOBAL_ROOT/@earendil-works/pi-coding-agent"
fi
if [[ -n "$NPM_PREFIX" ]]; then
  add_candidate "$NPM_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent"
  add_candidate "$NPM_PREFIX/node_modules/@earendil-works/pi-coding-agent"
fi
if [[ -n "$NODE_HOME" ]]; then
  add_candidate "$NODE_HOME/node_modules/@earendil-works/pi-coding-agent"
  add_candidate "$NODE_HOME/lib/node_modules/@earendil-works/pi-coding-agent"
  add_candidate "$(dirname "$NODE_HOME")/lib/node_modules/@earendil-works/pi-coding-agent"
fi
if [[ -n "$PI_BIN_DIR" ]]; then
  add_candidate "$PI_BIN_DIR/node_modules/@earendil-works/pi-coding-agent"
  add_candidate "$(dirname "$PI_BIN_DIR")/lib/node_modules/@earendil-works/pi-coding-agent"
  add_candidate "$(dirname "$PI_BIN_DIR")/node_modules/@earendil-works/pi-coding-agent"
fi
if [[ -n "$PI_BIN_REAL_DIR" ]]; then
  add_candidate "$PI_BIN_REAL_DIR/.."
  add_candidate "$PI_BIN_REAL_DIR/../.."
fi

PI_PACKAGE=""
for candidate in "${CANDIDATES[@]}"; do
  [[ -d "$candidate" ]] || continue
  candidate="$(resolve_realpath "$candidate")"
  if [[ -f "$candidate/dist/cli.js" ]]; then
    PI_PACKAGE="$candidate"
    break
  fi
done

if [[ -z "$PI_PACKAGE" || ! -f "$PI_PACKAGE/dist/cli.js" ]]; then
  echo "Pi npm package not found. Tried npm root -g, npm prefix -g, NODE_HOME, and the resolved pi symlink target." >&2
  echo "Set PI_PACKAGE=/path/to/@earendil-works/pi-coding-agent to override." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp -f "$NODE_BIN" "$OUT_DIR/node"
chmod +x "$OUT_DIR/node"

for name in pi pi.cmd pi.ps1; do
  if [[ -e "$NODE_HOME/$name" ]]; then
    cp -f "$NODE_HOME/$name" "$OUT_DIR/$name"
  elif [[ -n "$PI_BIN_DIR" && -e "$PI_BIN_DIR/$name" ]]; then
    cp -f "$PI_BIN_DIR/$name" "$OUT_DIR/$name"
  fi
done

rm -rf "$OUT_DIR/pi-package" "$OUT_DIR/node_modules"
cp -R "$PI_PACKAGE" "$OUT_DIR/pi-package"
find "$OUT_DIR/pi-package" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete
find "$OUT_DIR/pi-package" -path '*/node_modules/*/src' -type d -prune -exec rm -rf {} +

cat > "$OUT_DIR/pi" <<'EOF'
#!/usr/bin/env sh
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$DIR/node" "$DIR/pi-package/dist/cli.js" "$@"
EOF
chmod +x "$OUT_DIR/pi"

if [[ "$(uname -s)" == "Darwin" ]]; then
  xattr -dr com.apple.quarantine "$OUT_DIR" 2>/dev/null || true
fi

"$OUT_DIR/node" "$OUT_DIR/pi-package/dist/cli.js" --version >/dev/null

echo "Vendored Pi sidecar to $OUT_DIR"
echo "Node: $OUT_DIR/node"
echo "Pi package: $OUT_DIR/pi-package"
