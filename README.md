# Zephyr RTOS on QEMU x86, in the browser

**Live demo: https://qemu-wasm-zephyr.jberi.workers.dev**

Zephyr's `qemu_x86` board, running in QEMU compiled to WebAssembly with
Emscripten, with its serial shell in an xterm.js terminal. Everything runs in
the browser tab. With **Real network (relaynet)** turned on, the guest's
emulated e1000 Ethernet card is connected to [relaynet](https://relaynet.network):
the guest gets an address by DHCP, resolves names and opens TCP connections
to the internet.

## Try it

Open the demo and click a command above the terminal, or type one:

```
uart:~$ kernel version
uart:~$ kernel thread list
```

Then click **Real network (relaynet)**. The guest restarts with networking:

```
uart:~$ net iface
uart:~$ net dns example.com
uart:~$ net ping 10.0.2.2
uart:~$ net tcp connect 1.1.1.1 80
```

Networking needs a relaynet token. With none saved, the page asks relaynet
for a free 15-minute demo token, which relaynet only issues to pages on
origins it allows. To use your own token (from https://relaynet.network),
paste it into the field next to the button and click **Save and restart**.
The token is kept in this tab only (sessionStorage), never in the URL, and is
sent only to relaynet.

## How it works

```
Zephyr (qemu_x86: shell, e1000 driver, DHCPv4, DNS, TCP)
  QEMU i386, compiled to wasm64 (TCG interpreter), on a worker thread
    serial   -> Emscripten TTY -> xterm.js
    e1000    -> -netdev socket (length-prefixed Ethernet frames)
             -> Emscripten SOCKFS, which makes the connection a WebSocket
             -> web/net.js, which answers for that WebSocket in the page
             -> relaynet relay (wss://relay.relaynet.network/, relay.v1)
             -> DHCP, DNS and NAT to the internet
```

- **Serial:** keyboard input is buffered from xterm.js and read by QEMU
  through the Emscripten TTY's `get_char`; output bytes from `put_char` are
  batched and written to xterm.js. QEMU's serial port is
  `-chardev stdio -serial chardev:char0`, with `-nographic`.
- **Network:** QEMU's socket netdev needs no change. Emscripten turns its
  `connect()` into a WebSocket to `Module.websocket.url`; `web/net.js` replaces
  `WebSocket` for that one URL, splits QEMU's byte stream into frames, sends
  them to relaynet with its client (`web/relaynet.mjs`, vendored from
  [zephyr-wasm-soc](https://github.com/beriberikix/zephyr-wasm-soc)) and
  frames the replies back.
- **Threads:** QEMU uses pthreads (`SharedArrayBuffer`), so the page must be
  cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.

Things to know:

- relaynet does not forward ICMP to the internet: `net ping 8.8.8.8` times
  out, `net ping 10.0.2.2` (the relay's gateway) answers
  ([relaynet#174](https://github.com/beriberikix/relaynet/issues/174)).
- relaynet blocks private address ranges, port 25 and some UDP ports; see its
  docs.
- The e1000 must sit in PCI slot 2 (`addr=2`): Zephyr's devicetree wires it to
  IRQ 11, which is that slot's line. In another slot the guest sends but never
  receives. The firmware faults at boot without an e1000, so the page always
  adds one (unconnected when networking is off).

## Run it locally

```bash
scripts/build.sh                 # Zephyr firmware -> web/zephyr.elf
./scripts/build-qemu-wasm.sh     # QEMU wasm (Docker) -> web/
cd web && python3 serve.py --port 8080
```

Open http://localhost:8080. Or `scripts/dev.sh --port 8080` builds the
firmware and starts the server in one step. On `localhost` relaynet won't
issue demo tokens, so paste your own token to try networking.

## Build

### Zephyr firmware

`scripts/build.sh` initializes the west workspace if needed, runs
`west update`, builds `firmware/` for `qemu_x86` and copies `zephyr.elf` into
`web/`. By hand:

```bash
cd firmware
west init -l .
west update
west build -b qemu_x86 .
cp build/zephyr/zephyr.elf ../web/
```

The firmware (`firmware/prj.conf`) enables the shell, the e1000 driver, IPv4,
DHCPv4, the DNS resolver, TCP and the net shell; `firmware/src/main.c` starts
DHCP and prints `IPv4 address: ...` when it gets a lease.

If QEMU is built elsewhere, `scripts/build.sh --qemu-build-dir DIR` also copies
its runtime files, and `--skip-firmware` copies only those.

### QEMU WebAssembly

```bash
./scripts/build-qemu-wasm.sh             # Docker if available, else native emsdk
./scripts/build-qemu-wasm.sh --docker    # or --native; --help for the rest
```

It copies `qemu-system-i386.{js,wasm}` and the ROMs (`bios-256k.bin`,
`kvmvapic.bin`, `multiboot_dma.bin`) into `web/`.

The Docker build (`Dockerfile`) uses QEMU's `emsdk-wasm64-cross` image
(Emscripten 5.0.2), pins QEMU, and makes two changes so QEMU's main loop runs
there:

- `patches/0001-util-poll-without-waiting-on-emscripten.patch`: QEMU never
  asks `poll()` to wait; it sleeps on its own thread instead.
- Emscripten's `poll()` answers synchronously. Called from a thread it is
  proxied to the main thread and returns a Promise, which aborts under
  `-sASYNCIFY`
  ([emscripten#27291](https://github.com/emscripten-core/emscripten/issues/27291),
  tracked here in [#1](https://github.com/beriberikix/qemu-wasm-zephyr/issues/1)).

Without them the page stops at "Starting QEMU": `unsupported syscall:
__syscall_ppoll`, or `_emscripten_receive_on_main_thread_js was not in
ASYNCIFY_IMPORTS`. The native build applies the QEMU patch but not the
Emscripten change, so prefer Docker.

To build by hand, from a QEMU source tree with `patches/*.patch` applied and
Emscripten's `__syscall_poll` made synchronous as in the `Dockerfile`:

```bash
source /path/to/emsdk/emsdk_env.sh
emconfigure ./configure --cpu=wasm64 --target-list=i386-softmmu --static \
  --enable-tcg-interpreter --disable-user --disable-docs --disable-tools \
  --disable-guest-agent --disable-debug-info
emmake make -j"$(nproc)"
```

Then copy `qemu-system-i386.js`, `qemu-system-i386.wasm`, `bios-256k.bin`,
`kvmvapic.bin` and `multiboot_dma.bin` from the build tree into `web/`.

## Tests

`tests/browser.mjs` serves `web/` with the isolation headers, boots it in
headless Chromium (Playwright) and drives the shell:

```bash
npm install
npm test                                   # boots, checks `kernel version`
RELAYNET_TOKEN=rr_... npm run test:net     # also DHCP, DNS, gateway ping, TCP out
node tests/browser.mjs --url https://qemu-wasm-zephyr.jberi.workers.dev/
                                           # the same checks against a deployment
```

`--origin https://beriberikix.github.io/qemu-wasm-zephyr/` serves the page
under an origin relaynet gives demo tokens to, so `--net` works without
`RELAYNET_TOKEN`. For debugging, `--run "net iface; kernel uptime"` types
commands and prints what follows, and `--netdump --pcap-out x.pcap` saves
what the e1000 sent and received.

## Hosting

The page needs the cross-origin isolation headers, and QEMU's `.wasm` is
about 45 MB. `web/serve.py` and the tests send the headers locally. GitHub
Pages can't set headers (it would need a service worker such as
coi-serviceworker), so the demo is hosted on Cloudflare.

### Cloudflare

`wrangler.jsonc` deploys `web/` as a Worker with static assets:

- `web/_headers` sets the isolation headers on every static file.
- The `.wasm` is over the 25 MiB limit for a static asset, so it goes in an
  R2 bucket (`qemu-wasm-zephyr`), and `cloudflare/worker.js` serves it on the
  page's origin with the same headers.

Build first (so `web/` holds the QEMU files and `zephyr.elf`), then:

```bash
npx wrangler login
npx wrangler r2 bucket create qemu-wasm-zephyr        # once
npx wrangler r2 object put qemu-wasm-zephyr/qemu-system-i386.wasm \
    --file web/qemu-system-i386.wasm --content-type application/wasm --remote
npm run deploy
```

Upload the `.wasm` again whenever QEMU is rebuilt. To try the Worker locally,
put the object with `--local` instead of `--remote` and run `npm run dev:cf`
(http://localhost:8787/).

relaynet only issues demo tokens to pages on origins it allows (its
`ALLOWED_ORIGINS`), so a new host needs its origin added there; until then,
visitors paste a token.

## Layout

- `web/index.html`, `web/main.js`: the page, QEMU startup and the serial bridge.
- `web/net.js`: carries the e1000's Ethernet frames to relaynet.
- `web/relaynet.mjs`: relaynet's client (vendored from zephyr-wasm-soc).
- `web/serve.py`: local server with the isolation headers.
- `web/_headers`, `web/.assetsignore`: Cloudflare static asset settings.
- `cloudflare/worker.js`, `wrangler.jsonc`: the Cloudflare Worker.
- `firmware/`: the Zephyr app.
- `Dockerfile`, `patches/`: the QEMU wasm build and its patches.
- `scripts/`: `build.sh` (firmware), `build-qemu-wasm.sh` (QEMU), `dev.sh`
  (build and serve).
- `tests/browser.mjs`: headless Chromium tests.
- `PLAN.md`: how networking was added, step by step, and what was found.
