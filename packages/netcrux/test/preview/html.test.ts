import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  LAYOUT_WORKER_FILES,
  THEME_COLOR_IDS,
  buildContentSecurityPolicy,
  createNonce,
  escapeHtml,
  renderNoticeHtml,
  renderPreviewHtml,
  webviewResourceBase,
} from '../../src/preview/html';
import {
  EDITOR_HOST_MARKER_GLOBAL,
  HOST_BRIDGE_SEAM_GLOBAL,
  LAYOUT_WORKER_GLOBAL,
  NOTICE_ACTION_TYPE,
} from '../../src/preview/messages';

const NONCE = 'N0nceN0nceN0nceN0nceN0nceN0nce12';
const BASE = 'https://file+.vscode-resource.vscode-cdn.net/ext/media/netcrux-web';

function render(overrides: Partial<Parameters<typeof renderPreviewHtml>[0]> = {}): string {
  return renderPreviewHtml({
    baseUri: BASE,
    buildConfigJson: '{"engineRevision":"abc","useLocalCanvasKit":true,"builds":[]}',
    cspSource: 'https://*.vscode-cdn.net',
    nonce: NONCE,
    title: 'NetCrux',
    loadingLabel: 'Loading the schematic viewer…',
    ...overrides,
  });
}

/** The bodies of the document's inline `<script nonce>` blocks. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

describe('buildContentSecurityPolicy', () => {
  const csp = buildContentSecurityPolicy('https://*.vscode-cdn.net', NONCE);

  it('forbids a base tag, which would break history', () => {
    expect(csp).toContain(`base-uri 'none'`);
  });

  it('allows WebAssembly and never eval', () => {
    expect(csp).toContain(`'wasm-unsafe-eval'`);
    expect(csp).not.toContain(`'unsafe-eval'`);
  });

  it('allows the layout worker only as a blob', () => {
    expect(csp).toContain('worker-src blob:');
  });

  it('names no origin beyond the webview itself, so it works offline', () => {
    expect(csp).not.toMatch(/https?:\/\/(?!\*\.vscode-cdn\.net)/);
    expect(csp).not.toContain('gstatic');
    expect(csp).not.toContain('*;');
  });

  it('scopes scripts to the host and this render', () => {
    expect(csp).toContain(`script-src https://*.vscode-cdn.net 'nonce-${NONCE}'`);
    expect(csp).toContain(`default-src 'none'`);
  });
});

describe('renderPreviewHtml', () => {
  const html = render();

  it('sets no <base> tag', () => {
    expect(html).not.toMatch(/<base[\s>]/i);
  });

  it('publishes the marker and the seam before the viewer loads', () => {
    const scripts = inlineScripts(html);
    const boot = scripts[0] ?? '';
    expect(boot).toContain(`window.${EDITOR_HOST_MARKER_GLOBAL} = Object.freeze`);
    expect(boot).toContain(`window.${HOST_BRIDGE_SEAM_GLOBAL} = Object.freeze`);
    expect(html.indexOf(boot)).toBeLessThan(html.indexOf(`src="${BASE}/flutter.js"`));
  });

  it('starts the viewer with explicit resource URLs, through the loader and not the bootstrap', () => {
    expect(html).toContain(`src="${BASE}/flutter.js"`);
    expect(html).not.toContain('flutter_bootstrap.js');
    expect(html).toContain(`entrypointBaseUrl: "${BASE}/"`);
    expect(html).toContain(`canvasKitBaseUrl: "${BASE}/canvaskit/"`);
    expect(html).toContain(`assetBase: "${BASE}/"`);
  });

  it('does not let the engine reach for glyph fonts on the network', () => {
    expect(html).toContain(`fontFallbackBaseUrl: "${BASE}/no-font-fallback/"`);
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('stages the layout worker before the viewer starts, from the three files it is made of', () => {
    const loader = inlineScripts(html)[1] ?? '';
    expect(loader.indexOf('__cruxStageLayoutWorker')).toBeLessThan(loader.indexOf('_flutter.loader.load'));
    const boot = inlineScripts(html)[0] ?? '';
    for (const file of Object.values(LAYOUT_WORKER_FILES)) expect(boot).toContain(file);
    expect(boot).toContain(`window.${LAYOUT_WORKER_GLOBAL} = URL.createObjectURL`);
    // The worker is composed of the glue's text, a definition of the hosted
    // resources, then the worker's script (web/wasm/elk_wasm_worker.js reads it).
    expect(boot).toContain('self.cruxLayoutHosted');
    expect(boot).toContain('__wbg_init');
  });

  it('relays the editor theme from the page, with the colors the viewer reads', () => {
    const boot = inlineScripts(html)[0] ?? '';
    for (const id of THEME_COLOR_IDS) expect(boot).toContain(`"${id}"`);
    expect(boot).toContain('data-vscode-theme-kind');
    expect(boot).toContain(`kind: "theme_tokens"`);
  });

  it('inlines the build config and the nonce', () => {
    expect(html).toContain('_flutter.buildConfig = {"engineRevision":"abc"');
    expect(html).toContain(`<script nonce="${NONCE}"`);
    expect(html).toContain(`nonce: "${NONCE}"`);
  });

  it('has inline scripts that are valid JavaScript', () => {
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(2);
    for (const source of scripts) expect(() => new vm.Script(source)).not.toThrow();
  });

  it('escapes the strings it interpolates', () => {
    const hostile = render({ title: '<img onerror=x>', loadingLabel: '"><script>1</script>' });
    expect(hostile).not.toContain('<img onerror=x>');
    expect(hostile).not.toContain('"><script>1</script>');
  });
});

describe('renderNoticeHtml', () => {
  const page = {
    title: 'This netlist is too large',
    message: 'Open it in NetCrux <b>instead</b>.',
    actions: [
      { action: 'open-in-netcrux', label: 'Open in NetCrux' },
      { action: 'change-size-limit', label: 'Change the Size Limit' },
    ],
  } as const;
  const html = renderNoticeHtml(page, 'https://*.vscode-cdn.net', NONCE);

  it('renders each action as a button, the first as the primary one', () => {
    expect(html).toContain('<button type="button" class="primary" data-action="open-in-netcrux">Open in NetCrux</button>');
    expect(html).toContain('class="secondary" data-action="change-size-limit"');
  });

  it('posts the action it names, and nothing else, to the extension', () => {
    expect(html).toContain(`type: ${JSON.stringify(NOTICE_ACTION_TYPE)}`);
    expect(html).toContain(`script-src 'nonce-${NONCE}'`);
    expect(html).not.toContain('https://*.vscode-cdn.net *');
    expect(() => new vm.Script(inlineScripts(html)[0] ?? '')).not.toThrow();
  });

  it('escapes the message', () => {
    expect(html).toContain('&lt;b&gt;instead&lt;/b&gt;');
    expect(html).not.toContain('<b>instead</b>');
  });
});

describe('helpers', () => {
  it('createNonce makes 32 URL-safe characters', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(createNonce(() => 0)).toBe('A'.repeat(32));
  });

  it('escapeHtml covers the four characters that matter', () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  it('webviewResourceBase decodes only the authority', () => {
    expect(
      webviewResourceBase('https://file%2B.vscode-resource.vscode-cdn.net/a%20b/c'),
    ).toBe('https://file+.vscode-resource.vscode-cdn.net/a%20b/c');
    expect(webviewResourceBase('https://%E0%A4%A/x')).toBe('https://%E0%A4%A/x');
  });
});
