import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderPreviewHtml } from '../../src/preview/html';

/**
 * Runs the page's real boot script against a window that is only an event
 * target, then plays the part of VS Code's webview host page, which listens
 * for `contextmenu` on the same window and, unless the page already called
 * `preventDefault()`, takes the event over and asks the workbench for its own
 * menu (a native one on macOS, which swallows the button release the viewer's
 * menu opens on).
 *
 * The headless-Chromium harness (tool/webview-harness/rightclick.mjs) covers
 * the other half, that the viewer then opens its menu. It needs a built viewer
 * and a browser, which CI has neither of, so this half runs here.
 */

function bootScript(): string {
  const html = renderPreviewHtml({
    baseUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/netcrux-web',
    buildConfigJson: '{}',
    cspSource: 'https://*.vscode-cdn.net',
    nonce: 'N0nceN0nceN0nceN0nceN0nceN0nce12',
    title: 'NetCrux',
    loadingLabel: 'Loading',
  });
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  return match?.[1] ?? '';
}

interface Booted {
  readonly window: EventTarget;
  readonly posted: { type?: string; kind?: string; detail?: Record<string, unknown> }[];
}

function boot(): Booted {
  const window = new EventTarget() as EventTarget & Record<string, unknown>;
  const posted: Booted['posted'] = [];
  window['fetch'] = () => Promise.reject(new Error('no network in this test'));
  window['postMessage'] = () => undefined;
  const document = Object.assign(new EventTarget(), {
    body: { dataset: {} },
    documentElement: {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const sandbox = {
    window,
    document,
    acquireVsCodeApi: () => ({ postMessage: (message: Booted['posted'][number]) => posted.push(message) }),
    console: { error: () => undefined, warn: () => undefined },
    navigator: { userAgent: 'test' },
    performance: { now: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class {
      observe(): void {}
    },
    // The watchdog and the probes are timers; none should fire in a test.
    setTimeout: () => 0,
    URL: { createObjectURL: () => 'blob:test' },
    Blob: class {},
  };
  vm.runInNewContext(bootScript(), sandbox);
  return { window, posted };
}

/** A `contextmenu` event as the browser dispatches it, plus VS Code's reaction. */
function rightClick(target: EventTarget): { defaultPrevented: boolean; hostTookOver: boolean } {
  let hostTookOver = false;
  // VS Code's listener, in behaviour: back off when the event was handled,
  // otherwise prevent it and hand it to the workbench.
  target.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    hostTookOver = true;
  });
  const event = Object.assign(new Event('contextmenu', { cancelable: true, bubbles: true }), {
    clientX: 410,
    clientY: 220,
  });
  target.dispatchEvent(event);
  return { defaultPrevented: event.defaultPrevented, hostTookOver };
}

describe('secondary click in the preview page', () => {
  it('is handled by the page before VS Code takes it over, so the viewer opens its own menu', () => {
    const { window } = boot();
    const outcome = rightClick(window);
    expect(outcome.hostTookOver).toBe(false);
    expect(outcome.defaultPrevented).toBe(true);
  });

  it('would be taken over by the host if the page did nothing (the regression this guards)', () => {
    const outcome = rightClick(new EventTarget());
    expect(outcome.hostTookOver).toBe(true);
  });

  it('reports the first few secondary clicks to the output channel, and then stops', () => {
    const { window, posted } = boot();
    for (let i = 0; i < 8; i += 1) rightClick(window);
    const reports = posted.filter((m) => m.kind === 'context-menu');
    expect(reports).toHaveLength(5);
    expect(reports[0]?.detail).toEqual({ x: 410, y: 220 });
  });
});
