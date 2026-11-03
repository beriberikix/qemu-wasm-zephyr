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
      Chromium test (`tests/boot.mjs`) boots to `uart:~$`.
- [ ] 2. Frames reach JS: add an e1000 + socket netdev, a shim that logs
      frames; the test sees the guest's first frame (any Ethernet frame).
- [ ] 3. Firmware networking: e1000, IPv4, DHCPv4, DNS resolver, net shell
      (`net iface`, `net ping`, `net dns`). Builds and still boots.
- [ ] 4. relaynet client in web/: vendored helper, Network button + optional
      token field, demo token fallback, status line.
- [ ] 5. End to end in headless Chromium: DHCP lease, `net dns` resolves a
      name, `net ping` gets replies.
- [ ] 6. Docs and hosting: README networking section, COOP/COEP note for
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
