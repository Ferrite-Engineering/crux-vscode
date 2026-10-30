import * as vscode from 'vscode';
import {
  createNonce,
  renderNoticeHtml,
  renderPreviewHtml,
  webviewResourceBase,
  type NoticePage,
} from './html';

/** Where `tool/build-netcrux-web.mjs` stages the web viewer, under the extension root. */
export const WEB_PAYLOAD_DIRECTORY = ['media', 'netcrux-web'] as const;

/** Name of the file the build tool writes beside the payload, carrying `_flutter.buildConfig`. */
export const BUILD_CONFIG_FILE = 'flutter-build-config.json';

/** Sink for the page's diagnostics: the output channel, in the extension. */
export interface DiagnosticSink {
  append(line: string): void;
}

/** Absolute URI of the staged viewer. */
export function webPayloadUri(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...WEB_PAYLOAD_DIRECTORY);
}

/**
 * Read `_flutter.buildConfig` for the staged build, or `undefined` when the
 * payload is not there. It is the last file the build tool writes, so its
 * presence means the copy finished.
 */
async function readBuildConfig(payloadUri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(payloadUri, BUILD_CONFIG_FILE));
    // Parsed and re-serialised: the text is inlined into a script, so it must be
    // known-good JSON and not, say, a truncated write.
    return JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

/**
 * Put the viewer into [webview]. Returns `false` when the payload is not
 * staged, having rendered the explanation instead.
 *
 * Everything the render needs is read before the webview is touched, so
 * `options` and `html` are assigned in the same tick: a custom editor's panel
 * arrives with scripts disabled, assigning options is a change, and a change
 * makes VS Code rebuild the frame.
 */
export async function renderViewer(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  sink: DiagnosticSink,
): Promise<boolean> {
  const payloadUri = webPayloadUri(extensionUri);
  const buildConfigJson = await readBuildConfig(payloadUri);
  if (buildConfigJson === undefined) {
    renderNotice(
      webview,
      {
        title: vscode.l10n.t('The NetCrux viewer is missing'),
        message: vscode.l10n.t(
          'This build of the extension has no schematic viewer in it. Reinstall NetCrux from the Marketplace or Open VSX.',
        ),
        actions: [],
      },
    );
    sink.append('!! web payload missing: run node tool/build-netcrux-web.mjs');
    return false;
  }
  webview.options = { enableScripts: true, localResourceRoots: [payloadUri] };
  const baseUri = webviewResourceBase(webview.asWebviewUri(payloadUri).toString());
  webview.html = renderPreviewHtml({
    baseUri,
    buildConfigJson,
    cspSource: webview.cspSource,
    nonce: createNonce(),
    title: vscode.l10n.t('NetCrux'),
    loadingLabel: vscode.l10n.t('Loading the schematic viewer…'),
  });
  sink.append(`   resource base: ${baseUri}/`);
  return true;
}

/** Show a notice in place of the viewer. */
export function renderNotice(webview: vscode.Webview, page: NoticePage): void {
  webview.options = { enableScripts: true, localResourceRoots: [] };
  webview.html = renderNoticeHtml(page, webview.cspSource, createNonce());
}
