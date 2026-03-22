# Zephyr RTOS On QEMU x86 In The Browser

Run Zephyr RTOS inside QEMU compiled to WebAssembly with Emscripten and interact using a two-way xterm.js terminal.

## What This Repo Provides

- Zephyr firmware project for `qemu_x86` with shell enabled.
- Browser frontend that loads `qemu-system-i386.js` and mounts `zephyr.elf`.
- TTY bridge for bidirectional serial communication between xterm.js and QEMU.
- Local development server with COOP/COEP headers for SharedArrayBuffer.

## Layout

- `firmware/`: Zephyr app and build config.
- `scripts/build.sh`: One-command build and artifact staging.
- `scripts/dev.sh`: Build (or reuse artifacts) and launch local web server.
- `web/index.html`: Terminal UI.
- `web/main.js`: QEMU startup and serial bridge.
- `web/serve.py`: COI-enabled static server.

## Automated Build

From repo root:

```bash
chmod +x scripts/build.sh
scripts/build.sh
```

This will:

- Initialize west workspace if needed.
- Run `west update`.
- Build Zephyr firmware for `qemu_x86`.
- Copy `firmware/build/zephyr/zephyr.elf` into `web/zephyr.elf`.

If you already built QEMU wasm elsewhere, copy runtime artifacts in the same step:

```bash
scripts/build.sh --qemu-build-dir /path/to/qemu/build-wasm
```

To only copy runtime files without rebuilding firmware:

```bash
scripts/build.sh --skip-firmware --qemu-build-dir /path/to/qemu/build-wasm
```

## One-Command Dev Run

From repo root:

```bash
chmod +x scripts/dev.sh
scripts/dev.sh --port 8125
```

This runs `scripts/build.sh` first, then launches `web/serve.py`.

If firmware is already built and you only want to refresh runtime assets:

```bash
scripts/dev.sh --skip-firmware --qemu-build-dir /path/to/qemu/build-wasm --port 8125
```

## Build Zephyr Firmware

```bash
cd firmware
west init -l .
west update
west build -b qemu_x86 .
```

Resulting binary:

- `firmware/build/zephyr/zephyr.elf`

Copy it into the web folder:

```bash
cp firmware/build/zephyr/zephyr.elf web/
```

## Build QEMU WebAssembly Binary

### Automated (Recommended)

From repo root:

```bash
./scripts/build-qemu-wasm.sh
```

This will:
- Auto-detect Docker and use containerized build when available (recommended).
- Fall back to native emsdk build when Docker is unavailable.
- Copy `qemu-system-i386.{js,wasm}` and ROM files (`bios-256k.bin`, `kvmvapic.bin`, `multiboot_dma.bin`) to `web/` (`worker.js` is optional).

Options:

```bash
./scripts/build-qemu-wasm.sh --docker                  # Force Docker build
./scripts/build-qemu-wasm.sh --native                  # Force native emsdk build
./scripts/build-qemu-wasm.sh --emsdk-dir /custom/emsdk --qemu-dir /custom/qemu
./scripts/build-qemu-wasm.sh --skip-emsdk              # Native mode only
./scripts/build-qemu-wasm.sh --skip-build              # Native mode only (just copy)
./scripts/build-qemu-wasm.sh --help
```

### Manual (If Needed)

From a QEMU source tree with emsdk support:

```bash
# Source Emscripten
source /path/to/emsdk/emsdk_env.sh

# Configure and build
mkdir -p build-wasm && cd build-wasm
emconfigure ../configure \
  --cpu=wasm64 \
  --target-list=i386-softmmu \
  --enable-system \
  --enable-tcg-interpreter \
  --disable-user \
  --disable-docs \
  --disable-tools \
  --disable-guest-agent
emmake make -j"$(nproc)"

# Copy to web directory
cp i386-softmmu/qemu-system-i386.{js,wasm} /path/to/qemu-wasm-zephyr/web/
cp pc-bios/bios-256k.bin /path/to/qemu-wasm-zephyr/web/
cp pc-bios/kvmvapic.bin pc-bios/multiboot_dma.bin /path/to/qemu-wasm-zephyr/web/
# Optional if your emscripten build emits a pthread worker:
cp i386-softmmu/qemu-system-i386.worker.js /path/to/qemu-wasm-zephyr/web/
```

## Run In Browser

```bash
cd web
python3 serve.py --port 8080
```

Open:

- http://localhost:8080

You should get a Zephyr boot message and an interactive shell prompt.

## Terminal Bridge Details

- Keyboard input is buffered from xterm.js and read by QEMU via Emscripten TTY `get_char`.
- Serial output bytes are captured from TTY `put_char`, batched, and written to xterm.js.
- QEMU runs with `-serial mon:stdio -nographic` to keep serial interactive.

## Next Phase

Networking via proxy (SLIP or Ethernet proxy path) is intended for phase two.
