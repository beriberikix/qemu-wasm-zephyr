#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Boots web/ in headless Chromium and drives the Zephyr shell.
//
//   node tests/browser.mjs                 boot to the shell prompt
//   node tests/browser.mjs --net           also bring up the network and
//                                          check DHCP, DNS, ping and TCP
//
// Serves web/ itself, with the COOP/COEP headers QEMU's threads need.
// --origin serves the page under another origin (Playwright routing), for
// relaynet's demo tokens, which are only issued to allowlisted origins.
// RELAYNET_TOKEN in the environment is used instead of a demo token.
// --url tests a deployed copy (e.g. the Cloudflare Worker) instead of web/.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const NET = flag('--net');
const ORIGIN = option('--origin', null);
const URL_ = option('--url', null);
const TIMEOUT = Number(option('--timeout', NET ? 240 : 120)) * 1000;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
};
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
};

async function serveFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '') || 'index.html';
  if (rel.startsWith('..')) return null;
  try {
    const body = await readFile(join(WEB, rel.endsWith('/') ? rel + 'index.html' : rel));
    return { body, type: TYPES[extname(rel)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const file = await serveFile(new URL(req.url, 'http://x').pathname);
  if (!file) { res.writeHead(404, HEADERS).end(); return; }
  res.writeHead(200, { ...HEADERS, 'Content-Type': file.type }).end(file.body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}/`;
const base = URL_ ?? ORIGIN ?? local;

const browser = await chromium.launch();
const context = await browser.newContext();
if (ORIGIN) {
  // Answer every request under ORIGIN from web/, so the page runs there.
  await context.route(`${ORIGIN}**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(new URL(ORIGIN).pathname.length - 1);
    const file = await serveFile(path);
    if (!file) return route.fulfill({ status: 404, headers: HEADERS });
    return route.fulfill({ status: 200, headers: { ...HEADERS, 'Content-Type': file.type }, body: file.body });
  });
}
const page = await context.newPage();
const consoleLines = [];
const keep = (line) => {
  consoleLines.push(line);
  if (consoleLines.length > 200) consoleLines.shift();
};
page.on('console', (m) => keep(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => keep(`[pageerror] ${e.message}`));
let crashed = false;
page.on('crash', () => { crashed = true; keep('[crash] the page crashed'); });

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1) + ' s';
const deadline = started + TIMEOUT;

/** The terminal's text, line by line (xterm keeps it in its buffer). */
let lastScreen = '';
const screen = async () => {
  if (crashed) throw new Error('the page crashed');
  // Trailing blank rows come and go as output fills the screen; drop them
  // so offsets into the text stay put.
  lastScreen = (await page.evaluate(() => window.__terminalText?.() ?? '')).trimEnd();
  return lastScreen;
};

async function waitFor(pattern, what, since = 0, until = deadline) {
  for (;;) {
    const text = (await screen()).slice(since);
    const m = text.match(pattern);
    if (m) return m;
    if (Date.now() > until) {
      if (until < deadline) return null;
      throw new Error(`timed out waiting for ${what}`);
    }
    await page.waitForTimeout(250);
  }
}

/**
 * Type `line` and wait for `pattern` in what follows. With `retryMs`, type
 * it again if nothing matched by then: a line typed just as the shell starts
 * (while the network logs its first lines) can be lost.
 */
async function command(line, pattern, what, { retryMs } = {}) {
  let since = (await screen()).length;
  await page.evaluate((l) => window.__typeLine(l), line);
  let m = retryMs ? await waitFor(pattern, what, since, Date.now() + retryMs) : null;
  if (retryMs && !m) {
    since = (await screen()).length;
    await page.evaluate((l) => window.__typeLine(l), line);
  }
  m ??= await waitFor(pattern, what, since);
  // The shell ignores what is typed while a command runs: wait for its
  // prompt before the next. Look for it after the command's output, not at
  // the very end: log lines (DHCP, say) can land after the prompt.
  await waitFor(/uart:~\$/, `the prompt after ${line}`, since + m.index + m[0].length);
  return m;
}

let ok = true;
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push(`PASS ${name}${detail ? `: ${detail}` : ''} (${elapsed()})`);
  } catch (e) {
    ok = false;
    results.push(`FAIL ${name}: ${e.message} (${elapsed()})`);
  }
};

const params = new URLSearchParams();
if (NET) params.set('net', 'relaynet');
if (flag('--netdump')) params.set('netdump', '1');
if (process.env.RELAYNET_TOKEN) {
  // As if pasted into the token field (kept in sessionStorage, never the URL).
  await page.addInitScript((t) => sessionStorage.setItem('qemu-wasm-zephyr.relaynet-token', t),
    process.env.RELAYNET_TOKEN);
}
await page.goto(base + (params.size ? `?${params}` : ''));

await check('boot to shell', async () => {
  await waitFor(/uart:~\$/, 'the shell prompt');
  await command('kernel version', /Zephyr version [\d.]+/, 'kernel version', { retryMs: 10000 });
  return (await screen()).match(/Zephyr version [\d.]+/)[0];
});

// --run "cmd; cmd": type each after boot, 5 s apart, and print what follows
// (with the NIC's frame counts). For poking at a problem.
const RUN = option('--run', null);
if (RUN && ok) {
  for (const cmd of RUN.split(';').map((c) => c.trim()).filter(Boolean)) {
    const since = (await screen()).length;
    await page.evaluate((l) => window.__typeLine(l), cmd);
    await page.waitForTimeout(5000);
    const stats = await page.evaluate(() => JSON.stringify(window.__netStats ?? null));
    console.log(`--- ${cmd}  (${elapsed()}, frames ${stats})\n${(await screen()).slice(since)}`);
    if (flag('--netdump')) {
      const size = await page.evaluate(() => { try { return window.__qemu.FS.stat('/net0.pcap').size; } catch (e) { return String(e); } });
      console.log(`    /net0.pcap: ${size} bytes`);
    }
  }
}

if (NET && ok) {
  await check('NIC frames reach JS', async () => {
    for (;;) {
      const stats = await page.evaluate(() => window.__netStats && { ...window.__netStats });
      if (stats?.toRelay > 0) return `${stats.toRelay} frame(s) from the guest, ${stats.toGuest} to it`;
      if (Date.now() > deadline) throw new Error(`no frame from the guest (stats: ${JSON.stringify(stats)})`);
      await page.waitForTimeout(250);
    }
  });
  await check('DHCP lease', async () => {
    const m = await waitFor(/IPv4 address: (\d+\.\d+\.\d+\.\d+)/, 'a DHCP lease');
    return m[1];
  });
  await check('DNS', async () => {
    const m = await command('net dns example.com', /example\.com.*?(\d+\.\d+\.\d+\.\d+)/s, 'a DNS answer');
    return `example.com -> ${m[1]}`;
  });
  // relaynet answers ICMP from its gateway but does not carry it to the
  // internet (observed: pings to 1.1.1.1 and 8.8.8.8 time out while TCP to
  // the same hosts connects), so: ping the gateway, and TCP to the internet.
  await check('ping the gateway', async () => {
    const m = await command('net ping -c 3 10.0.2.2', /(\d+) bytes from 10\.0\.2\.2/, 'a ping reply');
    return `${m[1]}-byte reply from 10.0.2.2`;
  });
  await check('TCP to the internet', async () => {
    await command('net tcp connect 1.1.1.1 80', /TCP connected/, 'a TCP connection to 1.1.1.1:80');
    await command('net tcp close', /Connection closed|Not connected/, 'the close');
    return 'connected to 1.1.1.1:80';
  });

}

// --pcap-out FILE (with --netdump): save what the netdev saw.
const PCAP_OUT = option('--pcap-out', null);
if (PCAP_OUT && !crashed) {
  const bytes = await page.evaluate(() => {
    try { return Array.from(window.__qemu.FS.readFile('/net0.pcap')); } catch { return null; }
  });
  if (bytes) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(PCAP_OUT, Buffer.from(bytes));
    console.log(`saved ${bytes.length} bytes of capture to ${PCAP_OUT}`);
  }
}

console.log(results.join('\n'));
if (!ok || flag('--verbose')) {
  const text = await screen().catch(() => lastScreen);
  console.log('\n--- terminal ---\n' + text.split('\n').slice(-60).join('\n'));
  console.log('\n--- console (last 40) ---\n' + consoleLines.slice(-40).join('\n'));
}
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
