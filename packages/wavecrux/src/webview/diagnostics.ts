/**
 * Parsing and formatting for the messages the webview shim posts back.
 *
 * Split out from the panel so the shape check is testable without an
 * extension host, and so the panel has exactly one place that decides what
 * counts as a diagnostic. Webview input is untrusted (it is the same trust
 * boundary host-core's `recordFromWebview` guards): everything here validates
 * before it reads.
 */
import { DIAGNOSTIC_MESSAGE_TYPE } from './html';

/**
 * The kinds the shim emits today: `boot`, `error`, `unhandledrejection`,
 * `csp-violation`, `resource`, `resource-failed`, `first-frame`,
 * `first-frame-timeout`, `pointerdown`, `keydown`.
 *
 * Typed as a bare `string` on purpose. A union would tempt the parser into
 * rejecting a kind it has not heard of, and the one thing this channel must
 * never do is swallow a report of a failure mode nobody anticipated.
 */
export type DiagnosticKind = string;

export interface WebviewDiagnostic {
  readonly kind: DiagnosticKind;
  /** Milliseconds since the shim's boot mark, per the webview's own clock. */
  readonly atMs: number;
  readonly detail: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the diagnostic if `raw` is one, else `undefined`. Anything that is
 * not shaped like a diagnostic — including a message meant for some other
 * channel — is rejected rather than coerced.
 */
export function parseDiagnostic(raw: unknown): WebviewDiagnostic | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw['type'] !== DIAGNOSTIC_MESSAGE_TYPE) return undefined;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || kind.length === 0) return undefined;
  const atMs = raw['atMs'];
  const detail = raw['detail'];
  return {
    kind,
    atMs: typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : 0,
    detail: isRecord(detail) ? detail : {},
  };
}

/** Kinds that mean something is wrong, not merely something happened. */
const FAILURE_KINDS = new Set([
  'error',
  'unhandledrejection',
  'csp-violation',
  'resource-failed',
  'first-frame-timeout',
]);

export function isFailure(diagnostic: WebviewDiagnostic): boolean {
  return FAILURE_KINDS.has(diagnostic.kind);
}

/** One line per diagnostic, stable enough to grep from a terminal. */
export function formatDiagnostic(diagnostic: WebviewDiagnostic): string {
  const marker = isFailure(diagnostic) ? '!!' : '  ';
  const detail = Object.entries(diagnostic.detail)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `${marker} [+${diagnostic.atMs}ms] ${diagnostic.kind}${detail ? ` ${detail}` : ''}`;
}

/**
 * The cold-start number, in milliseconds, if this diagnostic carries one.
 *
 * Measured inside the webview between the shim's first statement and
 * Flutter's `flutter-first-frame` event — the two moments that bracket
 * everything the extension controls. Anything the host measured instead
 * would include VSCode's own panel setup and would not be comparable to the
 * browser build.
 */
export function coldStartMs(diagnostic: WebviewDiagnostic): number | undefined {
  if (diagnostic.kind !== 'first-frame') return undefined;
  const value = diagnostic.detail['coldStartMs'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
