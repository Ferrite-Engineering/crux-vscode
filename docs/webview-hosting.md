# Hosting the WaveCrux Flutter web build in a VSCode webview

The `wavecrux` extension embeds the WaveCrux Flutter web build — the open-core
app from `Ferrite-Engineering/wavecrux` — inside a VSCode webview, with the
wellen WASM engine parsing waveforms in the page. It is reached two ways: the
`WaveformEditorProvider` custom editor (a `CustomReadonlyEditorProvider` for
view type `wavecrux.waveform`), and the document-less panel behind
**EDACrux: Open Waveform Panel** (`wavecrux.openPanel`).

This document records the technical decisions that make that work, and the
failure each one prevents. Code comments cite it by section number. Every rule
here was found by running the build inside a webview; several of the failures
look identical from outside — a panel with nothing useful in it — so the
symptom is recorded alongside the fix.

**Scope.** Desktop VSCode only: the webview is always Electron-hosted Chromium.
Nothing here has been checked under a *remote* extension host or `vscode.dev`,
and §5 explains the one staging decision that depends on it.

---

## 1. Build flags

```
flutter build web --release --no-web-resources-cdn --pwa-strategy=none
```

Run by `tool/build-wavecrux-web.mjs` in a checkout of the open-core WaveCrux app
(`Ferrite-Engineering/wavecrux`): `CRUX_WAVECRUX_REPO` when set, otherwise a
sibling `../wavecrux` checkout next to this repository.

- `--no-web-resources-cdn` — otherwise the loader resolves CanvasKit to
  `https://www.gstatic.com/flutter-canvaskit/<engineRevision>`. With the flag,
  the emitted `_flutter.buildConfig` carries `"useLocalCanvasKit": true` and the
  loader resolves `canvaskit/` locally. The build script **fails the build** if
  that field is not `true`, so dropping the flag cannot pass silently.
- `--pwa-strategy=none` — service workers do not work under
  `vscode-webview://`. Flutter still writes a zero-byte
  `flutter_service_worker.js`; the staging step does not copy it, and the shim
  never references one.
- `--release` — a debug build's loader needs a far laxer `script-src`.

`--pwa-strategy` is deprecated as of Flutter 3.44 (flutter/flutter#156910). When
it goes, `--pwa-strategy=none` becomes unnecessary rather than unavailable — the
staging allowlist already excludes the service worker either way.

## 2. The index.html shim

`packages/wavecrux/src/webview/html.ts` renders the document. Flutter's own
`index.html` and `flutter_bootstrap.js` are **not** shipped. The shim's jobs:

1. **Point Flutter's resources at the webview origin — without repointing the
   document's own base.** See §3.
2. **Set the editor-host marker and the outbound seam before `main.dart.js`
   runs**, so `EditorHostKind` resolves synchronously as its doc comment
   promises, and so the Dart side can post. The seam, `window.cruxHostBridge`,
   exists because `acquireVsCodeApi()` may be called once per webview and the
   shim's diagnostics already hold that handle; without the seam every
   outbound frame (acks, selections, telemetry) is silently dropped.
3. **Make failure observable.** A webview has no terminal, and a CSP refusal, a
   404, a WASM failure and a Dart exception all look identical from outside:
   a panel with nothing useful in it. The shim posts `error`,
   `unhandledrejection`, `securitypolicyviolation`, forwarded `console.error`
   / `console.warn`, engine resource URLs, DOM probes, and the cold-start
   measurement back to the extension, which writes them to the *WaveCrux*
   output channel (and, when `CRUX_WEBVIEW_DIAGNOSTIC_LOG` is set, to a file
   so a scripted run can be read from a terminal).
4. **Relay the VSCode theme.** Only this document has the resolved
   `--vscode-*` colors, so the shim reads a curated list
   (`EDITOR_HOST_THEME_COLOR_IDS`) and posts a `crux.theme_tokens` frame at
   first frame and on every `data-vscode-theme-kind` change.

### 2.1 The two globals — a contract with `host_bridge_web.dart`

```js
window.cruxEditorHost = Object.freeze({ kind: 'vscode', protocol: 1 });
```

`host_bridge_web.dart` reads `globalThis.cruxEditorHost?.kind` and maps
`'vscode'` → `EditorHostKind.vscode`; absence → `EditorHostKind.none`. It is set
in an inline `<head>` script, before any tag that can load the Dart entry point.
Constants live in `html.ts` as `EDITOR_HOST_MARKER_GLOBAL`, `EDITOR_HOST_KIND`,
`EDITOR_HOST_PROTOCOL_VERSION` and `HOST_BRIDGE_SEAM_GLOBAL`, mirrored by
`kEditorHostMarkerGlobal` in WaveCrux's `host_bridge_messages.dart`; tests
assert the names and that both globals exist before the entry point loads.

**Both names are two-sided.** `cruxEditorHost` and `cruxHostBridge` are read by
WaveCrux's `host_bridge_web.dart`; do not rename either here without renaming
it there. A marker mismatch is silent and reports `form_factor: 'web'` forever
after; a seam mismatch drops every outbound frame.

### 2.2 `resolveCustomEditor` must not await the webview

VSCode does not build a custom editor's webview content until the provider's
`resolveCustomEditor` promise resolves, so waiting for `flutter-first-frame`
before returning deadlocks. The symptom is a blank editor tab with no
diagnostic of any kind — the shim that would have reported the failure is the
thing that never ran. The byte transfer therefore starts in a floating promise;
see the comment on `void send()` in `src/editor/waveform-editor.ts`.

---

## 3. Resolving assets without breaking the document

### 3.1 `<base href>` breaks `history.replaceState`

The obvious way to rewrite Flutter's asset URLs is one tag:

```html
<base href="https://file+.vscode-resource.vscode-cdn.net/…/wavecrux-web/">
```

Every URL Flutter's loader builds goes through `new URL(path, document.baseURI)`,
so this does resolve every asset correctly. **And it breaks the app.** A webview
document's origin is `vscode-webview://<id>`, while its files are served from
`https://file+.vscode-resource.vscode-cdn.net`. Flutter's browser-history
integration then calls `history.replaceState` with a URL resolved against the
*new* base — a different origin from the document — and the browser throws:

```
SecurityError: Failed to execute 'replaceState' on 'History': A history state
object with URL 'https://file+.vscode-resource.vscode-cdn.net/index.html?id=…'
cannot be created in a document with origin 'vscode-webview://0rlv…'
```

That exception escapes into app startup, and a release build answers an
exception with `RenderErrorBox` — **a plain grey rectangle**. From the outside
it is indistinguishable from "the webview never loaded". The app's retry loop
(400 ms doubling to a 6.4 s cap) produces one `Uncaught` per attempt with an
empty `message`, because dart2js throws Dart objects rather than `Error`s.

**Fix:** set no `<base>` tag at all — `document.baseURI` stays same-origin and
history works — and configure Flutter's loader explicitly instead:

```js
_flutter.buildConfig = { …extracted from this build… };
_flutter.loader.load({
  nonce: '…',
  config: {
    entrypointBaseUrl: '<resourceBase>/',
    canvasKitBaseUrl:  '<resourceBase>/canvaskit/',
    assetBase:         '<resourceBase>/'
  }
});
```

This is why the shim loads `flutter.js` rather than `flutter_bootstrap.js`: the
generated bootstrap ends with a bare `_flutter.loader.load()` and offers no way
to pass `config`. `_flutter.buildConfig` carries the engine revision, so it is
extracted per build by `tool/build-wavecrux-web.mjs` into
`flutter-build-config.json` and inlined by the shim. The CSP says
`base-uri 'none'`, which makes the mistake unrepeatable.

### 3.2 `asWebviewUri().toString()` is double-encoded for Dart

`Uri.toString()` renders the webview authority as
`file%2B.vscode-resource.vscode-cdn.net`. A browser tolerates it — URL parsing
percent-decodes the host, which is exactly why CanvasKit loads fine from such a
URL while the app does not. Dart does not: the engine re-parses `assetBase`,
re-encodes the `%`, and fetches from `file%252B.vscode-resource.vscode-cdn.net`,
a host that does not exist. Symptom: a failed fetch of
`assets/FontManifest.json` and an app that never reaches its first frame
(`views=0`, no `flutter-view` at all).

**Fix:** `webviewResourceBase()` in `panel.ts` percent-decodes only the
*authority*. `toString(true)` would also fix it and would additionally
un-encode the path, breaking any user whose extension lives under a directory
with a space.

### 3.3 CanvasKit from the CDN

`--no-web-resources-cdn` (§1) plus a `connect-src` that names no CDN origin.
The build script refuses a build config without `useLocalCanvasKit: true`, so
this cannot regress quietly.

---

## 4. The CSP

```
default-src 'none'; base-uri 'none'; script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data: blob:; font-src ${cspSource} https://fonts.gstatic.com data:; connect-src ${cspSource} https://fonts.gstatic.com data: blob:; worker-src blob:
```

`${cspSource}` is `webview.cspSource`; `${nonce}` is per-render. The source of
truth is `buildContentSecurityPolicy` in `html.ts`.

- `base-uri 'none'` — the shim sets no `<base>` tag (§3.1), so forbidding one
  costs nothing and closes the injection that would silently re-break history.
- `script-src` needs **both** the host source and the nonce: the nonce covers
  the shim's inline blocks, and the host source covers the `<script>` tags
  Flutter's loader injects for `main.dart.js` and `canvaskit.js` (the nonce
  passed to `load()` reaches the entrypoint tag, not CanvasKit's).
- `'wasm-unsafe-eval'` is required by CanvasKit, wellen, and lxt2fst. Without it
  the failure surfaces as a WebAssembly compilation error, not a CSP one.
- `style-src 'unsafe-inline'` is not optional: Flutter injects a `<style>`
  element for its `flt-*` defaults and exposes no hook to nonce it. This is the
  only directive that cannot be tightened from the host side.
- **`https://fonts.gstatic.com` is the one external origin.** It is not the
  CanvasKit CDN — `--no-web-resources-cdn` removed that. A
  `--no-web-resources-cdn` build stages
  `assets/fonts/fallback/Roboto-Regular.ttf` and lists it in
  `FontManifest.json`, so ordinary text renders from the payload. The origin
  serves the engine's **glyph fallback**: `fontFallbackBaseUrl` defaults to
  `https://fonts.gstatic.com/s/` and the shim does not override it, so text
  Roboto cannot draw — CJK included — is fetched at runtime. Removing the
  origin means pointing `fontFallbackBaseUrl` at bundled fonts, or accepting
  that uncovered glyphs do not render offline; it has not been measured with
  the origin removed.
- `worker-src blob:` is unused by the dart2js/CanvasKit build (only skwasm
  spawns a Blob worker) and is kept so a renderer switch fails in a test rather
  than at a user's desk.

---

## 5. Which CanvasKit variant loads, and what is staged

**`canvaskit/chromium/canvaskit.{js,wasm}`** — about 5.6 MB of the payload.

Determined by observation, not by size. The shim wraps `window.fetch` and posts
every engine resource URL to the host; every run reports exactly one:

```
[+18ms] resource url=…/media/wavecrux-web/canvaskit/chromium/canvaskit.wasm
```

That matches the loader's own rule — it appends `chromium/` when the browser has
Chromium break iterators (`Intl.v8BreakIterator` + `Intl.Segmenter`) and
`ImageDecoder`, which an Electron-hosted webview always has — but the rule is
the explanation, not the evidence.

Everything else under `canvaskit/` is unreachable for this build:
`_flutter.buildConfig.builds` has one usable entry,
`{compileTarget: dart2js, renderer: canvaskit}` (newer toolchains append an
empty `{}` the loader never reaches, because it takes the first compatible
build), so the `skwasm`, `skwasm_heavy` and `wimp` variants (only selectable
for a `dart2wasm` build) can never be chosen, and the `webparagraph` variant
(`experimental_webparagraph` on some toolchains) is chosen only when the loader
config sets `preferWebParagraph`, which the shim does not. The full
(non-Chromium) `canvaskit/canvaskit.wasm` is also dropped: this extension is
desktop-only, so the webview is always Electron. **If the pack ever gains a
browser entry point, that variant has to come back** or the panel 404s — the
shim's `resource-failed` diagnostic will say so out loud.

Staging also drops every `*.symbols` and `*.map` file (~6 MB, never fetched at
runtime). The staged payload is an allowlist (`TOP_LEVEL_KEEP` and
`CANVASKIT_KEEP` in `tool/build-wavecrux-web.mjs`), so anything a future
Flutter release starts emitting is left out until someone decides it belongs —
the failure mode is a visible 404 in the shim's diagnostics, not a silently
fatter VSIX.

---

## 6. Building and checking the payload

```bash
node tool/build-wavecrux-web.mjs          # flutter build + prune + stage
pnpm --filter wavecrux run build          # esbuild the extension
```

Then F5 → "WaveCrux: Run Extension", and either open a `.vcd` from the
Explorer or run **EDACrux: Open Waveform Panel** from the Command Palette.

`node tool/build-wavecrux-web.mjs --check` proves the staged payload is
**complete** — the eight files the webview cannot boot without are present —
and the package script runs it first, so a VSIX with an empty `media/` cannot
be built. It does **not** prove the payload is **current**: nothing compares the
staged build with the WaveCrux checkout, so a VSIX packaged over an old staging
silently ships an old app. Re-run the full build (or `--skip-flutter` after a
fresh `flutter build web`) before packaging a release; the staged
`version.json` names the WaveCrux version it came from. The staged directory is
gitignored — it is a build artifact, and `media/` is also excluded from ESLint
since it is generated third-party output.

`extension.ts` documents three environment variables that exist only for
scripted verification runs: `CRUX_WEBVIEW_DIAGNOSTIC_LOG` (also write every
webview diagnostic to a file), `CRUX_WEBVIEW_AUTO_OPEN` (open the panel on
activation) and `CRUX_WAVEFORM_AUTO_OPEN` (open a comma-separated list of
waveform paths in the custom editor). Unset in normal use.

Continuous integration cannot stage the payload today — that needs a Flutter
toolchain and a WaveCrux checkout on the runner — so `wavecrux` is absent from
CI's `package` matrix,
and the release workflow's `package-wavecrux` job fails loudly rather than
publishing a VSIX without a viewer (see the comments in
`.github/workflows/release.yml`).
