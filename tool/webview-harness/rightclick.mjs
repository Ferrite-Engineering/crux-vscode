#!/usr/bin/env node
// Secondary click inside an emulated VS Code webview host.
//
// Boots the staged NetCrux viewer (packages/netcrux/media/netcrux-web) in
// headless Chrome the way a VS Code custom editor hosts it: the document and its
// files come from two origins, the document is the extension's real
// `renderPreviewHtml` output with its real CSP and shim, `acquireVsCodeApi` is
// faked, and the host side of the protocol is played by this script. On top of
// that it installs the one piece of VS Code's webview machinery that decides
// what a right-click does: the `contextmenu` listener of VS Code's webview host
// page (workbench/contrib/webview/browser/pre/index.html). That listener
// swallows the event, unless the page already called `preventDefault()`, and
// asks the workbench to show its own menu. On macOS the workbench shows it as a
// native menu, which runs a modal loop that takes the button release; this
// script models that by withholding `mouseReleased` whenever the host's listener
// fired.
//
// It then right-clicks a cell and asserts that the viewer's own context menu
// (the item "Go to Source in Editor") opens.
//
// Needs a staged payload (`pnpm --filter netcrux run build:web`) and Chrome.
// It is not part of `pnpm test`: CI installs neither Flutter nor a browser.
// `packages/netcrux/test/preview/contextmenu.test.ts` is the CI half.
//
// usage: node tool/webview-harness/rightclick.mjs [--screenshot out.png]
//   CRUX_HARNESS_CHROME   path to the Chrome binary
//   CRUX_HARNESS_WAIT_MS  how long to wait for the viewer to load (default 60000)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const media = process.env.CRUX_HARNESS_MEDIA ?? path.join(repoRoot, 'packages/netcrux/media/netcrux-web');
// A copy of the NetCrux repository's test/fixtures/netlist/design_seed netlist: three
// modules, a register named dma_reg at the top. The harness right-clicks that register.
const fixturePath = path.join(repoRoot, 'tool/webview-harness/fixture.netlist.json');
const waitMs = Number(process.env.CRUX_HARNESS_WAIT_MS ?? 60000);
const screenshotAt = process.argv.includes('--screenshot')
  ? process.argv[process.argv.indexOf('--screenshot') + 1]
  : undefined;

const CHROME_CANDIDATES = [
  process.env.CRUX_HARNESS_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('no Chrome found; set CRUX_HARNESS_CHROME');
  process.exit(2);
}
if (!existsSync(path.join(media, 'main.dart.js'))) {
  console.error(`no staged payload at ${media}; run: pnpm --filter netcrux run build:web`);
  process.exit(2);
}

// html.ts, compiled on the fly so the harness runs the real shim.
const bundled = await build({
  entryPoints: [path.join(repoRoot, 'packages/netcrux/src/preview/html.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const htmlModule = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
const { renderPreviewHtml, createNonce } = await import(htmlModule);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
const [docPort, resPort, debugPort] = [await freePort(), await freePort(), await freePort()];

const nonce = createNonce();
const netlistText = readFileSync(fixturePath, 'utf8');
const buildConfigJson = JSON.stringify(JSON.parse(readFileSync(path.join(media, 'flutter-build-config.json'), 'utf8')));
const resBase = `http://localhost:${resPort}`;

// Runs before the extension's own shim: the fake handle, the host side of the
// netlist hand-off, the theme, and VS Code's webview-host listeners.
const hostScript = `
  (function () {
    var fixture = ${JSON.stringify(netlistText)};
    var sent = false;
    window.__hostMessages = [];
    window.__vscodeContextMenus = 0;
    window.acquireVsCodeApi = function () {
      return { postMessage: function (m) {
        window.__hostMessages.push(m);
        console.debug('HOSTMSG ' + JSON.stringify(m).slice(0, 600));
        var isReady = m && m.type === 'crux.netcrux' && m.kind === 'ready';
        var isFirst = m && m.type === 'crux.webview.diagnostic' && m.kind === 'first-frame';
        if ((isReady || isFirst) && !sent) {
          sent = true;
          setTimeout(function () {
            window.dispatchEvent(new MessageEvent('message', {
              origin: 'vscode-webview://harness',
              data: { type: 'crux.netcrux', protocol: 1, kind: 'open_netlist', name: 'fixture.json', text: fixture }
            }));
          }, 50);
        }
      } };
    };
    // VS Code's webview host page, verbatim in behaviour: a bubbling
    // 'contextmenu' listener on the content window that backs off when the page
    // already handled the event and otherwise takes it over.
    if (${JSON.stringify(!process.argv.includes('--no-host-listener'))}) {
      window.addEventListener('contextmenu', function (e) {
        if (e.defaultPrevented) return;
        e.preventDefault();
        window.__vscodeContextMenus += 1;
      });
    }
    document.addEventListener('DOMContentLoaded', function () {
      document.body.dataset.vscodeThemeKind = 'vscode-dark';
    });
    document.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e');
    document.documentElement.style.setProperty('--vscode-editor-foreground', '#cccccc');
  })();
`;
let html = renderPreviewHtml({
  baseUri: resBase,
  buildConfigJson,
  cspSource: resBase,
  nonce,
  title: 'NetCrux',
  loadingLabel: 'Loading the schematic viewer',
});
html = html.replace('<script nonce="' + nonce + '">', '<script nonce="' + nonce + '">' + hostScript + '</script><script nonce="' + nonce + '">');

const mime = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.otf': 'font/otf', '.ttf': 'font/ttf', '.bin': 'application/octet-stream' };
const docServer = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(html);
}).listen(docPort);
const resServer = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, resBase).pathname);
  const file = path.join(media, rel);
  res.setHeader('access-control-allow-origin', '*');
  if (!file.startsWith(media) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end('nope');
    return;
  }
  res.setHeader('content-type', mime[path.extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(resPort);

// Chrome, headless, driven over the DevTools protocol.
const profile = mkdtempSync(path.join(tmpdir(), 'crux-rightclick-'));
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--window-size=1400,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' });

function shutdown(code) {
  chrome.kill();
  docServer.close();
  resServer.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

let target;
for (let i = 0; i < 100 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try { target = (await (await fetch(`http://localhost:${debugPort}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) { console.error('chrome did not start'); shutdown(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map();
const log = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    log.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    // The page's own error listener sees only "Script error." for a script from
    // another origin; the protocol sees the thrown object itself.
    const details = msg.params.exceptionDetails;
    const entry = {
      text: '[exception] ' + (details.stackTrace?.callFrames ?? []).map((f) => `${f.functionName}:${f.lineNumber}`).join(' < '),
      toString() { return this.text; },
    };
    log.push(entry);
    const objectId = details.exception?.objectId;
    if (objectId) {
      send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return String(this) + " | " + String(this && this.stack).slice(0, 1500); }',
        returnByValue: true,
      }).then((reply) => { entry.text += ' ' + (reply.result?.result?.value ?? ''); });
    }
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://localhost:${docPort}/` });

const started = Date.now();
let loaded = false;
while (Date.now() - started < waitMs) {
  await sleep(500);
  if (log.some((l) => String(l).includes('"phase":"loaded"'))) { loaded = true; break; }
}
if (!loaded) {
  for (const line of log.slice(-20)) console.error(String(line).slice(0, 400));
  console.error('FAIL the viewer did not report the netlist loaded');
  shutdown(1);
}
await sleep(3000);

// Semantics make the canvas's widgets visible to the page as DOM, which is how
// a menu opening is observed from outside.
await evaluate(`(function () {
  var find = function (root) {
    var hit = root.querySelector('flt-semantics-placeholder');
    if (hit) return hit;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) { var inner = find(all[i].shadowRoot); if (inner) return inner; }
    }
    return null;
  };
  var placeholder = find(document);
  if (placeholder) placeholder.click();
  return !!placeholder;
})()`);
await sleep(1500);

const hasMenu = () => evaluate(`(function () {
  var walk = function (root) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var label = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
      if (label.indexOf('Go to Source in Editor') >= 0) return true;
      if (el.shadowRoot && walk(el.shadowRoot)) return true;
    }
    return false;
  };
  return walk(document);
})()`);

if (screenshotAt) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshotAt, Buffer.from(shot.result.data, 'base64'));
}

async function click(x, y, button) {
  const base = { x, y, button, clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const before = await evaluate('window.__vscodeContextMenus');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: button === 'right' ? 2 : 1 });
  await sleep(50);
  const hostTookIt = (await evaluate('window.__vscodeContextMenus')) > before;
  // A native menu run by the workbench takes the release with it.
  if (!(button === 'right' && hostTookIt)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }
  await sleep(1000);
  return hostTookIt;
}

console.log(JSON.stringify({ probe: 'hasMenuBefore', value: await hasMenu() }));
// The dma_reg cell of the fixture, at the viewer's default fit.
const point = JSON.parse(process.env.CRUX_HARNESS_POINT ?? '[985, 500]');
const tookIt = await click(point[0], point[1], 'right');
const menu = await hasMenu();
if (screenshotAt) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshotAt.replace(/\.png$/, '-after.png'), Buffer.from(shot.result.data, 'base64'));
}
console.log(JSON.stringify({ probe: 'afterRightClick', vscodeMenuRequested: tookIt, viewerMenuOpen: menu }));
for (const line of log.filter((l) => /exception|error/i.test(String(l))).slice(0, 5)) console.log(String(line).slice(0, 1500));
if (menu && !tookIt) {
  console.log('PASS the viewer opened its own context menu and the host did not take the click');
  shutdown(0);
}
console.error(`FAIL no viewer context menu after a right-click (the host's own menu was requested: ${tookIt})`);
shutdown(1);
