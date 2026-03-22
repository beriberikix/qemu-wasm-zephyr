#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIRMWARE_DIR="$ROOT_DIR/firmware"
WEB_DIR="$ROOT_DIR/web"

QEMU_BUILD_DIR=""
SKIP_FIRMWARE=0

usage() {
  cat <<EOF
Usage: scripts/build.sh [options]

Build Zephyr firmware for qemu_x86 and copy zephyr.elf into web/.
Optionally copy QEMU wasm runtime artifacts from an existing QEMU wasm build.

Options:
  --qemu-build-dir PATH   Path to QEMU wasm build directory that contains:
                          qemu-system-i386.js/.wasm, bios-256k.bin,
                          kvmvapic.bin, and multiboot_dma.bin
                          (worker.js optional)
  --skip-firmware         Skip Zephyr firmware build step
  -h, --help              Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

mkdir -p "$WEB_DIR"

if [[ "$SKIP_FIRMWARE" -eq 0 ]]; then
  if ! command -v west >/dev/null 2>&1; then
    echo "[warn] 'west' is not installed, so Zephyr firmware cannot be built." >&2
    echo "[warn] Please install Zephyr dependencies by following:" >&2
    echo "       https://docs.zephyrproject.org/latest/develop/getting_started/index.html" >&2
    echo "[warn] Or rerun with --skip-firmware if you only want runtime file staging." >&2
    exit 1
  fi

  echo "[build] Building Zephyr firmware..."
  pushd "$FIRMWARE_DIR" >/dev/null

  if ! west topdir >/dev/null 2>&1; then
    echo "[build] Initializing west workspace..."
    west init -l .
  else
    echo "[build] Using existing west workspace: $(west topdir)"
  fi

  echo "[build] Updating west modules..."
  west update

  echo "[build] Running west build..."
  west build -b qemu_x86 .
  popd >/dev/null

  FIRMWARE_ELF="$FIRMWARE_DIR/build/zephyr/zephyr.elf"
  if [[ ! -f "$FIRMWARE_ELF" ]]; then
    echo "error: expected firmware not found: $FIRMWARE_ELF" >&2
    exit 1
  fi

  cp "$FIRMWARE_ELF" "$WEB_DIR/zephyr.elf"
  echo "[build] Copied firmware -> $WEB_DIR/zephyr.elf"
fi

if [[ -n "$QEMU_BUILD_DIR" ]]; then
  QEMU_BUILD_DIR="$(cd "$QEMU_BUILD_DIR" && pwd)"
  find_rom() {
    local rom_name="$1"
    local candidate="$QEMU_BUILD_DIR/$rom_name"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
    candidate="$QEMU_BUILD_DIR/pc-bios/$rom_name"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
    find "$QEMU_BUILD_DIR" -type f -name "$rom_name" | head -n 1 || true
  }

  BIOS_CANDIDATE="$(find_rom bios-256k.bin)"
  KVMVAPIC_CANDIDATE="$(find_rom kvmvapic.bin)"
  MULTIBOOT_DMA_CANDIDATE="$(find_rom multiboot_dma.bin)"

  for f in qemu-system-i386.js qemu-system-i386.wasm; do
    if [[ ! -f "$QEMU_BUILD_DIR/$f" ]]; then
      echo "error: missing runtime file: $QEMU_BUILD_DIR/$f" >&2
      exit 1
    fi
  done

  if [[ -z "$BIOS_CANDIDATE" || ! -f "$BIOS_CANDIDATE" ]]; then
    echo "error: missing BIOS file: bios-256k.bin (searched under $QEMU_BUILD_DIR)" >&2
    exit 1
  fi
  if [[ -z "$KVMVAPIC_CANDIDATE" || ! -f "$KVMVAPIC_CANDIDATE" ]]; then
    echo "error: missing ROM file: kvmvapic.bin (searched under $QEMU_BUILD_DIR)" >&2
    exit 1
  fi
  if [[ -z "$MULTIBOOT_DMA_CANDIDATE" || ! -f "$MULTIBOOT_DMA_CANDIDATE" ]]; then
    echo "error: missing ROM file: multiboot_dma.bin (searched under $QEMU_BUILD_DIR)" >&2
    exit 1
  fi

  cp "$QEMU_BUILD_DIR/qemu-system-i386.js" "$WEB_DIR/"
  cp "$QEMU_BUILD_DIR/qemu-system-i386.wasm" "$WEB_DIR/"
  cp "$BIOS_CANDIDATE" "$WEB_DIR/bios-256k.bin"
  cp "$KVMVAPIC_CANDIDATE" "$WEB_DIR/kvmvapic.bin"
  cp "$MULTIBOOT_DMA_CANDIDATE" "$WEB_DIR/multiboot_dma.bin"
  if [[ -f "$QEMU_BUILD_DIR/qemu-system-i386.worker.js" ]]; then
    cp "$QEMU_BUILD_DIR/qemu-system-i386.worker.js" "$WEB_DIR/"
  else
    echo "[warn] optional runtime file not found: $QEMU_BUILD_DIR/qemu-system-i386.worker.js" >&2
  fi
  echo "[build] Copied QEMU wasm runtime -> $WEB_DIR"
fi

missing_runtime=0
for f in qemu-system-i386.js qemu-system-i386.wasm bios-256k.bin kvmvapic.bin multiboot_dma.bin; do
  if [[ ! -f "$WEB_DIR/$f" ]]; then
    missing_runtime=1
    break
  fi
done

if [[ "$missing_runtime" -eq 1 ]]; then
  echo "[warn] QEMU wasm runtime files are not present in $WEB_DIR" >&2
  echo "[warn] Browser startup will fail until you stage them. Example:" >&2
  echo "       ./scripts/build.sh --skip-firmware --qemu-build-dir /path/to/qemu/build-wasm" >&2
fi

echo "[build] Done."
