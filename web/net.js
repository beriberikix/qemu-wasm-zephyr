/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The guest's Ethernet, carried to relaynet.
 *
 * QEMU runs with `-netdev socket,connect=...`: its e1000's frames go out
 * over a TCP connection, each prefixed with its length (4 bytes, big
 * endian). Compiled with Emscripten, that connection is a WebSocket
 * (SOCKFS). This file stands in for the WebSocket QEMU opens, so the byte
 * stream never leaves the page: it splits it into frames, sends them to
 * relaynet, and frames relaynet's replies the same way back.
 *
 *   e1000 -> netdev socket -> SOCKFS -> NetdevSocket (here) -> relaynet
 *
 * relaynet (https://relaynet.network) answers DHCP and DNS on its network
 * and NATs the guest to the internet.
 */

import { connectRelay, RELAY_URL } from './relaynet.mjs';

/** The URL QEMU's socket netdev is pointed at (Module.websocket.url). */
export const NETDEV_URL = 'ws://qemu-netdev.invalid/';

export { RELAY_URL };

const RealWebSocket = globalThis.WebSocket;

/**
 * A WebSocket look-alike for SOCKFS: what QEMU writes arrives in send(),
 * and deliver() hands QEMU a frame.
 */
class NetdevSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  // A real WebSocket has these on instances too, and SOCKFS reads them there
  // (socket.readyState !== socket.OPEN): without them it takes the socket
  // for one still connecting and queues every write forever.
  get CONNECTING() { return 0; }
  get OPEN() { return 1; }
  get CLOSING() { return 2; }
  get CLOSED() { return 3; }

  constructor(url, link) {
    super();
    this.url = url;
    this.protocol = 'binary';
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.extensions = '';
    this.readyState = NetdevSocket.CONNECTING;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.link = link;
    this.pending = new Uint8Array(0);
    queueMicrotask(() => {
      this.readyState = NetdevSocket.OPEN;
      this.#emit('open', new Event('open'));
      link.attach(this);
    });
  }

  #emit(type, event) {
    this[`on${type}`]?.(event);
    this.dispatchEvent(event);
  }

  send(data) {
    this.link.stats.bytesFromQemu += data.byteLength ?? data.length ?? 0;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new TextEncoder().encode(String(data));
    const all = new Uint8Array(this.pending.length + bytes.length);
    all.set(this.pending);
    all.set(bytes, this.pending.length);
    let at = 0;
    while (all.length - at >= 4) {
      const len = new DataView(all.buffer, at, 4).getUint32(0);
      if (all.length - at - 4 < len) break;
      this.link.fromGuest(all.slice(at + 4, at + 4 + len));
      at += 4 + len;
    }
    this.pending = all.slice(at);
  }

  /** One frame to the guest, length-prefixed as QEMU expects. */
  deliver(frame) {
    if (this.readyState !== NetdevSocket.OPEN) return;
    const msg = new Uint8Array(4 + frame.length);
    new DataView(msg.buffer).setUint32(0, frame.length);
    msg.set(frame, 4);
    const event = new MessageEvent('message', {
      data: this.binaryType === 'arraybuffer' ? msg.buffer : new Blob([msg]),
    });
    this.#emit('message', event);
  }

  close() {
    if (this.readyState === NetdevSocket.CLOSED) return;
    this.readyState = NetdevSocket.CLOSED;
    this.link.detach(this);
    this.#emit('close', new CloseEvent('close', { code: 1000, wasClean: true }));
  }
}

/**
 * Route QEMU's netdev WebSocket to `link`; every other WebSocket is the
 * browser's own.
 */
function interceptNetdevSocket(link) {
  const Patched = function WebSocket(url, protocols) {
    if (String(url).startsWith(NETDEV_URL)) return new NetdevSocket(String(url), link);
    return new RealWebSocket(url, protocols);
  };
  Object.assign(Patched, {
    CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
  });
  Patched.prototype = RealWebSocket.prototype;
  globalThis.WebSocket = Patched;
}

/**
 * Ask relaynet for a demo token: 15 minutes, one session. Only pages on
 * origins relaynet allows can get one.
 */
export async function demoToken(url = RELAY_URL) {
  const http = new URL(url);
  http.protocol = http.protocol === 'ws:' ? 'http:' : 'https:';
  try {
    const res = await fetch(`${http.origin}/api/anon/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.token) return { token: body.token };
    if (body.error === 'free-tier-paused') return { message: `relaynet's free tier is paused until ${body.pausedUntil}.` };
    if (body.error === 'relay-full') return { message: 'The relay is full. Try again in a few minutes.' };
    if (body.error === 'anon-token-rate-limited') return { message: 'Too many demo tokens from this network. Try again later.' };
    return { message: `relaynet refused a demo token (${body.error ?? res.status}).` };
  } catch {
    return { message: 'Could not reach relaynet for a demo token (is this page on an origin it allows?).' };
  }
}

/**
 * Bridge the guest's NIC to relaynet. Call before QEMU starts; returns the
 * QEMU arguments and Module options that point its netdev here.
 *
 * @param token      relaynet API token (a demo token is fine)
 * @param onStatus   called with a line of text for the console
 * @param url        the relay; relaynet's by default
 */
export function startRelayLink({ token, onStatus = () => {}, url = RELAY_URL }) {
  let guest = null;
  let relay = null;
  const stats = { toRelay: 0, toGuest: 0, sockets: 0, bytesFromQemu: 0 };

  const link = {
    stats,
    attach(socket) {
      stats.sockets++;
      guest = socket;
      onStatus(`NIC connected; linking to ${url}`);
      relay ??= connectRelay({
        token,
        url,
        WebSocket: RealWebSocket,
        onFrame: (frame) => {
          stats.toGuest++;
          guest?.deliver(frame);
        },
        onOpen: ({ reconnect }) => onStatus(reconnect
          ? 'relay session restored (the guest keeps its address if DHCP renews within 60 s)'
          : 'relay session open'),
        onClose: ({ code, reason, final, retryInMs }) => {
          const why = reason ? `${reason} (${code})` : `code ${code}`;
          onStatus(final
            ? `relay ended the session: ${why}`
            : `relay dropped the session: ${why}; retrying in ${Math.round((retryInMs ?? 0) / 1000)} s`);
        },
      });
    },
    detach(socket) {
      if (guest === socket) guest = null;
    },
    fromGuest(frame) {
      stats.toRelay++;
      relay?.send(frame);
    },
  };
  interceptNetdevSocket(link);

  // A random, locally administered MAC: relaynet leases addresses by MAC.
  const mac = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b, i) =>
    (i === 0 ? (b & 0xfe) | 0x02 : b).toString(16).padStart(2, '0')).join(':');
  stats.mac = mac;

  return {
    stats,
    mac,
    qemuArgs: [
      '-netdev', 'socket,id=net0,connect=127.0.0.1:5555',
      '-device', `e1000,netdev=net0,mac=${mac},romfile=,addr=2`,
      ...(new URLSearchParams(location.search).has('netdump')
        ? ['-object', 'filter-dump,id=dump0,netdev=net0,file=/net0.pcap'] : []),
    ],
    moduleOptions: { websocket: { url: NETDEV_URL, subprotocol: 'binary' } },
    close() { relay?.close(); relay = null; },
  };
}
