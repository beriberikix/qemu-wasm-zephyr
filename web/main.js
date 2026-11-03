/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Web frontend that loads QEMU (compiled to WebAssembly via Emscripten)
 * and wires serial I/O to xterm.js for two-way interaction with the
 * Zephyr shell.
 */

const term = new Terminal({
  disableStdin: false,
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  theme: {
    background: '#1a1a2e',
    foreground: '#e0e0e0',
    cursor: '#e94560',
  },
  convertEol: false,
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit();
term.focus();
window.addEventListener('resize', () => fitAddon.fit());
document.getElementById('terminal-container').addEventListener('click', () => term.focus());

const statusEl = document.getElementById('status');

function setStatus(text, ready = false) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (ready ? ' ready' : '');
}

const inputBuffer = [];

term.onData((data) => {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    // Zephyr shell over serial expects LF for Enter in this setup.
    inputBuffer.push(code === 13 ? 10 : code);
  }
});

// Hooks for tests/browser.mjs: the terminal's text, and typing a line.
window.__terminalText = () => {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
};
window.__typeLine = (line) => {
  for (const ch of line) inputBuffer.push(ch.charCodeAt(0));
  inputBuffer.push(10);
};

function readInputByte() {
  if (inputBuffer.length > 0) {
    return inputBuffer.shift();
  }
  return undefined;
}

let outputChunks = '';
let flushScheduled = false;

function enqueueByte(val) {
  outputChunks += String.fromCharCode(val);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(() => {
      term.write(outputChunks);
      outputChunks = '';
      flushScheduled = false;
    }, 0);
  }
}

/*
 * Networking. Off unless asked for (?net=relaynet, or the header button):
 * then the guest's e1000 is carried to relaynet by net.js. The token is the
 * person's own if they pasted one (kept in this tab only), otherwise a
 * 15-minute demo token.
 */
const TOKEN_KEY = 'qemu-wasm-zephyr.relaynet-token';
const params = new URLSearchParams(location.search);
const netEnabled = params.get('net') === 'relaynet';
const netButton = document.getElementById('net-toggle');
const tokenInput = document.getElementById('net-token');
try { tokenInput.value = sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* none */ }
tokenInput.hidden = !netEnabled;
netButton.textContent = netEnabled ? 'Network: relaynet (restart without)' : 'Real network (relaynet)';
netButton.addEventListener('click', () => {
  const next = new URL(location.href);
  if (netEnabled) next.searchParams.delete('net');
  else next.searchParams.set('net', 'relaynet');
  location.href = next.href;
});
tokenInput.addEventListener('change', () => {
  try { sessionStorage.setItem(TOKEN_KEY, tokenInput.value.trim()); } catch { /* forget */ }
});

const netLog = (text) => term.writeln(`\x1b[36m[net] ${text}\x1b[0m`);

async function setUpNetwork() {
  const none = { qemuArgs: ['-nic', 'none'], moduleOptions: {} };
  if (!netEnabled) return none;
  const { startRelayLink, demoToken } = await import('./net.js');
  let token = tokenInput.value.trim();
  if (token) {
    netLog('Using your relaynet token.');
  } else {
    netLog('Asking relaynet for a demo token (15 minutes)...');
    const got = await demoToken();
    if (!got.token) {
      netLog(`${got.message} Starting without a network.`);
      return none;
    }
    token = got.token;
  }
  const link = startRelayLink({ token, onStatus: netLog });
  window.__netStats = link.stats;
  netLog(`Guest NIC: e1000, MAC ${link.mac}. Waiting for DHCP...`);
  return link;
}

setStatus('Loading firmware...');
term.writeln('\x1b[33m[host] Loading Zephyr firmware...\x1b[0m');

let firmwareData;
let biosData;
let kvmvapicData;
let multibootDmaData;
try {
  const resp = await fetch('zephyr.elf');
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  firmwareData = new Uint8Array(await resp.arrayBuffer());
  term.writeln(`\x1b[32m[host] Firmware loaded (${firmwareData.length} bytes)\x1b[0m`);
} catch (err) {
  setStatus('Firmware not found');
  term.writeln(`\x1b[31m[host] Failed to load firmware: ${err.message}\x1b[0m`);
  term.writeln('[host] Place zephyr.elf in the web/ directory.');
  throw err;
}

try {
  const resp = await fetch('bios-256k.bin');
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  biosData = new Uint8Array(await resp.arrayBuffer());
  term.writeln(`\x1b[32m[host] BIOS loaded (${biosData.length} bytes)\x1b[0m`);
} catch (err) {
  setStatus('BIOS not found');
  term.writeln(`\x1b[31m[host] Failed to load BIOS: ${err.message}\x1b[0m`);
  term.writeln('[host] Place bios-256k.bin in the web/ directory.');
  throw err;
}

try {
  const resp = await fetch('kvmvapic.bin');
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  kvmvapicData = new Uint8Array(await resp.arrayBuffer());
  term.writeln(`\x1b[32m[host] kvmvapic ROM loaded (${kvmvapicData.length} bytes)\x1b[0m`);
} catch (err) {
  setStatus('ROM not found');
  term.writeln(`\x1b[31m[host] Failed to load kvmvapic.bin: ${err.message}\x1b[0m`);
  throw err;
}

try {
  const resp = await fetch('multiboot_dma.bin');
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  multibootDmaData = new Uint8Array(await resp.arrayBuffer());
  term.writeln(`\x1b[32m[host] multiboot_dma ROM loaded (${multibootDmaData.length} bytes)\x1b[0m`);
} catch (err) {
  setStatus('ROM not found');
  term.writeln(`\x1b[31m[host] Failed to load multiboot_dma.bin: ${err.message}\x1b[0m`);
  throw err;
}

setStatus('Starting QEMU...');
term.writeln('\x1b[33m[host] Starting QEMU (this may take a moment)...\x1b[0m');

const requiredRuntimeFiles = [
  'qemu-system-i386.js',
  'qemu-system-i386.wasm',
  'bios-256k.bin',
  'kvmvapic.bin',
  'multiboot_dma.bin',
];

const optionalRuntimeFiles = [
  'qemu-system-i386.worker.js',
];

async function fileExists(path) {
  const resp = await fetch(path, { method: 'HEAD', cache: 'no-store' });
  return resp.ok;
}

try {
  const missingRuntimeFiles = [];
  for (const runtimeFile of requiredRuntimeFiles) {
    if (!(await fileExists(runtimeFile))) {
      missingRuntimeFiles.push(runtimeFile);
    }
  }

  if (missingRuntimeFiles.length > 0) {
    setStatus('QEMU runtime files missing');
    term.writeln('\x1b[31m[host] Missing required QEMU runtime files:\x1b[0m');
    for (const runtimeFile of missingRuntimeFiles) {
      term.writeln(`  - ${runtimeFile}`);
    }
    term.writeln('[host] Copy them into the web/ directory, for example:');
    term.writeln('       ./scripts/build.sh --skip-firmware --qemu-build-dir /path/to/qemu/build-wasm');
    term.writeln(`       (current origin: ${window.location.origin})`);
    throw new Error('Missing QEMU runtime artifacts in web/');
  }

  const missingOptionalRuntimeFiles = [];
  for (const runtimeFile of optionalRuntimeFiles) {
    if (!(await fileExists(runtimeFile))) {
      missingOptionalRuntimeFiles.push(runtimeFile);
    }
  }
  if (missingOptionalRuntimeFiles.length > 0) {
    term.writeln('\x1b[33m[host] Optional runtime files not found (continuing):\x1b[0m');
    for (const runtimeFile of missingOptionalRuntimeFiles) {
      term.writeln(`  - ${runtimeFile}`);
    }
  }

  const network = await setUpNetwork();
  const seenStderr = new Set();

  const { default: createQemu } = await import('./qemu-system-i386.js');

  window.__qemu = await createQemu({
    ...network.moduleOptions,
    stdin: readInputByte,
    arguments: [
      '-machine', 'q35,acpi=off',
      '-cpu', 'qemu32,+nx,+pae',
      '-m', '32',
      ...network.qemuArgs,
      '-nographic',
      '-vga', 'none',
      '-chardev', 'stdio,id=char0,signal=off',
      '-serial', 'chardev:char0',
      '-monitor', 'none',
      '-device', 'isa-debug-exit,iobase=0xf4,iosize=0x04',
      '-bios', '/bios-256k.bin',
      '-kernel', '/zephyr.elf',
      '-no-reboot',
    ],

    preRun: [
      (mod) => {
        mod.FS.writeFile('/zephyr.elf', firmwareData);
        mod.FS.writeFile('/bios-256k.bin', biosData);
        mod.FS.writeFile('/kvmvapic.bin', kvmvapicData);
        mod.FS.writeFile('/multiboot_dma.bin', multibootDmaData);

        mod.TTY.default_tty_ops.put_char = (_tty, val) => {
          if (val !== 0) {
            enqueueByte(val);
          }
        };

        mod.TTY.default_tty_ops.get_char = (_tty) => {
          return readInputByte();
        };
      }
    ],

    print: (text) => {
      if (text) {
        term.writeln(text);
      }
    },
    printErr: (text) => {
      // Say each distinct line once: a warning from QEMU's main loop can
      // repeat thousands of times a second.
      if (text && !seenStderr.has(text)) {
        seenStderr.add(text);
        console.warn('[qemu stderr]', text);
      }
    },
  });

  setStatus('Running', true);
} catch (err) {
  setStatus('QEMU failed to start');
  term.writeln(`\x1b[31m[host] QEMU error: ${err.message}\x1b[0m`);
  term.writeln('[host] Ensure qemu-system-i386.js/.wasm and ROM files (bios-256k.bin, kvmvapic.bin, multiboot_dma.bin) are in web/.');
  console.error(err);
}
