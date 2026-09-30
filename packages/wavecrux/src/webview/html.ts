/**
 * The index.html shim that hosts the WaveCrux Flutter web build inside a
 * VSCode webview (see docs/webview-hosting.md).
 *
 * Flutter's own generated `index.html` is deliberately NOT shipped, and
 * neither is its `flutter_bootstrap.js` entry path. Three things have to be
 * true before `main.dart.js` runs:
 *
 * 1. **Asset URLs must resolve to webview resource URLs, and the document's
 *    own base must NOT.** A webview document's origin is
 *    `vscode-webview://<id>`, while its files are served from
 *    `https://file+.vscode-resource.vscode-cdn.net`. The obvious fix — one
 *    `<base href>` pointing at the resource origin — resolves assets
 *    correctly and then **breaks the app**: Flutter's browser-history
 *    integration calls `history.replaceState` with a URL resolved against
 *    `document.baseURI`, which is now a *different origin* from the document,
 *    and the browser throws
 *    `SecurityError: Failed to execute 'replaceState' on 'History'`. That
 *    exception escapes into app startup, and a release build answers an
 *    exception with `RenderErrorBox` — a plain grey rectangle that looks
 *    exactly like "the webview didn't load". Measured, not theorised: see
 *    docs/webview-hosting.md §3.1.
 *
 *    So the shim leaves `document.baseURI` alone (same origin as the
 *    document, history works) and instead drives `_flutter.loader.load()`
 *    itself with an explicit `config` — `entrypointBaseUrl`,
 *    `canvasKitBaseUrl`, `assetBase` — each pointing at the resource origin.
 *    That is also why `flutter.js` is loaded rather than
 *    `flutter_bootstrap.js`: the generated bootstrap ends with a bare
 *    `_flutter.loader.load()` and gives no way to pass a config.
 * 2. **The editor-host marker and the outbound seam must already exist.**
 *    `EditorHostKind` (in the WaveCrux repo) documents that the answer is
 *    available *synchronously at startup*, which is only true if the marker is
 *    set before the Dart entry point runs; and `HostBridgeChannel.canPost` is
 *    false — dropping every ack, selection change, and telemetry event — until
 *    `cruxHostBridge` exists. Hence an inline `<script>` in `<head>`, ahead of
 *    the loader, publishing both. See `HOST_BRIDGE_SEAM_GLOBAL` for why the
 *    seam has to be the shim's rather than the app's.
 * 3. **Failures must be observable.** A webview has no terminal. Without the
 *    diagnostics below, a CSP violation, a 404 on an asset, a WASM
 *    instantiation failure, and the `replaceState` bug above all look
 *    identical from the outside: a panel with nothing useful in it.
 *
 * ### 4. The theme bridge lives here too, and only here
 *
 * VSCode does not hand the *extension host* process a resolved color
 * palette — it is Node.js, with no DOM. The only place a theme's actual
 * resolved colors exist is this document: VSCode injects them as
 * `--vscode-*` CSS custom properties on `:root` and the theme kind as a
 * `data-vscode-theme-kind` attribute on `<body>`, both kept live-updated on
 * every theme change. So the read has to happen in this shim, not in
 * `panel.ts`/`waveform-editor.ts` — and once it does, relaying the result
 * needs no extension-host round trip either: the boot script below posts the
 * frame to `window` itself (a same-document `postMessage`), which
 * `HostBridgeChannel`'s own `message` listener in `host_bridge_web.dart`
 * already receives — the same channel every other inbound frame arrives on.
 * `editor_host_theme_synthesizer.dart` in the wavecrux repo does the actual
 * synthesis; this file's job ends at handing over the raw tokens and the
 * appearance kind.
 *
 * The first post waits for `flutter-first-frame`, exactly like the
 * byte-transfer path in `editor/waveform-editor.ts` waits for it before
 * streaming a waveform: that is the earliest point `HostBridgeChannel`'s
 * listener is guaranteed to exist (installed during Dart's `bootstrap()`,
 * before `runApp`), and a frame posted before any listener exists is simply
 * lost — `postMessage` does not queue for a listener that arrives later.
 * Live changes after that are driven by a `MutationObserver` on `<body>`'s
 * `data-vscode-theme-kind` attribute, which VSCode's own webview preload
 * (`applyStyles` in `vs/workbench/contrib/webview/browser/pre/index.html`)
 * updates synchronously alongside the CSS custom properties, on the SAME
 * already-loaded document — not by tearing it down and reloading it. See
 * `cruxThemeAppearance`'s own comment for why the dataset attribute is read
 * rather than `classList`.
 */
import { cxp } from '@crux-vscode/host-core';
import { CXP_FRAME_TYPE, HOST_BRIDGE_PROTOCOL_VERSION, HOST_PEER_ID } from './open-waveform';

/**
 * The global the shim publishes before `main.dart.js` runs.
 *
 * **This name is the contract with the Dart side** — WaveCrux's
 * `host_bridge_web.dart` reads `globalThis.cruxEditorHost?.kind` to resolve
 * `EditorHostKind` synchronously. Changing it here without changing it there
 * silently downgrades a webview-hosted build to `form_factor: 'web'`, which
 * is exactly the misreported telemetry bucket `editor_host_kind.dart` warns
 * about.
 *
 * An object rather than a bare string so later fields (protocol version,
 * capability hints) can be added without a second global.
 */
export const EDITOR_HOST_MARKER_GLOBAL = 'cruxEditorHost';

/** Value of `cruxEditorHost.kind` for a VSCode extension host. */
export const EDITOR_HOST_KIND = 'vscode';

/**
 * The **outbound seam** the Dart side posts frames through.
 *
 * `acquireVsCodeApi()` may be called exactly once per webview, and the shim's
 * boot IIFE already calls it — it needs the same channel for the diagnostics
 * that run before Dart exists. A second call throws, and the throw would land
 * in app startup, which in a release build means a grey `RenderErrorBox` and
 * no explanation. So the Dart side never calls it: `host_bridge_web.dart`
 * binds `@JS('cruxHostBridge')` and posts through this object instead.
 *
 * Absent, `HostBridgeChannel.canPost` is false and **every** outbound frame —
 * acks, selection changes, telemetry — is silently dropped. That is the safe
 * direction to fail, but it is also completely invisible, which is why the
 * name is a named constant on both sides with a test pinning it on each.
 */
export const HOST_BRIDGE_SEAM_GLOBAL = 'cruxHostBridge';

/** Bumped when the host↔webview message shape changes incompatibly. */
export const EDITOR_HOST_PROTOCOL_VERSION = 1;

/** `type` of every diagnostic the shim posts to the extension. */
export const DIAGNOSTIC_MESSAGE_TYPE = 'crux.webview.diagnostic';

/**
 * How long the shim waits for `flutter-first-frame` before reporting that
 * boot stalled. Generous: a cold CanvasKit + 6 MB dart2js load on a slow
 * machine is seconds, and a false "stalled" is worse than a late one.
 */
export const FIRST_FRAME_WATCHDOG_MS = 30_000;

/**
 * CXP kind for a theme-tokens frame. Mirrors `kHostBridgeThemeKind` in
 * `host_bridge_messages.dart`.
 */
export const THEME_TOKENS_KIND = 'crux.theme_tokens';

/**
 * VSCode's dotted color ids the shim reads and relays, curated rather than
 * exhaustive (VSCode ships several hundred). Chosen for two things:
 * guaranteed presence with a sane default in every built-in and
 * third-party theme, and actual use on the Dart side — keep this in sync
 * with the `raw('…')` lookups in wavecrux's
 * `lib/core/theme/editor_host_theme_synthesizer.dart`. An id here the Dart
 * side does not read is inert, not wrong, so drift is a wasted token, not a
 * bug — but keeping the two lists matching is still the point.
 */
export const EDITOR_HOST_THEME_COLOR_IDS = [
  'editor.background',
  'editor.foreground',
  'editorCursor.foreground',
  'editor.selectionBackground',
  'editorIndentGuide.background',
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
  'textLink.foreground',
  'descriptionForeground',
  'errorForeground',
  'charts.red',
  'charts.orange',
  'charts.yellow',
  'charts.blue',
] as const;

/**
 * The CSS custom property VSCode injects for [colorId] — `id.replace(/\./g,
 * '-')`, `--vscode-`-prefixed. This is VSCode's own documented convention
 * (Webview API: theme color access), not a guess; a test pins a handful of
 * known values against it.
 */
export function vscodeCssVarName(colorId: string): string {
  return `--vscode-${colorId.replace(/\./g, '-')}`;
}

export interface WebviewHtmlOptions {
  /**
   * `webview.asWebviewUri(<media root>)` as a string, WITHOUT a trailing
   * slash — the renderer appends it. Used to build the loader config, never
   * as a `<base href>`; see the module docs for why that distinction is what
   * makes the app work at all.
   */
  readonly baseUri: string;
  /**
   * The `_flutter.buildConfig` object emitted by this build, verbatim, as
   * staged into `flutter-build-config.json` by tool/build-wavecrux-web.mjs.
   * It carries the engine revision, so it cannot be hardcoded.
   */
  readonly buildConfigJson: string;
  /** `webview.cspSource`. */
  readonly cspSource: string;
  /** Per-render nonce for the shim's own inline script. */
  readonly nonce: string;
  /** Localized document title. */
  readonly title: string;
  /** Localized text under the boot spinner. */
  readonly loadingLabel: string;
}

/**
 * The Content-Security-Policy the shim installs, as a single header value.
 *
 * Each directive earns its place:
 *
 * - `default-src 'none'` — deny by default; every allowance below is
 *   something Flutter demonstrably fetches.
 * - `base-uri 'none'` — the shim sets no `<base>` tag at all, on purpose (see
 *   the module docs: a `<base>` pointing at the resource origin breaks
 *   `history.replaceState`), so forbidding one outright costs nothing and
 *   closes the injection that would silently re-break history.
 * - `script-src ${cspSource} 'nonce-…' 'wasm-unsafe-eval'` — the host source
 *   covers the `<script>` tags Flutter's loader *injects* (it passes no
 *   nonce of its own unless one is handed to `_flutter.loader.load()`), the
 *   nonce covers the shim's inline block, and `'wasm-unsafe-eval'` is what
 *   lets `WebAssembly.compileStreaming` run for CanvasKit, wellen, and
 *   lxt2fst. Without it the panel renders nothing and the console shows a
 *   WebAssembly compilation error rather than a CSP one, which is why it is
 *   worth stating plainly.
 * - `style-src ${cspSource} 'unsafe-inline'` — Flutter injects a `<style>`
 *   element for its `flt-*` element defaults and offers no hook to nonce it.
 *   This is the one directive we cannot tighten from the host side.
 * - `img-src`/`font-src` with `data:` — decoded images and the tree-shaken
 *   icon font arrive as data URLs.
 * - `connect-src` — `fetch()` for `canvaskit.wasm`, `AssetManifest.bin`,
 *   the wellen/lxt2fst `.wasm` binaries, and `blob:` for anything the engine
 *   round-trips through an object URL.
 * - `worker-src blob:` — unused by the dart2js/CanvasKit build shipped here
 *   (only the skwasm renderer spawns a Blob worker), kept so a future
 *   renderer switch fails visibly in a test rather than at a user's desk.
 *
 * The one external origin — `https://fonts.gstatic.com` — is not Flutter's
 * CanvasKit CDN (`--no-web-resources-cdn` removed that). It is the engine's
 * **glyph fallback**. Roboto itself ships in the payload: a
 * `--no-web-resources-cdn` build stages `assets/fonts/fallback/Roboto-Regular.ttf`
 * and lists it in `FontManifest.json`, so ordinary text renders offline. But
 * the engine's `fontFallbackBaseUrl` defaults to `https://fonts.gstatic.com/s/`
 * and the shim does not override it, so glyphs Roboto cannot draw — CJK
 * included — are fetched from this origin at runtime. Dropping it means
 * pointing `fontFallbackBaseUrl` at bundled fonts first. See
 * docs/webview-hosting.md §4.
 */
export const FLUTTER_FONT_ORIGIN = 'https://fonts.gstatic.com';

export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `base-uri 'none'`,
    `script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data: blob:`,
    `font-src ${cspSource} ${FLUTTER_FONT_ORIGIN} data:`,
    `connect-src ${cspSource} ${FLUTTER_FONT_ORIGIN} data: blob:`,
    `worker-src blob:`,
  ].join('; ');
}

/** Cryptographically-boring nonce; 128 bits of `Math.random` is plenty for a
 * value that lives for one webview render and is never a secret. */
export function createNonce(random: () => number = Math.random): string {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    out += alphabet.charAt(Math.floor(random() * alphabet.length));
  }
  return out;
}

/** Minimal HTML-text escaping for the two localized strings interpolated below. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The inline boot script. Kept as a template rather than a separate file so
 * it is covered by the shim's nonce without needing a second CSP allowance,
 * and so the ordering guarantee in the module docs is visible in one place.
 */
function bootScript(): string {
  return `
  // --- editor-host marker -------------------------------------------------
  // Set FIRST, before anything can import the Dart entry point. See
  // EDITOR_HOST_MARKER_GLOBAL.
  window.${EDITOR_HOST_MARKER_GLOBAL} = Object.freeze({
    kind: ${JSON.stringify(EDITOR_HOST_KIND)},
    protocol: ${EDITOR_HOST_PROTOCOL_VERSION}
  });

  (function () {
    var api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    var bootMark = performance.now();
    var firstFrameReported = false;

    function post(kind, detail) {
      if (!api) return;
      try {
        api.postMessage({
          type: ${JSON.stringify(DIAGNOSTIC_MESSAGE_TYPE)},
          kind: kind,
          atMs: Math.round(performance.now() - bootMark),
          detail: detail
        });
      } catch (_) { /* a diagnostic must never break the app */ }
    }
    window.__cruxPostDiagnostic = post;

    // --- outbound seam ------------------------------------------------------
    // The Dart side cannot acquire the VSCode API itself — see
    // HOST_BRIDGE_SEAM_GLOBAL. Published here, inside the same closure that
    // owns \`api\`, and before any tag that can load main.dart.js, so
    // HostBridgeChannel.canPost is true from the first frame the app posts.
    //
    // Frozen for the same reason the marker is: nothing loaded after this
    // point should be able to replace the app's only route to the host.
    var framesPosted = 0;
    window.${HOST_BRIDGE_SEAM_GLOBAL} = Object.freeze({
      protocol: ${EDITOR_HOST_PROTOCOL_VERSION},
      postMessage: function (frame) {
        if (!api) return;
        try {
          api.postMessage(frame);
        } catch (error) {
          // A frame that will not clone must not throw into a Dart feature
          // flow: the Dart side's post() already swallows, and this is the
          // only place that can say *why*.
          post('bridge-post-failed', { message: String(error).slice(0, 200) });
          return;
        }
        // Bounded evidence that the seam is live. Enough to prove the
        // handshake in a scripted run, too few to flood the channel when
        // selection mirroring is chatty.
        if (framesPosted < 20) {
          framesPosted += 1;
          post('bridge-post', {
            frameType: frame && typeof frame === 'object' ? String(frame.type) : typeof frame,
            kind:
              frame && typeof frame === 'object' && frame.envelope
                ? String(frame.envelope.kind)
                : ''
          });
        }
      }
    });

    post('boot', { userAgent: navigator.userAgent, baseUri: document.baseURI });

    // --- failure capture --------------------------------------------------
    // These three cover every way the page can fail silently: a thrown error
    // in Flutter's loader, a rejected asset promise, and a CSP refusal (which
    // otherwise leaves no trace at all outside devtools).
    window.addEventListener('error', function (event) {
      var thrown = event.error;
      post('error', {
        message: String(event.message || (thrown && thrown.message) || 'error'),
        // dart2js throws Dart objects, not Errors: event.message is often just
        // "Uncaught" and everything useful is on the thrown value itself.
        thrown: thrown === undefined || thrown === null ? '' : String(thrown).slice(0, 400),
        stack: String((thrown && thrown.stack) || '').split('\\n').slice(0, 6).join(' | '),
        source: String(event.filename || ''),
        line: event.lineno || 0
      });
    });

    // Flutter reports framework errors through console.error/warn; in a
    // release dart2js build that is the only place the exception text exists.
    // Capped so a repeating failure cannot flood the host.
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

    // --- resource observation ---------------------------------------------
    // Which CanvasKit variant Flutter selects is a runtime decision (it
    // depends on Intl.v8BreakIterator + ImageDecoder support). The prune list
    // in tool/build-wavecrux-web.mjs has to match it, so report the answer
    // rather than assume it. Also catches a 404 from over-pruning.
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/canvaskit|\\.wasm(\\?|$)/.test(url)) {
        post('resource', { url: url });
      }
      return nativeFetch(input, init).then(function (response) {
        if (!response.ok && /canvaskit|\\.wasm(\\?|$)/.test(url)) {
          post('resource-failed', { url: url, status: response.status });
        }
        return response;
      });
    };

    // --- theme bridge ------------------------------------------------------
    // See the module docs for why the read happens here (this document has a
    // DOM; the extension host does not) and why the first post waits for
    // flutter-first-frame (HostBridgeChannel's listener is not guaranteed to
    // exist before then, and a postMessage sent before any listener exists is
    // simply lost). Live changes after that are driven by the MutationObserver
    // below, set up at the same point.
    //
    // \`document.body.dataset.vscodeThemeKind\` (read here as the
    // \`data-vscode-theme-kind\` attribute) rather than classList: VSCode's own
    // webview preload
    // (vs/workbench/contrib/webview/browser/pre/index.html, \`applyStyles\`)
    // sets this to the exact literal appearance string —
    // 'vscode-light'/'vscode-dark'/'vscode-high-contrast'/
    // 'vscode-high-contrast-light' — on both the initial document and, via the
    // 'styles' message handler, on every live change. It also, "for backwards
    // compatibility", ADDS the 'vscode-high-contrast' CLASS whenever the kind
    // is 'vscode-high-contrast-light' — so a classList-only check would have
    // to special-case that ordering to tell the two high-contrast kinds
    // apart. The dataset attribute has no such trap: it is the one field
    // that is only ever exactly one of the four values.
    var themeColorIds = ${JSON.stringify(EDITOR_HOST_THEME_COLOR_IDS)};
    var themeMessageSeq = 0;
    function cruxThemeAppearance() {
      var kind = document.body.dataset.vscodeThemeKind || '';
      if (kind === 'vscode-high-contrast-light') return 'highContrastLight';
      if (kind === 'vscode-high-contrast') return 'highContrast';
      if (kind === 'vscode-light') return 'light';
      return 'dark';
    }
    function cruxPostTheme() {
      var style = getComputedStyle(document.documentElement);
      var tokens = {};
      for (var i = 0; i < themeColorIds.length; i++) {
        var id = themeColorIds[i];
        var value = style.getPropertyValue('--vscode-' + id.replace(/\\./g, '-')).trim();
        if (value) tokens[id] = value;
      }
      var appearance = cruxThemeAppearance();
      themeMessageSeq += 1;
      // Same-document postMessage, NOT the acquireVsCodeApi seam used
      // elsewhere in this file: the read already happened here, so relaying
      // through the extension host and back would be a round trip for no
      // reason. HostBridgeChannel's own 'message' listener on window
      // receives this directly — see the module docs.
      window.postMessage({
        type: ${JSON.stringify(CXP_FRAME_TYPE)},
        protocol: ${HOST_BRIDGE_PROTOCOL_VERSION},
        envelope: {
          cxp_version: ${JSON.stringify(cxp.CXP_PROTOCOL_VERSION)},
          message_id: 'theme-' + themeMessageSeq,
          from: ${JSON.stringify(HOST_PEER_ID)},
          kind: ${JSON.stringify(THEME_TOKENS_KIND)},
          payload: { appearance: appearance, tokens: tokens }
        }
      }, window.location.origin);
      post('theme', { appearance: appearance, tokenCount: Object.keys(tokens).length });
    }

    // --- cold start -------------------------------------------------------
    window.addEventListener('flutter-first-frame', function () {
      firstFrameReported = true;
      post('first-frame', {
        coldStartMs: Math.round(performance.now() - bootMark),
        views: document.querySelectorAll('flutter-view').length,
        canvases: document.querySelectorAll('canvas').length
      });
      var loader = document.getElementById('crux-boot');
      if (loader) loader.remove();
      // First theme post, plus live updates from here on. document.body is
      // guaranteed to exist by first-frame (it did not exist yet when this
      // script ran, in <head>), and any theme change VSCode applied before
      // this point is already reflected in the computed style cruxPostTheme
      // reads, so nothing before first-frame is missed.
      cruxPostTheme();
      new MutationObserver(cruxPostTheme).observe(document.body, {
        attributes: true,
        attributeFilter: ['data-vscode-theme-kind']
      });
    });
    setTimeout(function () {
      if (!firstFrameReported) post('first-frame-timeout', { afterMs: ${FIRST_FRAME_WATCHDOG_MS} });
    }, ${FIRST_FRAME_WATCHDOG_MS});

    // --- render probe -----------------------------------------------------
    // A CanvasKit surface is opaque from the outside: the panel looks the same
    // whether the app drew its UI or Flutter's release-mode error box. These
    // snapshots report the DOM scaffolding around the canvas, which does
    // differ, and are the only host-side evidence of what actually rendered.
    [1000, 4000, 10000].forEach(function (delay) {
      setTimeout(function () {
        // CanvasKit renders into a <canvas> inside flt-glass-pane's SHADOW
        // root, so a plain document.querySelector('canvas') finds nothing even
        // on a perfectly healthy app. Look through the shadow root, or the
        // probe reports a false negative.
        var glass = document.querySelector('flt-glass-pane');
        var root = (glass && glass.shadowRoot) || document;
        var canvases = root.querySelectorAll('canvas');
        var canvas = canvases[0];
        post('probe', {
          delayMs: delay,
          views: document.querySelectorAll('flutter-view').length,
          canvases: canvases.length,
          canvasSize: canvas ? canvas.width + 'x' + canvas.height : 'none',
          glassPane: glass ? 'present' : 'absent',
          canvasKit: !!window.flutterCanvasKit,
          wellen: !!globalThis.waveCruxWellen
        });
      }, delay);
    });

    // --- input observation ------------------------------------------------
    // Capture-phase only: this reports that a real pointer event reached the
    // document, which distinguishes "the panel is a picture" from "the panel
    // is receiving input". Whether Flutter *acted* on it is a question only a
    // pixel comparison can answer.
    window.addEventListener('pointerdown', function (event) {
      post('pointerdown', { x: Math.round(event.clientX), y: Math.round(event.clientY), trusted: event.isTrusted });
    }, true);
    window.addEventListener('keydown', function (event) {
      post('keydown', { key: event.key, trusted: event.isTrusted });
    }, true);
  })();
`;
}

/**
 * The script that starts Flutter with an explicit resource configuration.
 *
 * This replaces `flutter_bootstrap.js`, which would call
 * `_flutter.loader.load()` with no arguments and leave every URL to resolve
 * against `document.baseURI` — the thing the shim must not repoint. See the
 * module docs.
 */
function loaderScript(baseUri: string, buildConfigJson: string, nonce: string): string {
  return `
  window._flutter = window._flutter || {};
  _flutter.buildConfig = ${buildConfigJson};
  _flutter.loader.load({
    nonce: ${JSON.stringify(nonce)},
    config: {
      // Where main.dart.js lives.
      entrypointBaseUrl: ${JSON.stringify(`${baseUri}/`)},
      // Where canvaskit/ lives. The loader appends the variant subdirectory
      // ('chromium') itself, based on what the browser supports.
      canvasKitBaseUrl: ${JSON.stringify(`${baseUri}/canvaskit/`)},
      // Where the engine resolves assets/… from.
      assetBase: ${JSON.stringify(`${baseUri}/`)}
    }
  }).catch(function (error) {
    if (window.__cruxPostDiagnostic) {
      window.__cruxPostDiagnostic('loader-failed', { message: String(error) });
    }
  });
`;
}

/** Render the full document served to the webview. */
export function renderWebviewHtml(options: WebviewHtmlOptions): string {
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
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #1a1a2e; }
    #crux-boot {
      position: fixed; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px;
      color: #e0e0e0; font-family: var(--vscode-font-family, monospace); font-size: 13px;
    }
    #crux-boot .spinner {
      width: 32px; height: 32px; border: 3px solid rgba(0, 230, 118, 0.2);
      border-top-color: #00e676; border-radius: 50%; animation: crux-spin 0.8s linear infinite;
    }
    @keyframes crux-spin { to { transform: rotate(360deg); } }
  </style>
  <script nonce="${nonce}">${bootScript()}</script>
</head>
<body>
  <div id="crux-boot"><div class="spinner"></div><span>${escapeHtml(loadingLabel)}</span></div>
  <!-- wellen/lxt2fst engines: publishes globalThis.waveCruxWellen. A module
       script resolves its own imports against import.meta.url, so the sibling
       wellen_wasm.js and the .wasm binary follow this absolute URL without
       any base-tag help. -->
  <script nonce="${nonce}" type="module" src="${baseUri}/wasm/wellen_wasm_loader.js"></script>
  <!-- Flutter's loader, then our configured start. Both non-async so they run
       in source order: load() is only defined once flutter.js has executed. -->
  <script nonce="${nonce}" src="${baseUri}/flutter.js"></script>
  <script nonce="${nonce}">${loaderScript(baseUri, buildConfigJson, nonce)}</script>
</body>
</html>
`;
}
