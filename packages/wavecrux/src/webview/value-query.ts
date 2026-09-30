/**
 * Asking the webview what the signals on screen are worth.
 *
 * The host draws the decorations; the app owns the waveform, the cursor, the
 * per-signal radix and the translators. So RTL annotation needs one question to cross
 * the bridge, and this module is the host's half of it. No `vscode` import,
 * so every bound below is testable without an extension host.
 *
 * ### A standing query, and why the host does not poll
 *
 * The obvious protocol is request/response per cursor move. The host cannot
 * implement it: it has no way to know the cursor moved, because the cursor
 * is the app's. Polling would either lag a drag or spend a frame budget
 * asking a question whose answer usually has not changed.
 *
 * So the most recent query *stands*. The app answers it now and again on
 * every debounced cursor move, until a later query replaces the path list.
 * That puts the cursor-follow debounce on the side that owns the cursor —
 * `kHostAnnotationCursorDebounce`, deliberately equal to the CXP emitter's,
 * so the editor and a peer app never disagree about where the cursor is.
 *
 * ### The re-render loop, and how it is broken
 *
 * An unsolicited response makes the host re-render, which re-resolves the
 * viewport, which asks for values again — a loop that would post a frame per
 * cursor tick forever. [WebviewValueSource.valuesAt] breaks it: a request
 * for the **same path list** as the standing query is answered from the last
 * snapshot without posting anything. Only a genuinely different viewport
 * costs a frame. This is the single most important behaviour in the file and
 * it has its own test.
 */
import type { annotate } from '@crux-vscode/host-core';
import { hostBridgeFrame, type HostBridgeFrame } from './open-waveform';

/** Mirrors `kHostBridgeValueQueryKind`. */
export const VALUE_QUERY_KIND = 'crux.value_query';

/** Mirrors `kHostBridgeValueResponseKind`. */
export const VALUE_RESPONSE_KIND = 'crux.value_response';

/** Mirrors `kHostBridgeMaxValueQueryPaths`. Both sides enforce it. */
export const MAX_VALUE_QUERY_PATHS = 256;

/**
 * How long to wait for a first answer before rendering nothing.
 *
 * Generous, because the app may have to *load* a signal the user never added
 * to the viewer before it can sample it, and a cold FST signal load is not
 * instant. Nothing is blocked while this runs — the editor is responsive and
 * the decorations simply have not appeared yet.
 */
export const VALUE_QUERY_TIMEOUT_MS = 4_000;

/** The frame that opens (or replaces) the standing query. */
export function valueQueryFrame(options: {
  readonly queryId: string;
  readonly paths: readonly string[];
}): HostBridgeFrame {
  return hostBridgeFrame({
    kind: VALUE_QUERY_KIND,
    payload: { query_id: options.queryId, paths: [...options.paths] },
  });
}

/** A decoded `crux.value_response` payload. */
export interface ValueResponse {
  readonly queryId: string;
  readonly values: ReadonlyMap<string, string>;
  readonly cursorLabel?: string;
}

/**
 * Decode an inbound CXP envelope as a value response, or `undefined`.
 *
 * Every field is validated because a webview's messages are untrusted input
 * in exactly the way a peer's are — and because a malformed response that
 * was *partially* believed would put wrong values into someone's source
 * file, which is the failure this whole feature is designed around.
 */
export function parseValueResponse(envelope: unknown): ValueResponse | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const { kind, payload } = envelope as { kind?: unknown; payload?: unknown };
  if (kind !== VALUE_RESPONSE_KIND) return undefined;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { query_id: queryId, values: rawValues, cursor_label: cursorLabel } = payload as {
    query_id?: unknown;
    values?: unknown;
    cursor_label?: unknown;
  };
  if (typeof queryId !== 'string' || queryId.length === 0) return undefined;
  if (typeof rawValues !== 'object' || rawValues === null) return undefined;
  const values = new Map<string, string>();
  for (const [path, value] of Object.entries(rawValues as Record<string, unknown>)) {
    // A non-string value is dropped, not fatal: one signal the app could not
    // render must not cost the other thirty-nine their annotations.
    if (typeof value === 'string' && value.length > 0) values.set(path, value);
  }
  return {
    queryId,
    values,
    ...(typeof cursorLabel === 'string' && cursorLabel.length > 0 ? { cursorLabel } : {}),
  };
}

/** What [WebviewValueSource] needs from the panel it speaks for. */
export interface WebviewValueSourceOptions {
  /** Post a frame into the webview. `Webview.postMessage`. */
  readonly post: (frame: HostBridgeFrame) => PromiseLike<boolean> | boolean;
  /**
   * Called when the app answered *without being asked* — i.e. the waveform
   * cursor moved. The surface re-renders the visible editors; it must not
   * issue a new query, and [valuesAt] makes sure re-rendering does not.
   */
  readonly onCursorMoved?: () => void;
  /** Timeout seam. Defaults to [VALUE_QUERY_TIMEOUT_MS]. */
  readonly timeoutMs?: number;
  /** Timer seam, for tests. Defaults to `setTimeout`/`clearTimeout`. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

const EMPTY_SNAPSHOT: annotate.SignalValueSnapshot = { values: new Map<string, string>() };

/**
 * The waveform in one webview panel, as `annotate/` wants to see it.
 *
 * One per open waveform tab. `isReady` is false until the panel has been
 * told a waveform is on the way and false again once it is disposed, so a
 * window with a stale tab never annotates from a dead panel.
 */
export class WebviewValueSource implements annotate.SignalValueSource {
  constructor(private readonly options: WebviewValueSourceOptions) {}

  private queryId: string | undefined;
  private queryPaths: readonly string[] = [];
  private snapshot: annotate.SignalValueSnapshot | undefined;
  private pending: ((snapshot: annotate.SignalValueSnapshot) => void) | undefined;
  private cancelTimeout: (() => void) | undefined;
  private ready = false;
  private nextQuery = 0;

  /** Mark the panel as able to answer — called once the bytes are posted. */
  open(): void {
    this.ready = true;
  }

  /** Mark the panel as gone. Any pending query resolves empty. */
  close(): void {
    this.ready = false;
    this.queryId = undefined;
    this.queryPaths = [];
    this.snapshot = undefined;
    this.settle(EMPTY_SNAPSHOT);
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Values for [paths] at the app's current cursor.
   *
   * Answered from the last snapshot when [paths] matches the standing query,
   * which is what stops an unsolicited cursor update from provoking a fresh
   * query and looping. Otherwise the standing query is replaced and the
   * first answer to it is awaited.
   */
  async valuesAt(
    paths: readonly string[],
    cancellation: annotate.AnnotationCancellation,
  ): Promise<annotate.SignalValueSnapshot> {
    if (!this.ready || paths.length === 0) return EMPTY_SNAPSHOT;
    const snapshot = this.snapshot;
    if (snapshot !== undefined && sameOrder(paths, this.queryPaths)) return snapshot;

    const queryId = `wsh-${(this.nextQuery += 1)}`;
    this.queryId = queryId;
    this.queryPaths = [...paths].slice(0, MAX_VALUE_QUERY_PATHS);
    this.snapshot = undefined;
    this.settle(EMPTY_SNAPSHOT);

    const answered = new Promise<annotate.SignalValueSnapshot>((resolve) => {
      this.pending = resolve;
    });
    this.cancelTimeout = (this.options.schedule ?? defaultSchedule)(() => {
      // A silent app is not an error worth surfacing: the editor stays
      // responsive and the decorations simply do not appear.
      this.settle(EMPTY_SNAPSHOT);
    }, this.options.timeoutMs ?? VALUE_QUERY_TIMEOUT_MS);

    await this.options.post(valueQueryFrame({ queryId, paths: this.queryPaths }));
    if (cancellation.isCancelled()) return EMPTY_SNAPSHOT;
    return await answered;
  }

  /**
   * Route one inbound CXP envelope. Returns whether it was a value response.
   *
   * A response to a superseded query is ignored: the host has already moved
   * on, and rendering it would paint the previous viewport's values.
   */
  accept(envelope: unknown): boolean {
    const response = parseValueResponse(envelope);
    if (response === undefined) return false;
    if (response.queryId !== this.queryId) return true;
    const snapshot: annotate.SignalValueSnapshot = {
      values: response.values,
      ...(response.cursorLabel !== undefined ? { cursorLabel: response.cursorLabel } : {}),
    };
    this.snapshot = snapshot;
    const wasPending = this.pending !== undefined;
    this.settle(snapshot);
    // Unsolicited: the cursor moved. Nothing is waiting, so the host has to
    // be told to re-render.
    if (!wasPending) this.options.onCursorMoved?.();
    return true;
  }

  private settle(snapshot: annotate.SignalValueSnapshot): void {
    this.cancelTimeout?.();
    this.cancelTimeout = undefined;
    const pending = this.pending;
    this.pending = undefined;
    pending?.(snapshot);
  }
}

/** Same paths in the same order — the cheap identity the loop-break needs. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

const defaultSchedule = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};
