#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="$ROOT_DIR/scripts/build.sh"
WEB_DIR="$ROOT_DIR/web"

PORT=8080
QEMU_BUILD_DIR=""
SKIP_FIRMWARE=0

usage() {
  cat <<EOF
Usage: scripts/dev.sh [options]

Build project artifacts and start the local web server.

Options:
  --port N               Server port (default: 8080)
  --qemu-build-dir PATH  Path to QEMU wasm build directory to copy runtime files
  --skip-firmware        Skip Zephyr firmware build step
  -h, --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { echo "error: --port requires a value" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --qemu-build-dir)
      [[ $# -ge 2 ]] || { echo "error: --qemu-build-dir requires a value" >&2; exit 2; }
      QEMU_BUILD_DIR="$2"
      shift 2
      ;;
    --skip-firmware)
      SKIP_FIRMWARE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

BUILD_ARGS=()
if [[ "$SKIP_FIRMWARE" -eq 1 ]]; then
  BUILD_ARGS+=(--skip-firmware)
fi
if [[ -n "$QEMU_BUILD_DIR" ]]; then
  BUILD_ARGS+=(--qemu-build-dir "$QEMU_BUILD_DIR")
fi

echo "[dev] Running build step..."
"$BUILD_SCRIPT" "${BUILD_ARGS[@]}"

echo "[dev] Starting web server on port $PORT..."
cd "$WEB_DIR"
exec python3 serve.py --port "$PORT"
