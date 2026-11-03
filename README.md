# Zephyr RTOS On QEMU x86 In The Browser

Run Zephyr RTOS inside QEMU compiled to WebAssembly with Emscripten and interact using a two-way xterm.js terminal.

## What This Repo Provides

- Zephyr firmware project for `qemu_x86` with shell enabled.
- Browser frontend that loads `qemu-system-i386.js` and mounts `zephyr.elf`.
- TTY bridge for bidirectional serial communication between xterm.js and QEMU.
- Local development server with COOP/COEP headers for SharedArrayBuffer.
- Optional real networking: the guest's e1000 is carried to
  [relaynet](https://relaynet.network), which answers DHCP and DNS and connects
  it to the internet. See [Networking](#networking).

## Layout

- `firmware/`: Zephyr app and build config.
- `scripts/build.sh`: One-command build and artifact staging.
- `scripts/dev.sh`: Build (or reuse artifacts) and launch local web server.
- `web/index.html`: Terminal UI.
- `web/main.js`: QEMU startup and serial bridge.
- `web/serve.py`: COI-enabled static server.
- `web/net.js`: carries the e1000's Ethernet frames to relaynet.
- `web/relaynet.mjs`: relaynet's client helper (vendored from zephyr-wasm-soc).
- `patches/`: QEMU patches applied by the Docker build.
- `tests/browser.mjs`: boots the page in headless Chromium and drives the shell.

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

The Docker build pins QEMU and makes two changes so QEMU's main loop runs
under the Emscripten in QEMU's emsdk-wasm64-cross image (5.0.2):

- `patches/0001-util-poll-without-waiting-on-emscripten.patch`: QEMU never
  asks `poll()` to wait; it sleeps on its own thread instead.
- Emscripten's `poll()` answers synchronously. Proxied from a thread it
  returns a Promise, which aborts under `-sASYNCIFY`
  ([emscripten#27291](https://github.com/emscripten-core/emscripten/issues/27291)).

Without them the page stops at "Starting QEMU": `unsupported syscall:
__syscall_ppoll`, or `_emscripten_receive_on_main_thread_js was not in
ASYNCIFY_IMPORTS`. The native and manual builds apply the QEMU patch but not
the Emscripten change, so prefer Docker.

### Manual (If Needed)

From a QEMU source tree with emsdk support, with `patches/*.patch` applied
(`git apply /path/to/qemu-wasm-zephyr/patches/*.patch`) and Emscripten's
`__syscall_poll` made synchronous as in the `Dockerfile`:

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

## Networking

Click **Real network (relaynet)** in the page header, or open the page with
`?net=relaynet`. The guest restarts with its e1000 linked to relaynet, gets an
address by DHCP and can resolve names and open TCP connections:

```
uart:~$ net dns example.com
uart:~$ net ping 10.0.2.2
uart:~$ net tcp connect 1.1.1.1 80
```

How it works: QEMU runs with `-netdev socket,connect=...`, which sends each
frame over a TCP connection with a 4-byte length in front. Emscripten turns
that connection into a WebSocket, and `web/net.js` answers for it in the page,
so the frames go to relaynet's relay (`wss://relay.relaynet.network/`, the
`relay.v1` protocol) and its replies come back the same way. No QEMU change is
needed for this.

The token is your own if you paste one into the token field (kept in this tab
only), otherwise a 15-minute demo token from relaynet. Demo tokens are only
issued to pages on origins relaynet allows, so on `localhost` paste a token
from https://relaynet.network.

Things to know:

- relaynet does not forward ICMP to the internet: `net ping 8.8.8.8` times
  out, `net ping 10.0.2.2` (the relay's gateway) answers.
- Private address ranges, port 25 and some UDP ports are blocked by
  relaynet; see its docs.
- The e1000 must sit in PCI slot 2 (`addr=2`): Zephyr's devicetree wires it to
  IRQ 11, which is that slot's line. In another slot the guest sends but never
  receives.

## Tests

```bash
npm install
npm test                    # boots to the shell, checks `kernel version`
RELAYNET_TOKEN=rr_... npm run test:net
                            # also: DHCP lease, DNS, ping the gateway, TCP out
```

`node tests/browser.mjs --net --origin https://beriberikix.github.io/qemu-wasm-zephyr/`
serves the page under that origin instead, which gets a demo token without
`RELAYNET_TOKEN`. For poking at problems: `--run "net iface; kernel uptime"`
types commands and prints what follows, and `--netdump --pcap-out x.pcap`
saves what the e1000 sent and received.

## Hosting

QEMU's threads need `SharedArrayBuffer`, so the page must be cross-origin
isolated (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`). `web/serve.py` sends them.
GitHub Pages cannot set headers, so a Pages deployment would need a service
worker that adds them (such as coi-serviceworker); none is included.

### Cloudflare

`wrangler.jsonc` deploys `web/` as a Worker with static assets:

- `web/_headers` sets the isolation headers on every static file.
- The QEMU `.wasm` (about 45 MB) is over the 25 MiB limit for a static asset,
  so it goes in an R2 bucket (`qemu-wasm-zephyr`), and `cloudflare/worker.js`
  serves it on the page's origin with the same headers.

Build first (so `web/` holds the QEMU files and `zephyr.elf`), then:

```bash
npx wrangler login
npx wrangler r2 bucket create qemu-wasm-zephyr        # once
npx wrangler r2 object put qemu-wasm-zephyr/qemu-system-i386.wasm \
    --file web/qemu-system-i386.wasm --content-type application/wasm --remote
npm run deploy
```

Upload the `.wasm` again whenever QEMU is rebuilt. To try it locally, put the
object with `--local` instead of `--remote` and run `npm run dev:cf`
(http://localhost:8787/).

To check a deployment: `node tests/browser.mjs --url https://<worker>/`
(add `--net`, with `RELAYNET_TOKEN` set, for the network checks).

relaynet only gives demo tokens to pages on origins it allows, so a new host
needs its origin added there; until then, visitors paste a token.
