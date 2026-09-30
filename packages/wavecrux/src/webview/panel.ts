import * as vscode from 'vscode';
import {
  createNonce,
  renderWebviewHtml,
} from './html';
import {
  coldStartMs,
  formatDiagnostic,
  isFailure,
  parseDiagnostic,
  type WebviewDiagnostic,
} from './diagnostics';

/**
 * The document-less panel: one webview hosting the WaveCrux Flutter web
 * build, behind `wavecrux.openPanel`.
 *
 * Deliberately a plain `WebviewPanel` and not a `CustomEditorProvider` — the
 * document-backed editor is `editor/waveform-editor.ts`. The view type's
 * value is historical (this panel was the first thing that hosted the
 * build) and is kept as-is so it stays stable.
 */
export const WAVECRUX_PANEL_VIEW_TYPE = 'wavecrux.spikePanel';

/** Where `tool/build-wavecrux-web.mjs` stages the Flutter payload. */
export const WEB_PAYLOAD_DIRECTORY = ['media', 'wavecrux-web'] as const;

/** Sink for shim diagnostics. The extension supplies an output channel; a
 * scripted verification run additionally supplies a file writer so a headless run can be
 * read from a terminal. */
export interface DiagnosticSink {
  append(line: string): void;
}

export interface PanelDependencies {
  readonly extensionUri: vscode.Uri;
  readonly sink: DiagnosticSink;
  /**
   * Telemetry seam. Optional so the panel can run without one; in the
   * extension this is host-core's `TelemetryClient.recordFromWebview`, which
   * keeps the `isTelemetryEnabled` gate in the host where it belongs. The
   * webview must never gain a sender of its own.
   */
  readonly recordTelemetryFromWebview?: (raw: unknown) => void;
  /**
   * Every parsed diagnostic, after it has been written to the sink.
   *
   * The custom editor uses it for one thing: `first-frame` is the moment the
   * Dart side's `window` message listener is guaranteed to exist (the bridge
   * is instantiated during bootstrap, before `runApp`), so it is the earliest
   * point at which posting a waveform cannot be dropped on the floor.
   */
  readonly onDiagnostic?: (diagnostic: WebviewDiagnostic) => void;
  /**
   * Every inbound CXP envelope, offered to a router before it is logged.
   *
   * Returns `true` when the envelope was claimed. This is how RTL annotation's value
   * responses reach `WebviewValueSource` **without a second `postMessage`
   * listener** — a webview delivers messages to every registered listener,
   * so a second one would double-count telemetry relays and split the CXP
   * routing across two places that could disagree.
   *
   * A claimed envelope is not logged: the standing value query answers on
   * every cursor move, and writing a line per answer would turn the output
   * channel into a scroll of noise the moment a user drags the cursor.
   */
  readonly onCxpEnvelope?: (envelope: unknown) => boolean;
}

/** Message `type` reserved for the Dart side's telemetry relay. */
export const TELEMETRY_MESSAGE_TYPE = 'crux.telemetry';

/** Message `type` of a frame carrying a CXP envelope. Mirrors `kHostBridgeCxpFrameType`. */
export const CXP_MESSAGE_TYPE = 'crux.cxp';

/**
 * Route one inbound webview message. Exported for tests: this is where the
 * untrusted-input boundary is enforced, so it is worth exercising without an
 * extension host.
 */
export function handleWebviewMessage(raw: unknown, deps: PanelDependencies): void {
  const diagnostic = parseDiagnostic(raw);
  if (diagnostic !== undefined) {
    deps.sink.append(formatDiagnostic(diagnostic));
    const cold = coldStartMs(diagnostic);
    if (cold !== undefined) {
      deps.sink.append(`   cold start: ${cold} ms (shim boot → flutter-first-frame)`);
    }
    if (isFailure(diagnostic)) {
      // Failures are the whole point of the channel; make them visible
      // without needing the panel focused.
      console.error(`[wavecrux webview] ${formatDiagnostic(diagnostic)}`);
    }
    deps.onDiagnostic?.(diagnostic);
    return;
  }
  if (typeof raw !== 'object' || raw === null) return;
  const type = (raw as { type?: unknown }).type;
  if (type === TELEMETRY_MESSAGE_TYPE) {
    deps.recordTelemetryFromWebview?.((raw as { event?: unknown }).event);
    return;
  }
  if (type === CXP_MESSAGE_TYPE) {
    if (deps.onCxpEnvelope?.((raw as { envelope?: unknown }).envelope) === true) return;
    // Acks and errors from the Dart side. Nothing here acts on them — an
    // acknowledgement's job is to make a silent failure audible, and the
    // output channel is where that lands. `honored: false` in particular is
    // the only way "the panel opened and stayed empty" is distinguishable
    // from "the bytes never arrived".
    deps.sink.append(`   ${describeCxpFrame(raw)}`);
  }
}

/** One line describing an inbound CXP frame, shaped for the output channel. */
function describeCxpFrame(raw: unknown): string {
  const envelope = (raw as { envelope?: unknown }).envelope;
  if (typeof envelope !== 'object' || envelope === null) return 'cxp frame (no envelope)';
  const { kind, payload } = envelope as { kind?: unknown; payload?: unknown };
  const fields =
    typeof payload === 'object' && payload !== null
      ? Object.entries(payload as Record<string, unknown>)
          .filter(([key]) => key !== 'bytes' && key !== 'bytes_base64')
          .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
          .join(' ')
      : '';
  return `cxp ${typeof kind === 'string' ? kind : '?'}${fields ? ` ${fields}` : ''}`;
}

/**
 * Absolute URI of the staged Flutter payload.
 */
export function webPayloadUri(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...WEB_PAYLOAD_DIRECTORY);
}

/**
 * Put the WaveCrux Flutter build into [webview].
 *
 * Shared by the document-less panel and the custom editor so there is exactly one
 * place that knows how the payload is located, how the resource base is
 * repaired, and what the shim is handed. Returns `false` when the payload is
 * not staged, having rendered the explanation instead.
 */
export async function renderWaveCruxWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  sink: DiagnosticSink,
): Promise<boolean> {
  const payloadUri = webPayloadUri(extensionUri);
  // Everything the render needs is read BEFORE the webview is touched, so
  // `options` and `html` are assigned in the same tick.
  //
  // A `CustomEditorProvider`'s panel arrives with `enableScripts: false`, so
  // assigning options here is a *change* rather than a restatement, and a
  // change is what makes VSCode rebuild the iframe. Keeping the two
  // assignments adjacent means there is no window in which the webview exists
  // with one of them applied and not the other. (This is ordering hygiene, not
  // a fix for a bug that was observed — the blank-tab failure this code went
  // through was the awaited `resolveCustomEditor` deadlock documented in
  // `editor/waveform-editor.ts`.)
  const buildConfigJson = await readBuildConfig(payloadUri);
  if (buildConfigJson === undefined) {
    webview.options = { enableScripts: false };
    webview.html = missingPayloadHtml();
    sink.append('!! web payload missing — run node tool/build-wavecrux-web.mjs');
    return false;
  }
  webview.options = {
    enableScripts: true,
    localResourceRoots: [payloadUri],
  };
  const baseUri = webviewResourceBase(webview.asWebviewUri(payloadUri).toString());
  webview.html = renderWebviewHtml({
    baseUri,
    buildConfigJson,
    cspSource: webview.cspSource,
    nonce: createNonce(),
    title: vscode.l10n.t('WaveCrux'),
    loadingLabel: vscode.l10n.t('Loading WaveCrux…'),
  });
  sink.append(`   resource base: ${baseUri}/`);
  return true;
}

/**
 * Create (or reveal) the document-less panel.
 *
 * `retainContextWhenHidden` is on because a Flutter cold start is seconds,
 * not milliseconds: letting VSCode tear the webview down on tab switch would
 * pay that cost every time the user looked at their RTL.
 */
export async function openWaveCruxPanel(deps: PanelDependencies): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    WAVECRUX_PANEL_VIEW_TYPE,
    vscode.l10n.t('WaveCrux'),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webPayloadUri(deps.extensionUri)],
    },
  );

  panel.webview.onDidReceiveMessage((message: unknown) => {
    handleWebviewMessage(message, deps);
  });

  await renderWaveCruxWebview(panel.webview, deps.extensionUri, deps.sink);
  return panel;
}

/**
 * Percent-decode the *authority* of a webview resource URL, leaving the path
 * encoded.
 *
 * `Uri.toString()` renders the webview authority as
 * `file%2B.vscode-resource.vscode-cdn.net`. A browser tolerates that — URL
 * parsing decodes the host — but Dart does not: the engine re-parses whatever
 * we hand it as `assetBase`, and re-encoding the `%` produces
 * `file%252B.vscode-resource.vscode-cdn.net`, a host that does not exist. The
 * symptom is a failed fetch of `assets/FontManifest.json` and an app that
 * never reaches its first frame — while CanvasKit, resolved through the
 * browser's own `new URL()`, loads perfectly. Measured; see
 * docs/webview-hosting.md §3.2.
 *
 * `toString(true)` would fix the authority and also un-encode the path, so a
 * user whose extension lives under a directory with a space would break
 * instead. Decoding only the authority fixes the one thing that is wrong.
 */
export function webviewResourceBase(uri: string): string {
  return uri.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)/, (_match, scheme: string, authority: string) => {
    try {
      return scheme + decodeURIComponent(authority);
    } catch {
      return scheme + authority;
    }
  });
}

/** Name of the file tool/build-wavecrux-web.mjs writes beside the payload. */
export const BUILD_CONFIG_FILE = 'flutter-build-config.json';

/**
 * Read `_flutter.buildConfig` for the staged build, or `undefined` if the
 * payload is not there. Doubles as the "is it staged?" check: this file is
 * written last, so its presence means the copy completed.
 */
async function readBuildConfig(payloadUri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(payloadUri, BUILD_CONFIG_FILE),
    );
    const text = new TextDecoder().decode(bytes);
    // Parse and re-serialise: the file is inlined into a <script>, so it must
    // be known-good JSON and not, say, a truncated write.
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Shown instead of a blank panel when the payload was never staged — the
 * single most likely first-run mistake, and indistinguishable from a hosting
 * failure if we let it render as an empty webview.
 */
function missingPayloadHtml(): string {
  const message = vscode.l10n.t(
    'The WaveCrux web build is not staged. Run “node tool/build-wavecrux-web.mjs” in the crux-vscode repo and reopen this panel.',
  );
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
</head>
<body style="font-family: var(--vscode-font-family); padding: 24px; line-height: 1.6;">
<p>${escaped}</p>
</body></html>
`;
}
