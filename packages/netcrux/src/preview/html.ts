/**
 * The page that hosts the NetCrux web viewer inside a VS Code webview.
 *
 * The viewer is the open-core NetCrux Flutter web build. Flutter's own
 * `index.html` and `flutter_bootstrap.js` are deliberately not shipped: the
 * page below starts the build itself, because four things have to be true
 * before `main.dart.js` runs, and the generated bootstrap gives no hook for
 * any of them.
 *
 * 1. **Asset URLs must resolve to webview resource URLs, and the document's own
 *    base must not.** A webview document's origin is `vscode-webview://<id>`
 *    while its files are served from `https://file+.vscode-resource.vscode-cdn.net`.
 *    One `<base href>` at the resource origin resolves every asset and then
 *    breaks the app: Flutter's history integration calls `history.replaceState`
 *    with a URL resolved against the new base, a different origin from the
 *    document, and the browser throws a `SecurityError` that lands in startup
 *    and leaves a grey rectangle. So the page sets no `<base>` (the CSP forbids
 *    one) and drives `_flutter.loader.load()` with an explicit `config`.
 * 2. **The editor-host marker and the outbound seam must already exist.** The
 *    viewer decides synchronously, at startup, whether an editor hosts it, by
 *    reading `cruxEditorHost`. And `acquireVsCodeApi()` can be called once, so
 *    the viewer posts through `cruxHostBridge`, the page's own wrapper of that
 *    handle, instead of calling it.
 * 3. **The layout engine must be startable.** The viewer lays a scope out with
 *    elkrs as WebAssembly in a Web Worker. A browser refuses to start a worker
 *    from another origin than the document's, and the webview's files are
 *    another origin, so a worker started from its resource URL fails. The page
 *    fetches the worker's three files (the page may fetch them; a worker cannot
 *    resolve them) and starts the worker from one blob, handing the viewer its
 *    URL as `cruxLayoutWorkerUrl`. Without this the viewer falls back to elkjs,
 *    which needs `eval`, which the CSP refuses, and no schematic is drawn.
 * 4. **Failures must be observable.** A webview has no terminal, and a CSP
 *    refusal, a 404, a WebAssembly failure and a Dart exception all look alike
 *    from outside: a panel with nothing useful in it. The page posts them to
 *    the extension, which writes them to the NetCrux output channel.
 *
 * ### The theme
 *
 * The extension host is Node and has no DOM, so a theme's resolved colors exist
 * only here, as `--vscode-*` custom properties on the document. The page reads
 * a curated list and posts it to itself (a same-document `postMessage`), which
 * the viewer's own `message` listener receives like any other frame, once the
 * viewer has drawn its first frame and again on every theme change.
 */
import {
  EDITOR_HOST_KIND,
  EDITOR_HOST_MARKER_GLOBAL,
  FRAME_TYPE,
  HOST_BRIDGE_SEAM_GLOBAL,
  LAYOUT_WORKER_GLOBAL,
  NOTICE_ACTION_TYPE,
  DIAGNOSTIC_TYPE,
  PROTOCOL_VERSION,
  THEME_TOKENS_KIND,
  type NoticeAction,
} from './messages';

/**
 * How long the page waits for the viewer's first frame before reporting that
 * boot stalled. Generous: a cold CanvasKit and a multi-megabyte dart2js load on
 * a slow machine takes seconds, and a false "stalled" is worse than a late one.
 */
export const FIRST_FRAME_WATCHDOG_MS = 30_000;

/**
 * The VS Code color ids the page reads and relays. Kept in step with
 * `kEditorHostThemeColorIds` in the viewer's `editor_host_theme_synthesizer.dart`;
 * an id the viewer does not read is inert, so drift is a wasted token, not a bug.
 */
export const THEME_COLOR_IDS = [
  'editor.background',
  'editor.foreground',
  'editorWidget.background',
  'sideBar.background',
  'sideBar.foreground',
  'sideBarSectionHeader.background',
  'sideBarSectionHeader.foreground',
  'panel.border',
  'statusBar.background',
  'statusBar.foreground',
  'titleBar.activeBackground',
  'titleBar.activeForeground',
  'tab.activeBackground',
  'tab.inactiveBackground',
  'tab.activeForeground',
  'focusBorder',
] as const;

/** The files the layout worker is made of, relative to the payload root. */
export const LAYOUT_WORKER_FILES = {
  glue: 'wasm/elk_wasm.js',
  worker: 'wasm/elk_wasm_worker.js',
  wasm: 'wasm/elk_wasm_bg.wasm',
} as const;

/** Options for [renderPreviewHtml]. */
export interface PreviewHtmlOptions {
  /**
   * `webview.asWebviewUri(<payload root>)` with its authority decoded, without a
   * trailing slash. Used to build the loader config, never as a `<base href>`.
   */
  readonly baseUri: string;
  /** The `_flutter.buildConfig` of this build, verbatim, as staged by the build tool. */
  readonly buildConfigJson: string;
  /** `webview.cspSource`. */
  readonly cspSource: string;
  /** Per-render nonce for the page's inline scripts. */
  readonly nonce: string;
  /** Localized document title. */
  readonly title: string;
  /** Localized text under the boot spinner. */
  readonly loadingLabel: string;
}

/**
 * The Content-Security-Policy, as one header value.
 *
 * - `default-src 'none'`: deny by default; each allowance is something the
 *   viewer demonstrably fetches.
 * - `base-uri 'none'`: the page sets no `<base>` on purpose, so forbidding one
 *   costs nothing and closes the injection that would break history.
 * - `script-src` needs both the host source and the nonce. The nonce covers the
 *   page's inline blocks; the host source covers the `<script>` tags Flutter's
 *   loader injects. `'wasm-unsafe-eval'` is what CanvasKit and the layout engine
 *   compile WebAssembly under; without it the failure reads as a WebAssembly
 *   error, not a CSP one. There is no `'unsafe-eval'`.
 * - `style-src 'unsafe-inline'`: Flutter injects a `<style>` element for its
 *   `flt-*` defaults and offers no hook to nonce it.
 * - `connect-src`: `fetch()` of the engine, the assets, the layout worker's
 *   files, and `blob:` for the netlist the viewer reads back from the blob it
 *   made of it.
 * - `worker-src blob:`: the layout worker starts from a blob (see the module
 *   docs).
 *
 * There is no external origin. In particular not the font host the engine falls
 * back to for glyphs Roboto lacks: the viewer works offline, and a glyph the
 * bundled font cannot draw renders as a placeholder instead of being fetched.
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `base-uri 'none'`,
    `script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data: blob:`,
    `font-src ${cspSource} data:`,
    `connect-src ${cspSource} data: blob:`,
    `worker-src blob:`,
  ].join('; ');
}

/** A 32-character nonce. It lives for one render and is not a secret. */
export function createNonce(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += alphabet.charAt(Math.floor(random() * alphabet.length));
  return out;
}

/** Minimal HTML-text escaping for the strings interpolated into the pages. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Percent-decode the authority of a webview resource URL, leaving the path
 * encoded.
 *
 * `Uri.toString()` renders the authority as `file%2B.vscode-resource.vscode-cdn.net`.
 * A browser tolerates it (URL parsing decodes the host) but Dart does not: the
 * engine re-parses `assetBase`, re-encodes the `%`, and fetches from
 * `file%252B.vscode-resource.vscode-cdn.net`, a host that does not exist. The
 * symptom is a failed fetch of `assets/FontManifest.json` and an app that never
 * reaches its first frame while CanvasKit, resolved by the browser, loads fine.
 * `toString(true)` would also decode the path and break an install under a
 * directory with a space.
 */
export function webviewResourceBase(uri: string): string {
  return uri.replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)/,
    (_match, scheme: string, authority: string) => {
      try {
        return scheme + decodeURIComponent(authority);
      } catch {
        return scheme + authority;
      }
    },
  );
}

/** The inline boot script: marker, seam, failure capture, layout worker, theme. */
function bootScript(baseUri: string): string {
  return `
  // The marker, set before anything can load the viewer's entry point.
  window.${EDITOR_HOST_MARKER_GLOBAL} = Object.freeze({
    kind: ${JSON.stringify(EDITOR_HOST_KIND)},
    protocol: ${PROTOCOL_VERSION}
  });

  (function () {
    var api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    var bootMark = performance.now();
    var firstFrameReported = false;

    function post(kind, detail) {
      if (!api) return;
      try {
        api.postMessage({
          type: ${JSON.stringify(DIAGNOSTIC_TYPE)},
          kind: kind,
          atMs: Math.round(performance.now() - bootMark),
          detail: detail || {}
        });
      } catch (_) { /* a diagnostic must never break the app */ }
    }
    window.__cruxPostDiagnostic = post;

    // The outbound seam. Frozen: nothing loaded later should be able to
    // replace the viewer's only route to the host.
    window.${HOST_BRIDGE_SEAM_GLOBAL} = Object.freeze({
      protocol: ${PROTOCOL_VERSION},
      postMessage: function (frame) {
        if (!api) return;
        try {
          api.postMessage(frame);
        } catch (error) {
          post('bridge-post-failed', { message: String(error).slice(0, 200) });
        }
      }
    });

    post('boot', { userAgent: navigator.userAgent });

    // Failure capture: a thrown error in the loader, a rejected promise, and a
    // CSP refusal, which otherwise leaves no trace outside devtools.
    window.addEventListener('error', function (event) {
      var thrown = event.error;
      post('error', {
        message: String(event.message || (thrown && thrown.message) || 'error'),
        thrown: thrown === undefined || thrown === null ? '' : String(thrown).slice(0, 400),
        stack: String((thrown && thrown.stack) || '').split('\\n').slice(0, 6).join(' | '),
        source: String(event.filename || ''),
        line: event.lineno || 0
      });
    });
    var consoleForwarded = 0;
    ['error', 'warn'].forEach(function (level) {
      var original = console[level].bind(console);
      console[level] = function () {
        if (consoleForwarded < 40) {
          consoleForwarded += 1;
          var text = Array.prototype.map
            .call(arguments, function (a) { return typeof a === 'string' ? a : String(a); })
            .join(' ');
          post('console-' + level, { text: text.slice(0, 600) });
        }
        return original.apply(console, arguments);
      };
    });
    window.addEventListener('unhandledrejection', function (event) {
      post('unhandledrejection', { message: String((event.reason && event.reason.message) || event.reason) });
    });
    document.addEventListener('securitypolicyviolation', function (event) {
      post('csp-violation', {
        directive: event.effectiveDirective,
        blockedUri: event.blockedURI,
        source: event.sourceFile || ''
      });
    });

    // Which engine files Flutter fetches is a runtime decision; report them,
    // and a 404 from over-pruning the payload.
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var watched = /canvaskit|\\.wasm(\\?|$)/.test(url);
      if (watched) post('resource', { url: url });
      return nativeFetch(input, init).then(function (response) {
        if (!response.ok && watched) post('resource-failed', { url: url, status: response.status });
        return response;
      });
    };

    // The layout worker. See the module docs: the page fetches the three files
    // and starts the worker from one blob. The glue's text comes first, then a
    // definition of the resources, then the worker's own script, so the worker
    // has nothing to import and no relative path to resolve.
    var layoutBase = ${JSON.stringify(baseUri)};
    window.__cruxStageLayoutWorker = function () {
      function text(path) {
        return nativeFetch(layoutBase + '/' + path).then(function (r) {
          if (!r.ok) throw new Error(path + ' ' + r.status);
          return r.text();
        });
      }
      function bytes(path) {
        return nativeFetch(layoutBase + '/' + path).then(function (r) {
          if (!r.ok) throw new Error(path + ' ' + r.status);
          return r.arrayBuffer();
        });
      }
      return Promise.all([
        text(${JSON.stringify(LAYOUT_WORKER_FILES.glue)}),
        text(${JSON.stringify(LAYOUT_WORKER_FILES.worker)}),
        bytes(${JSON.stringify(LAYOUT_WORKER_FILES.wasm)})
      ]).then(function (parts) {
        var wasmUrl = URL.createObjectURL(new Blob([parts[2]], { type: 'application/wasm' }));
        var source = parts[0] +
          '\\nself.cruxLayoutHosted = { glue: { default: __wbg_init, layoutJsonWithProgress: layoutJsonWithProgress }, wasmUrl: ' +
          JSON.stringify(wasmUrl) + ' };\\n' + parts[1];
        window.${LAYOUT_WORKER_GLOBAL} = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        post('layout-worker-staged', { wasmBytes: parts[2].byteLength });
      }).catch(function (error) {
        post('layout-worker-failed', { message: String(error).slice(0, 300) });
      });
    };

    // The theme bridge. \`data-vscode-theme-kind\` on <body> is the exact
    // literal appearance string VS Code's own preload sets, on the initial
    // document and on every live change; reading it avoids the class list's
    // special case for high-contrast light.
    var themeColorIds = ${JSON.stringify(THEME_COLOR_IDS)};
    function appearance() {
      var kind = document.body.dataset.vscodeThemeKind || '';
      if (kind === 'vscode-high-contrast-light') return 'highContrastLight';
      if (kind === 'vscode-high-contrast') return 'highContrast';
      if (kind === 'vscode-light') return 'light';
      return 'dark';
    }
    function postTheme() {
      var style = getComputedStyle(document.documentElement);
      var tokens = {};
      for (var i = 0; i < themeColorIds.length; i++) {
        var id = themeColorIds[i];
        var value = style.getPropertyValue('--vscode-' + id.replace(/\\./g, '-')).trim();
        if (value) tokens[id] = value;
      }
      var kind = appearance();
      // A same-document message: the read happened here, so relaying it through
      // the extension host and back would be a round trip for nothing.
      window.postMessage({
        type: ${JSON.stringify(FRAME_TYPE)},
        protocol: ${PROTOCOL_VERSION},
        kind: ${JSON.stringify(THEME_TOKENS_KIND)},
        appearance: kind,
        tokens: tokens
      }, '*');
      post('theme', { appearance: kind, tokenCount: Object.keys(tokens).length });
    }

    window.addEventListener('flutter-first-frame', function () {
      firstFrameReported = true;
      post('first-frame', {
        coldStartMs: Math.round(performance.now() - bootMark),
        views: document.querySelectorAll('flutter-view').length
      });
      var loader = document.getElementById('crux-boot');
      if (loader) loader.remove();
      // The viewer's listener exists by first frame (it is installed during
      // startup, before the first frame), and a message sent before any
      // listener exists is lost, not queued.
      postTheme();
      new MutationObserver(postTheme).observe(document.body, {
        attributes: true,
        attributeFilter: ['data-vscode-theme-kind']
      });
    });
    setTimeout(function () {
      if (!firstFrameReported) post('first-frame-timeout', { afterMs: ${FIRST_FRAME_WATCHDOG_MS} });
    }, ${FIRST_FRAME_WATCHDOG_MS});

    // A CanvasKit surface is opaque from outside: the panel looks the same
    // whether the viewer drew its UI or Flutter's release-mode error box. These
    // snapshots report the scaffolding around the canvas, which does differ.
    [1000, 4000, 10000].forEach(function (delay) {
      setTimeout(function () {
        var glass = document.querySelector('flt-glass-pane');
        var root = (glass && glass.shadowRoot) || document;
        var canvases = root.querySelectorAll('canvas');
        var canvas = canvases[0];
        post('probe', {
          delayMs: delay,
          views: document.querySelectorAll('flutter-view').length,
          canvasSize: canvas ? canvas.width + 'x' + canvas.height : 'none',
          layoutWorker: typeof window.${LAYOUT_WORKER_GLOBAL} === 'string'
        });
      }, delay);
    });
  })();
`;
}

/** The script that starts Flutter with an explicit resource configuration. */
function loaderScript(baseUri: string, buildConfigJson: string, nonce: string): string {
  return `
  window._flutter = window._flutter || {};
  _flutter.buildConfig = ${buildConfigJson};
  // The layout worker is staged first: the viewer starts it on its first
  // layout and reads its URL from a global, so the global must exist by then.
  // A failed staging does not stop the viewer; it reports and carries on.
  window.__cruxStageLayoutWorker().then(function () {
    return _flutter.loader.load({
      nonce: ${JSON.stringify(nonce)},
      config: {
        entrypointBaseUrl: ${JSON.stringify(`${baseUri}/`)},
        canvasKitBaseUrl: ${JSON.stringify(`${baseUri}/canvaskit/`)},
        assetBase: ${JSON.stringify(`${baseUri}/`)},
        // Glyphs the bundled font lacks are not fetched from anywhere: the
        // viewer works offline, and a missing glyph is a placeholder.
        fontFallbackBaseUrl: ${JSON.stringify(`${baseUri}/no-font-fallback/`)}
      }
    });
  }).catch(function (error) {
    if (window.__cruxPostDiagnostic) {
      window.__cruxPostDiagnostic('loader-failed', { message: String(error) });
    }
  });
`;
}

/** Render the document served to the webview. */
export function renderPreviewHtml(options: PreviewHtmlOptions): string {
  const { baseUri, buildConfigJson, cspSource, nonce, title, loadingLabel } = options;
  const csp = buildContentSecurityPolicy(cspSource, nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); }
    #crux-boot {
      position: fixed; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px;
      color: var(--vscode-foreground, #cccccc); font-family: var(--vscode-font-family, sans-serif); font-size: 13px;
    }
    #crux-boot .spinner {
      width: 32px; height: 32px; border: 3px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
      border-top-color: var(--vscode-focusBorder, #007fd4); border-radius: 50%; animation: crux-spin 0.8s linear infinite;
    }
    @keyframes crux-spin { to { transform: rotate(360deg); } }
  </style>
  <script nonce="${nonce}">${bootScript(baseUri)}</script>
</head>
<body>
  <div id="crux-boot"><div class="spinner"></div><span>${escapeHtml(loadingLabel)}</span></div>
  <!-- Flutter's loader, then the configured start. Both non-async so they run
       in source order: load() is only defined once flutter.js has executed. -->
  <script nonce="${nonce}" src="${baseUri}/flutter.js"></script>
  <script nonce="${nonce}">${loaderScript(baseUri, buildConfigJson, nonce)}</script>
</body>
</html>
`;
}

/** A page shown in place of the viewer. */
export interface NoticePage {
  readonly title: string;
  readonly message: string;
  /** Buttons, the first one primary. */
  readonly actions: readonly { readonly action: NoticeAction; readonly label: string }[];
}

/**
 * Render a notice: a title, a sentence, and buttons that post their action to
 * the extension. The same CSP shape as the viewer's, with no external origin
 * and no script but the one inline block that wires the buttons.
 */
export function renderNoticeHtml(page: NoticePage, cspSource: string, nonce: string): string {
  const buttons = page.actions
    .map(
      (entry, index) =>
        `<button type="button" class="${index === 0 ? 'primary' : 'secondary'}" data-action="${entry.action}">${escapeHtml(entry.label)}</button>`,
    )
    .join('\n      ');
  const csp = `default-src 'none'; base-uri 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(page.title)}</title>
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 32px; line-height: 1.6; }
    main { max-width: 560px; margin: 8vh auto 0; }
    h1 { font-size: 1.3em; font-weight: 600; margin: 0 0 12px; }
    p { margin: 0 0 20px; color: var(--vscode-descriptionForeground, inherit); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { font: inherit; padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(page.title)}</h1>
    <p>${escapeHtml(page.message)}</p>
    <div class="actions">
      ${buttons}
    </div>
  </main>
  <script nonce="${nonce}">
    (function () {
      var api = acquireVsCodeApi();
      document.querySelectorAll('button[data-action]').forEach(function (button) {
        button.addEventListener('click', function () {
          api.postMessage({ type: ${JSON.stringify(NOTICE_ACTION_TYPE)}, action: button.getAttribute('data-action') });
        });
      });
    })();
  </script>
</body>
</html>
`;
}
