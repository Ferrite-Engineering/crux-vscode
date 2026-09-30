import { cxp } from '@crux-vscode/host-core';
import { describe, expect, it } from 'vitest';
import { CXP_FRAME_TYPE, HOST_PEER_ID } from '../src/webview/open-waveform';
import {
  DIAGNOSTIC_MESSAGE_TYPE,
  EDITOR_HOST_KIND,
  EDITOR_HOST_MARKER_GLOBAL,
  EDITOR_HOST_THEME_COLOR_IDS,
  FLUTTER_FONT_ORIGIN,
  HOST_BRIDGE_SEAM_GLOBAL,
  THEME_TOKENS_KIND,
  buildContentSecurityPolicy,
  createNonce,
  renderWebviewHtml,
  vscodeCssVarName,
} from '../src/webview/html';

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';
const BASE_URI = `${CSP_SOURCE}/Users/x/ext/media/wavecrux-web`;
const BUILD_CONFIG = '{"engineRevision":"abc","builds":[{"renderer":"canvaskit"}]}';

function render(overrides: Partial<Parameters<typeof renderWebviewHtml>[0]> = {}): string {
  return renderWebviewHtml({
    baseUri: BASE_URI,
    buildConfigJson: BUILD_CONFIG,
    cspSource: CSP_SOURCE,
    nonce: 'TESTNONCE',
    title: 'WaveCrux',
    loadingLabel: 'Loading WaveCrux…',
    ...overrides,
  });
}

describe('content security policy', () => {
  const csp = buildContentSecurityPolicy(CSP_SOURCE, 'N0NCE');

  it('denies everything by default', () => {
    expect(csp.startsWith(`default-src 'none'`)).toBe(true);
  });

  it("permits 'wasm-unsafe-eval' — CanvasKit, wellen, and lxt2fst all compile WASM", () => {
    expect(csp).toContain(`'wasm-unsafe-eval'`);
  });

  it('permits the webview resource origin for scripts as well as the nonce', () => {
    // Flutter's loader injects <script> tags for main.dart.js and
    // canvaskit.js without a nonce, so a nonce-only script-src would render
    // a blank panel.
    expect(csp).toContain(`script-src ${CSP_SOURCE} 'nonce-N0NCE' 'wasm-unsafe-eval'`);
  });

  it("forbids a <base> tag outright — repointing document.baseURI is what broke history.replaceState", () => {
    expect(csp).toContain(`base-uri 'none'`);
  });

  it('allows inline styles, which Flutter injects and offers no way to nonce', () => {
    expect(csp).toContain(`style-src ${CSP_SOURCE} 'unsafe-inline'`);
  });

  it('allows fetch of the wasm binaries and asset manifest', () => {
    expect(csp).toContain(`connect-src ${CSP_SOURCE} ${FLUTTER_FONT_ORIGIN} data: blob:`);
  });

  it('never allows the CanvasKit CDN — that is what --no-web-resources-cdn bought', () => {
    expect(csp).not.toContain('gstatic.com/flutter-canvaskit');
    expect(csp).not.toContain('https://www.gstatic.com');
  });

  it('allows exactly one external origin, and only for the text font', () => {
    const externals = new Set(
      [...csp.matchAll(/https:\/\/[^\s;]+/g)]
        .map((match) => match[0])
        .filter((origin) => !origin.startsWith(CSP_SOURCE)),
    );
    expect([...externals]).toEqual([FLUTTER_FONT_ORIGIN]);
    for (const directive of csp.split('; ')) {
      if (!directive.includes(FLUTTER_FONT_ORIGIN)) continue;
      expect(directive.startsWith('font-src') || directive.startsWith('connect-src')).toBe(true);
    }
  });
});

describe('index.html shim', () => {
  it('sets no <base> tag: repointing document.baseURI cross-origin breaks history.replaceState', () => {
    expect(render()).not.toContain('<base');
  });

  it('points every Flutter resource at the webview origin through the loader config', () => {
    const html = render();
    expect(html).toContain(`entrypointBaseUrl: "${BASE_URI}/"`);
    expect(html).toContain(`canvasKitBaseUrl: "${BASE_URI}/canvaskit/"`);
    expect(html).toContain(`assetBase: "${BASE_URI}/"`);
  });

  it('inlines the build config emitted for this build rather than a hardcoded one', () => {
    expect(render()).toContain(`_flutter.buildConfig = ${BUILD_CONFIG};`);
  });

  it('sets the editor-host marker before the Flutter entry point loads', () => {
    const html = render();
    const marker = html.indexOf(`window.${EDITOR_HOST_MARKER_GLOBAL}`);
    const loader = html.indexOf('_flutter.loader.load');
    expect(marker).toBeGreaterThan(-1);
    expect(loader).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(loader);
  });

  it('marks the host kind as vscode — the contract the Dart side reads', () => {
    expect(render()).toContain(`kind: "${EDITOR_HOST_KIND}"`);
  });

  it('publishes the outbound seam before the Flutter entry point loads', () => {
    // Without this global, `HostBridgeChannel.canPost` is false and every
    // outbound frame — acks, selection changes, telemetry — is dropped in
    // silence. The Dart side cannot publish it itself: `acquireVsCodeApi()`
    // may be called once per webview and the shim above already called it.
    const html = render();
    const seam = html.indexOf(`window.${HOST_BRIDGE_SEAM_GLOBAL}`);
    const loader = html.indexOf('_flutter.loader.load');
    expect(seam).toBeGreaterThan(-1);
    expect(seam).toBeLessThan(loader);
  });

  it('names the seam exactly what host_bridge_web.dart binds', () => {
    // `@JS('cruxHostBridge')` in
    // wavecrux/lib/services/host_bridge/host_bridge_web.dart. Renaming either
    // side alone fails silently and forever.
    expect(HOST_BRIDGE_SEAM_GLOBAL).toBe('cruxHostBridge');
  });

  it('routes the seam through the shim’s own acquireVsCodeApi handle', () => {
    // Specifically NOT a second acquireVsCodeApi() call: a second call throws,
    // and in a release build the throw lands in app startup as a grey
    // RenderErrorBox with no explanation.
    const html = render();
    expect(html.match(/acquireVsCodeApi\(\)/g)).toHaveLength(1);
    expect(html).toContain('postMessage: function (frame)');
  });

  it('loads the wellen module loader by absolute URL, before Flutter starts', () => {
    const html = render();
    expect(html).toContain(`src="${BASE_URI}/wasm/wellen_wasm_loader.js"`);
    expect(html.indexOf('wellen_wasm_loader.js')).toBeLessThan(html.indexOf('_flutter.loader.load'));
    expect(html).toContain('type="module"');
  });

  it('loads flutter.js, not flutter_bootstrap.js — the bootstrap accepts no config', () => {
    const html = render();
    expect(html).toContain(`src="${BASE_URI}/flutter.js"`);
    expect(html).not.toContain('flutter_bootstrap.js');
  });

  it('loads flutter.js before the script that calls into it', () => {
    const html = render();
    expect(html.indexOf('flutter.js')).toBeLessThan(html.indexOf('_flutter.loader.load'));
  });

  it('does not reference a service worker', () => {
    expect(render()).not.toContain('flutter_service_worker');
  });

  it('carries the nonce on every inline and local script tag', () => {
    const html = render({ nonce: 'ABC123' });
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain('nonce="ABC123"');
  });

  it('escapes localized text rather than interpolating it raw', () => {
    const html = render({ loadingLabel: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('reports diagnostics under one message type', () => {
    expect(render()).toContain(JSON.stringify(DIAGNOSTIC_MESSAGE_TYPE));
  });

  it('observes the failures a blank panel would otherwise hide', () => {
    const html = render();
    for (const listener of ['error', 'unhandledrejection', 'securitypolicyviolation']) {
      expect(html).toContain(`'${listener}'`);
    }
  });

  it('measures cold start from the shim mark to flutter-first-frame', () => {
    const html = render();
    expect(html).toContain(`'flutter-first-frame'`);
    expect(html).toContain('coldStartMs');
  });
});

describe('vscodeCssVarName', () => {
  it("matches VSCode's own convention: dots to hyphens, --vscode- prefixed", () => {
    expect(vscodeCssVarName('editor.background')).toBe('--vscode-editor-background');
    expect(vscodeCssVarName('sideBarSectionHeader.background')).toBe(
      '--vscode-sideBarSectionHeader-background',
    );
    expect(vscodeCssVarName('focusBorder')).toBe('--vscode-focusBorder');
  });
});

describe('EDITOR_HOST_THEME_COLOR_IDS', () => {
  it('has no duplicates', () => {
    expect(new Set(EDITOR_HOST_THEME_COLOR_IDS).size).toBe(EDITOR_HOST_THEME_COLOR_IDS.length);
  });

  it('carries editor.background and editor.foreground — the two anchors the synthesizer falls back to', () => {
    expect(EDITOR_HOST_THEME_COLOR_IDS).toContain('editor.background');
    expect(EDITOR_HOST_THEME_COLOR_IDS).toContain('editor.foreground');
  });
});

describe('theme bridge', () => {
  it('names the kind host_bridge_messages.dart decodes', () => {
    // `kHostBridgeThemeKind` in wavecrux/lib/services/host_bridge/host_bridge_messages.dart.
    expect(THEME_TOKENS_KIND).toBe('crux.theme_tokens');
  });

  it('reads every curated color id into the boot script, --vscode- CSS var form', () => {
    const html = render();
    for (const id of EDITOR_HOST_THEME_COLOR_IDS) {
      expect(html).toContain(JSON.stringify(id));
    }
    // The runtime lookup goes through the same dots-to-hyphens rule
    // `vscodeCssVarName` exposes for tests — pinned here as a literal
    // rather than by calling the function, so a change to either drifts
    // visibly instead of the test moving in lockstep with the bug.
    expect(html).toContain("'--vscode-' + id.replace(/\\./g, '-')");
  });

  it("detects all four vscode.ColorThemeKind values from data-vscode-theme-kind, high-contrast-light checked first", () => {
    // VSCode's own webview preload (pre/index.html, `applyStyles`) sets
    // `body.dataset.vscodeThemeKind` to exactly one of these four literal
    // values, on load and on every live change — see the module docs on
    // `cruxThemeAppearance` for why that beats reading classList (VSCode
    // ALSO adds the plain 'vscode-high-contrast' class for backwards
    // compatibility when the kind is 'vscode-high-contrast-light', which
    // would make a classList-only check ordering-sensitive; the dataset
    // value has no such overlap). This test still pins the ordering here
    // too, since a `===` chain checked out of order has the same failure
    // mode as a `classList.contains` chain would.
    const html = render();
    const fn = html.slice(html.indexOf('function cruxThemeAppearance'), html.indexOf('function cruxPostTheme'));
    expect(fn).toContain('document.body.dataset.vscodeThemeKind');
    expect(fn.indexOf('vscode-high-contrast-light')).toBeGreaterThan(-1);
    expect(fn.indexOf('vscode-high-contrast-light')).toBeLessThan(fn.indexOf("'vscode-high-contrast'"));
    expect(fn).toContain('vscode-light');
  });

  it('builds the exact CXP envelope shape the Dart decoder expects', () => {
    const html = render();
    expect(html).toContain(JSON.stringify(CXP_FRAME_TYPE));
    expect(html).toContain(JSON.stringify(cxp.CXP_PROTOCOL_VERSION));
    expect(html).toContain(JSON.stringify(HOST_PEER_ID));
    expect(html).toContain('kind: ' + JSON.stringify(THEME_TOKENS_KIND));
    expect(html).toContain('payload: { appearance: appearance, tokens: tokens }');
  });

  it('relays the frame as a same-document postMessage, not through acquireVsCodeApi', () => {
    // The whole point of reading in the shim: no extension-host round trip.
    // `window.postMessage(frame, window.location.origin)` reaches
    // HostBridgeChannel's own listener directly.
    const html = render();
    const themeBlock = html.slice(html.indexOf('function cruxPostTheme'), html.indexOf('// --- cold start'));
    expect(themeBlock).toContain('window.postMessage(');
    expect(themeBlock).not.toContain('api.postMessage(');
  });

  it('posts the first theme frame at flutter-first-frame, after the loader is torn down', () => {
    const html = render();
    const firstFrameBlock = html.slice(
      html.indexOf(`'flutter-first-frame'`),
      html.indexOf('setTimeout(function ()'),
    );
    const loaderRemove = firstFrameBlock.indexOf('loader.remove()');
    const firstPost = firstFrameBlock.indexOf('cruxPostTheme()');
    expect(loaderRemove).toBeGreaterThan(-1);
    expect(firstPost).toBeGreaterThan(loaderRemove);
  });

  it('observes live theme changes via a MutationObserver on data-vscode-theme-kind', () => {
    const html = render();
    expect(html).toContain('new MutationObserver(cruxPostTheme)');
    expect(html).toContain('.observe(document.body');
    expect(html).toContain("attributeFilter: ['data-vscode-theme-kind']");
  });
});

describe('createNonce', () => {
  it('produces a 32-character alphanumeric value', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it('varies between renders', () => {
    expect(createNonce()).not.toBe(createNonce());
  });
});
