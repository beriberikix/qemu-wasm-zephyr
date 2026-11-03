# Plan: networking through relaynet

Goal: the Zephyr guest in the browser gets a real network. QEMU's emulated
e1000 NIC sends Ethernet frames to JavaScript, which carries them over a
WebSocket to relaynet (https://relaynet.network). relaynet answers DHCP and
DNS and NATs the guest's traffic to the internet.

```
Zephyr (e1000 driver, DHCPv4, DNS)
  -> QEMU e1000 -> -netdev socket (length-prefixed frames over a "TCP" socket)
  -> Emscripten SOCKFS -> WebSocket shim in web/net.js
  -> relaynet client helper (relay.v1, token subprotocol)
  -> wss://relay.relaynet.network/
```

The shim is the trick: Emscripten implements `connect()` with a WebSocket,
so `-netdev socket,connect=...` hands its byte stream to JavaScript with no
QEMU patch. QEMU's socket netdev frames each packet with a 4-byte big-endian
length; the shim strips and adds that framing. If SOCKFS proves unusable
under QEMU's threads, the fallback is a small QEMU net backend that calls
into JavaScript (EM_JS), carried as a patch in the Docker build.

Token: the person's own relaynet token if they paste one (kept in
sessionStorage), otherwise a 15-minute demo token from relaynet's
`/api/anon/token`, as zephyr-wasm-soc does.

## Steps

- [x] 1. Baseline: build QEMU wasm (Docker) and the firmware; a headless
      Chromium test (`tests/browser.mjs`) boots to `uart:~$`.
- [x] 2. Frames reach JS: add an e1000 + socket netdev, a shim that logs
      frames; the test sees the guest's first frame (any Ethernet frame).
- [x] 3. Firmware networking: e1000, IPv4, DHCPv4, DNS resolver, net shell
      (`net iface`, `net ping`, `net dns`). Builds and still boots.
- [x] 4. relaynet client in web/: vendored helper, Network button + optional
      token field, demo token fallback, status line.
- [x] 5. End to end in headless Chromium: DHCP lease, `net dns` resolves a
      name, `net ping` to the gateway gets replies, TCP to the internet
      connects (relaynet does not forward ICMP to the internet).
- [x] 6. Docs and hosting: README networking section, COOP/COEP note for
      GitHub Pages, build script updates.

## Log

### Step 1: baseline (done)

The repo had never booted with the current upstream toolchain: QEMU's
emsdk-wasm64-cross image ships Emscripten 5.0.2, and QEMU's main loop dies
in it. Three fixes, all in the Docker build:

- QEMU's main loop used `ppoll()`, which Emscripten links but cannot run
  ("unsupported syscall: __syscall_ppoll", thousands a second, until the tab
  died).
- `poll()`, its replacement, proxied from QEMU's thread to the browser's
  main thread, always returns a Promise there, which with `-sASYNCIFY`
  aborts: "import _emscripten_receive_on_main_thread_js was not in
  ASYNCIFY_IMPORTS, but changed the state". Upstream issue, open:
  https://github.com/emscripten-core/emscripten/issues/27291. Adding the
  import to ASYNCIFY_IMPORTS only changes the error ("rtn.then is not a
  function"). The Dockerfile makes Emscripten's poll() answer synchronously.
- So QEMU must never ask poll() to wait:
  `patches/0001-util-poll-without-waiting-on-emscripten.patch` polls with
  no timeout and sleeps on QEMU's own thread, in steps of up to 1 ms.

Also: QEMU pinned (812798d); `--enable-debug` dropped (an -O0 TCG
interpreter is very slow); repeated stderr lines are printed once.

Result: `node tests/browser.mjs` boots to `uart:~$` and answers
`kernel version` (Zephyr 4.3.0) in about 3 s.

### Step 2: frames reach JS (done)

`-netdev socket,connect=127.0.0.1:5555` plus `-device e1000` works with no
QEMU change: Emscripten's SOCKFS opens a WebSocket for the connection, and
web/net.js answers for that URL (Module.websocket.url) with a stand-in.

- The e1000's option ROM (`efi-e1000.rom`) is not shipped; `romfile=` turns
  it off (Zephyr does not need it).
- SOCKFS compares `socket.readyState` with `socket.OPEN` on the instance, as
  a real WebSocket has it. The stand-in had the constants only as statics,
  so SOCKFS took it for still connecting and queued every write forever
  while reporting success. Found with `?netdump` (QEMU filter-dump to
  /net0.pcap, which showed frames reaching the netdev) and byte counters.

Debugging aids kept: `tests/browser.mjs --run "cmd; cmd"` and `--netdump`.

### Steps 3-5: firmware, relaynet client, end to end (done)

- Firmware: e1000, IPv4, DHCPv4 (first discover within 2 s, the Kconfig
  minimum), DNS resolver, TCP, net shell; main.c starts DHCP and prints
  `IPv4 address: ...` when it binds.
- relaynet answered every discover with an offer, and Zephyr never saw one:
  its devicetree wires the e1000 to IRQ 11, true for PCI slot 2, where it
  sits in Zephyr's own QEMU setup (behind the VGA card). With `-vga none`
  it landed in slot 1, on another line. `addr=2` fixes it.
- The networked firmware faults at boot with no e1000, so the page always
  adds one; with networking off it is unconnected.
- relaynet's docs: "ping 8.8.8.8 is expected to fail (ICMP is not
  forwarded)". The test pings the gateway (10.0.2.2) and opens TCP to
  1.1.1.1:80 instead.

Results (`npm test`, `npm run test:net`):

| Run | Result |
|---|---|
| No network | shell in 3.0 s |
| Beta token (RELAYNET_TOKEN) | lease 3.7 s, DNS 4.0 s, gateway ping 6.3 s, TCP 6.8 s |
| Demo token, page at beriberikix.github.io/qemu-wasm-zephyr/ | lease 4.9 s, DNS 5.2 s, gateway ping 7.4 s, TCP 7.9 s |

Demo tokens are only issued to origins relaynet allows, so on localhost the
page needs a pasted token (or `--origin https://beriberikix.github.io/qemu-wasm-zephyr/`
in the test).

### Step 6: docs (done)

README: Networking (how it works, token, ICMP, PCI slot), Tests, Hosting
(cross-origin isolation; GitHub Pages needs a service worker, not included),
the Docker build's patches and why. `scripts/build-qemu-wasm.sh --native`
applies `patches/` too and warns that Emscripten's poll() is not patched.

Not done (needs a decision): a GitHub Pages deployment. It needs a
cross-origin-isolation service worker and the 45 MB .wasm published
somewhere (Pages, or a release asset).
