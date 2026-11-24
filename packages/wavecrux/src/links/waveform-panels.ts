/**
 * Which waveform tab a link lands in, and when it can be asked to select.
 *
 * A link opens its file with `vscode.openWith`, which focuses the tab when
 * the file is already open, and then has to talk to **that** tab's panel: the
 * window may hold several waveforms, and the inbound-highlight stack in
 * `extension.ts` only knows the most recent one. So each panel registers here
 * under its file, and the link waits for its own.
 *
 * A panel can be asked once its waveform has loaded, not merely once the
 * bytes were posted: a highlight that arrives while the app is still parsing
 * would be answered against an empty viewer. The app acknowledges every
 * waveform it is handed with `request_open_artifact_ack` after it has opened
 * it (`EditorHostBridge._openWaveform`), and [WaveformLoadWatch] is what hears
 * that.
 *
 * No `vscode` import: everything here is driven by tests.
 */
import type { WebviewHighlightAnswer, WebviewHighlightRequest } from '../webview/highlight-bridge';

/** The kind the app acknowledges a delivered waveform with. */
export const OPEN_ARTIFACT_ACK_KIND = 'request_open_artifact_ack';

/** How long a link waits for its tab to appear and its waveform to load. */
export const LINK_LOAD_TIMEOUT_MS = 60_000;

/** Where a panel's waveform stands, as a link sees it. */
export type WaveformLoadState = 'loaded' | 'failed' | 'gone' | 'timeout';

type Schedule = (run: () => void, delayMs: number) => () => void;

const defaultSchedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};

/** Hears the app say that the waveform it was handed is open, or is not. */
export class WaveformLoadWatch {
  private state: 'pending' | 'loaded' | 'failed' | 'gone' = 'pending';
  private readonly waiters = new Set<(state: WaveformLoadState) => void>();

  constructor(private readonly schedule: Schedule = defaultSchedule) {}

  /** The bytes are being sent again (a context release came back): wait for the next answer. */
  reset(): void {
    if (this.state !== 'gone') this.state = 'pending';
  }

  /** The panel shows a notice instead of the app (empty, too large): nothing will load. */
  markFailed(): void {
    this.settle('failed');
  }

  /** The panel is gone. Every wait ends `gone`. */
  close(): void {
    this.settle('gone');
  }

  /** Claims the app's acknowledgement of a delivered waveform. Returns whether it was one. */
  accept(envelope: unknown): boolean {
    if (typeof envelope !== 'object' || envelope === null) return false;
    const { kind, payload } = envelope as { kind?: unknown; payload?: unknown };
    if (kind !== OPEN_ARTIFACT_ACK_KIND) return false;
    const honored =
      typeof payload === 'object' && payload !== null && (payload as { honored?: unknown }).honored === true;
    this.settle(honored ? 'loaded' : 'failed');
    return true;
  }

  /** Resolves once the waveform is loaded or failed, the panel is gone, or [timeoutMs] passes. */
  wait(timeoutMs: number = LINK_LOAD_TIMEOUT_MS): Promise<WaveformLoadState> {
    if (this.state !== 'pending') return Promise.resolve(this.state);
    return new Promise((resolve) => {
      let cancel = (): void => {};
      const waiter = (state: WaveformLoadState): void => {
        this.waiters.delete(waiter);
        cancel();
        resolve(state);
      };
      this.waiters.add(waiter);
      cancel = this.schedule(() => waiter('timeout'), timeoutMs);
    });
  }

  private settle(state: 'loaded' | 'failed' | 'gone'): void {
    this.state = state;
    for (const waiter of [...this.waiters]) waiter(state);
  }
}

/** One waveform tab, as a link sees it. */
export interface WaveformLinkPanel {
  readonly highlights: { request(request: WebviewHighlightRequest): Promise<WebviewHighlightAnswer> };
  readonly load: Pick<WaveformLoadWatch, 'wait'>;
}

/**
 * [fsPath] as the registry compares it: case folded where the filesystem
 * folds case, which is where VS Code treats two spellings as one document.
 */
export function waveformPanelKey(fsPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' || platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/** The open waveform panels, by file. */
export class WaveformPanelRegistry {
  private readonly panels = new Map<string, WaveformLinkPanel>();
  private readonly waiters = new Map<string, Set<(panel: WaveformLinkPanel) => void>>();

  constructor(private readonly schedule: Schedule = defaultSchedule) {}

  /** Register [panel] under [key]; call the result when the panel closes. */
  adopt(key: string, panel: WaveformLinkPanel): () => void {
    this.panels.set(key, panel);
    for (const waiter of [...(this.waiters.get(key) ?? [])]) waiter(panel);
    return () => {
      if (this.panels.get(key) === panel) this.panels.delete(key);
    };
  }

  /** The panel for [key], waiting up to [timeoutMs] for it to be created. */
  waitFor(key: string, timeoutMs: number = LINK_LOAD_TIMEOUT_MS): Promise<WaveformLinkPanel | undefined> {
    const existing = this.panels.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set();
      this.waiters.set(key, set);
      let cancel = (): void => {};
      const finish = (panel: WaveformLinkPanel | undefined): void => {
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(key);
        cancel();
        resolve(panel);
      };
      const waiter = (panel: WaveformLinkPanel): void => finish(panel);
      set.add(waiter);
      cancel = this.schedule(() => finish(undefined), timeoutMs);
    });
  }
}

/** What a link did once its file was open. */
export type WaveformPlacement =
  /** No signal and no time: the file is open, which is all the link asked. */
  | { readonly kind: 'opened' }
  /** The signal is added and selected, and the cursor is at the link's time when it gave one. */
  | { readonly kind: 'selected' }
  /** The signal is selected, but the app moved or did not place the cursor; [detail] is its reason. */
  | { readonly kind: 'time-not-exact'; readonly detail: string }
  /** The waveform has no such signal. */
  | { readonly kind: 'signal-not-found' }
  /** A time with no signal: the editor panel places the cursor only through a signal. */
  | { readonly kind: 'time-needs-signal' }
  /** The app could not read the file; its tab says why. */
  | { readonly kind: 'load-failed' }
  /** No panel, no load, or no answer in time. */
  | { readonly kind: 'not-answered' };

/**
 * Select the link's signal and place the cursor, in [panel] (`undefined` when
 * its tab never appeared).
 *
 * The highlight is the same one a CXP peer sends (`request_highlight`), so
 * the app resolves the signal and places the cursor exactly as it does for a
 * peer: the signal is added if it is not shown, selected, and the cursor goes
 * to `time` (or, in an app that reads only the older key, `crux.time_ps`).
 */
export async function placeWaveCruxLink(
  link: { readonly signal?: string; readonly time?: string; readonly timePs?: number },
  panel: WaveformLinkPanel | undefined,
  timeoutMs: number = LINK_LOAD_TIMEOUT_MS,
): Promise<WaveformPlacement> {
  if (link.signal === undefined) {
    return link.time === undefined ? { kind: 'opened' } : { kind: 'time-needs-signal' };
  }
  if (panel === undefined) return { kind: 'not-answered' };
  const load = await panel.load.wait(timeoutMs);
  if (load === 'failed') return { kind: 'load-failed' };
  if (load !== 'loaded') return { kind: 'not-answered' };
  const answer = await panel.highlights.request({
    element: { kind: 'signal', path: link.signal },
    metadata: link.timePs !== undefined ? { 'crux.time_ps': link.timePs } : {},
    ...(link.time !== undefined ? { time: link.time } : {}),
  });
  switch (answer.outcome) {
    case 'honored':
      return link.time !== undefined && answer.detail !== undefined
        ? { kind: 'time-not-exact', detail: answer.detail }
        : { kind: 'selected' };
    case 'refused':
      return { kind: 'signal-not-found' };
    default:
      return { kind: 'not-answered' };
  }
}
