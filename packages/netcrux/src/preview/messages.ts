/**
 * What the extension and the NetCrux web viewer say to each other.
 *
 * Every frame is a flat object `{type: 'crux.netcrux', protocol: 1, kind, ...}`.
 * The names here are the other half of the contract in the viewer's
 * `lib/services/host_bridge/host_bridge_messages.dart`: a rename on one side is
 * silent (the viewer reports no host, or drops every frame), so each is a
 * constant and a test pins the strings.
 *
 * Frames coming from the page are untrusted. [parseWebviewMessage] validates the
 * shape of everything it reads and returns `undefined` for anything else.
 */

/** `type` of every frame crossing the bridge, in both directions. */
export const FRAME_TYPE = 'crux.netcrux';

/** The protocol version this extension speaks. */
export const PROTOCOL_VERSION = 1;

/** The global the page shim sets, frozen, before the viewer's entry point runs. */
export const EDITOR_HOST_MARKER_GLOBAL = 'cruxEditorHost';

/** The global the page shim publishes for the viewer's outbound frames. */
export const HOST_BRIDGE_SEAM_GLOBAL = 'cruxHostBridge';

/** The global holding the URL of the layout worker the shim staged. */
export const LAYOUT_WORKER_GLOBAL = 'cruxLayoutWorkerUrl';

/** Value of `cruxEditorHost.kind` for this extension host. */
export const EDITOR_HOST_KIND = 'vscode';

/** Host to viewer: open a netlist. */
export const OPEN_NETLIST_KIND = 'open_netlist';

/** Host to viewer: the editor's colors. */
export const THEME_TOKENS_KIND = 'theme_tokens';

/** Viewer to host: its listener is installed. */
export const READY_KIND = 'ready';

/** Viewer to host: show a source location. */
export const OPEN_SOURCE_KIND = 'open_source';

/** Viewer to host: where the document stands. */
export const STATUS_KIND = 'status';

/** `type` of a diagnostic the page shim posts. */
export const DIAGNOSTIC_TYPE = 'crux.webview.diagnostic';

/** `type` of a click on a notice page's button. */
export const NOTICE_ACTION_TYPE = 'crux.notice.action';

/** The buttons a notice page can carry. */
export type NoticeAction = 'open-in-netcrux' | 'open-as-text' | 'change-size-limit';

const NOTICE_ACTIONS: ReadonlySet<string> = new Set<NoticeAction>([
  'open-in-netcrux',
  'open-as-text',
  'change-size-limit',
]);

/** The longest file name or message accepted from the page. */
const MAX_TEXT = 4096;

/** The frame that hands the viewer a netlist. */
export interface OpenNetlistFrame {
  readonly type: typeof FRAME_TYPE;
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly kind: typeof OPEN_NETLIST_KIND;
  readonly name: string;
  readonly text: string;
}

/** Build the frame that opens [text] as a netlist labelled [name]. */
export function openNetlistFrame(name: string, text: string): OpenNetlistFrame {
  return { type: FRAME_TYPE, protocol: PROTOCOL_VERSION, kind: OPEN_NETLIST_KIND, name, text };
}

/** One diagnostic from the page shim. */
export interface WebviewDiagnostic {
  readonly kind: string;
  readonly atMs: number;
  readonly detail: Record<string, unknown>;
}

/** A message from the page, validated. */
export type WebviewMessage =
  | { readonly type: 'diagnostic'; readonly diagnostic: WebviewDiagnostic }
  | { readonly type: 'ready' }
  | {
      readonly type: 'open-source';
      readonly file: string;
      readonly line: number;
      readonly column: number | undefined;
    }
  | {
      readonly type: 'status';
      readonly phase: 'loading' | 'loaded' | 'failed';
      readonly message: string | undefined;
      readonly modules: number | undefined;
      readonly cells: number | undefined;
    }
  | { readonly type: 'notice-action'; readonly action: NoticeAction };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1e9
    ? value
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e12
    ? value
    : undefined;
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
}

/** Validate a raw message from the page, or return `undefined` for anything unreadable. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isRecord(raw)) return undefined;

  if (raw['type'] === DIAGNOSTIC_TYPE) {
    const kind = shortText(raw['kind']);
    const atMs = raw['atMs'];
    if (kind === undefined || typeof atMs !== 'number') return undefined;
    const detail = isRecord(raw['detail']) ? raw['detail'] : {};
    return { type: 'diagnostic', diagnostic: { kind, atMs, detail } };
  }

  if (raw['type'] === NOTICE_ACTION_TYPE) {
    const action = raw['action'];
    return typeof action === 'string' && NOTICE_ACTIONS.has(action)
      ? { type: 'notice-action', action: action as NoticeAction }
      : undefined;
  }

  if (raw['type'] !== FRAME_TYPE) return undefined;
  const protocol = raw['protocol'];
  if (typeof protocol !== 'number' || protocol < 1) return undefined;

  switch (raw['kind']) {
    case READY_KIND:
      return { type: 'ready' };
    case OPEN_SOURCE_KIND: {
      const file = shortText(raw['file']);
      const line = positiveInt(raw['line']);
      if (file === undefined || file.trim().length === 0 || line === undefined) return undefined;
      return { type: 'open-source', file, line, column: positiveInt(raw['column']) };
    }
    case STATUS_KIND: {
      const phase = raw['phase'];
      if (phase !== 'loading' && phase !== 'loaded' && phase !== 'failed') return undefined;
      return {
        type: 'status',
        phase,
        message: shortText(raw['message']),
        modules: count(raw['modules']),
        cells: count(raw['cells']),
      };
    }
    default:
      return undefined;
  }
}

/** One line for the output channel describing a diagnostic. */
export function formatDiagnostic(diagnostic: WebviewDiagnostic): string {
  const detail = Object.entries(diagnostic.detail)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `   [+${diagnostic.atMs}ms] ${diagnostic.kind}${detail.length > 0 ? ` ${detail}` : ''}`;
}

/** Whether a diagnostic reports something that went wrong. */
export function isFailure(diagnostic: WebviewDiagnostic): boolean {
  return (
    diagnostic.kind === 'error' ||
    diagnostic.kind === 'unhandledrejection' ||
    diagnostic.kind === 'csp-violation' ||
    diagnostic.kind === 'loader-failed' ||
    diagnostic.kind === 'layout-worker-failed' ||
    diagnostic.kind === 'resource-failed' ||
    diagnostic.kind === 'first-frame-timeout'
  );
}
