/**
 * Which schematic preview a link lands in, and when it can be asked to select.
 *
 * A link to a Yosys JSON netlist opens it with `vscode.openWith`, which
 * focuses the preview when the netlist is open already, and then has to talk
 * to **that** preview: the window may hold several. So each preview registers
 * here under its file, and the link waits for its own.
 *
 * A preview can be asked once its netlist has loaded, not merely once the text
 * was posted: a `select` that arrives while the viewer is still reading would
 * be answered against no design. The viewer reports `status` `loading`, then
 * `loaded` or `failed`, for every netlist it is handed, and [NetlistLoadWatch]
 * is what hears that. The viewer answers each `select` with a `select_result`
 * carrying the same id, which [NetlistSelector] matches.
 *
 * WaveCrux's `waveform-panels.ts` is the same shape for its waveform tabs.
 *
 * No `vscode` import: everything here is driven by tests.
 */
import { selectFrame, type SelectElement, type SelectFrame, type SelectOutcome } from '../preview/messages';

/** How long a link waits for its preview to appear, its netlist to load, and its answer. */
export const LINK_LOAD_TIMEOUT_MS = 60_000;

/** Where a preview's netlist stands, as a link sees it. */
export type NetlistLoadState = 'loaded' | 'failed' | 'gone' | 'timeout';

type Schedule = (run: () => void, delayMs: number) => () => void;

const defaultSchedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};

/** Hears the viewer say that the netlist it was handed is open, or is not. */
export class NetlistLoadWatch {
  private state: 'pending' | 'loaded' | 'failed' | 'gone' = 'pending';
  private readonly waiters = new Set<(state: NetlistLoadState) => void>();

  constructor(private readonly schedule: Schedule = defaultSchedule) {}

  /** The viewer's `status` frame. */
  status(phase: 'loading' | 'loaded' | 'failed'): void {
    if (this.state === 'gone') return;
    if (phase === 'loading') {
      this.state = 'pending';
      return;
    }
    this.settle(phase);
  }

  /** The panel shows a notice instead of the viewer (empty, too large, not a netlist). */
  markFailed(): void {
    this.settle('failed');
  }

  /** The panel is gone. Every wait ends `gone`. */
  close(): void {
    this.settle('gone');
  }

  /** Resolves once the netlist is loaded or failed, the panel is gone, or [timeoutMs] passes. */
  wait(timeoutMs: number = LINK_LOAD_TIMEOUT_MS): Promise<NetlistLoadState> {
    if (this.state !== 'pending') return Promise.resolve(this.state);
    return new Promise((resolve) => {
      let cancel = (): void => {};
      const waiter = (state: NetlistLoadState): void => {
        this.waiters.delete(waiter);
        cancel();
        resolve(state);
      };
      this.waiters.add(waiter);
      cancel = this.schedule(() => waiter('timeout'), timeoutMs);
    });
  }

  private settle(state: 'loaded' | 'failed' | 'gone'): void {
    if (this.state === 'gone') return;
    this.state = state;
    for (const waiter of [...this.waiters]) waiter(state);
  }
}

/** What a preview said about a `select`, or why it said nothing. */
export type NetlistSelectAnswer =
  | { readonly outcome: 'selected'; readonly coneView: boolean }
  | { readonly outcome: 'not-found' | 'no-design' }
  /** No answer in time, the frame was not delivered, or the panel is gone. */
  | { readonly outcome: 'unavailable' };

/** Posts `select` frames to one preview and matches the answers to them. */
export class NetlistSelector {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, (answer: NetlistSelectAnswer) => void>();

  constructor(
    private readonly post: (frame: SelectFrame) => PromiseLike<boolean>,
    private readonly schedule: Schedule = defaultSchedule,
  ) {}

  /** Ask the viewer to select [name], a [element], and wait up to [timeoutMs] for its answer. */
  async select(
    request: { readonly element: SelectElement; readonly name: string },
    timeoutMs: number = LINK_LOAD_TIMEOUT_MS,
  ): Promise<NetlistSelectAnswer> {
    if (this.closed) return { outcome: 'unavailable' };
    const id = this.nextId++;
    const answered = new Promise<NetlistSelectAnswer>((resolve) => {
      let cancel = (): void => {};
      const finish = (answer: NetlistSelectAnswer): void => {
        this.pending.delete(id);
        cancel();
        resolve(answer);
      };
      this.pending.set(id, finish);
      cancel = this.schedule(() => finish({ outcome: 'unavailable' }), timeoutMs);
    });
    let delivered: boolean;
    try {
      delivered = await this.post(selectFrame(request.element, request.name, id));
    } catch {
      delivered = false;
    }
    if (!delivered) this.pending.get(id)?.({ outcome: 'unavailable' });
    return answered;
  }

  /** The viewer's `select_result`. An answer to no pending request is ignored. */
  accept(result: { readonly id: number | undefined; readonly outcome: SelectOutcome; readonly coneView: boolean }): void {
    if (result.id === undefined) return;
    const finish = this.pending.get(result.id);
    if (finish === undefined) return;
    finish(
      result.outcome === 'selected' ? { outcome: 'selected', coneView: result.coneView } : { outcome: result.outcome },
    );
  }

  /** The panel is gone: every pending request ends `unavailable`. */
  close(): void {
    this.closed = true;
    for (const finish of [...this.pending.values()]) finish({ outcome: 'unavailable' });
  }
}

/** One schematic preview, as a link sees it. */
export interface NetlistLinkPanel {
  readonly load: Pick<NetlistLoadWatch, 'wait'>;
  readonly selector: Pick<NetlistSelector, 'select'>;
}

/**
 * [fsPath] as the registry compares it: case folded where the filesystem
 * folds case, which is where VS Code treats two spellings as one document.
 */
export function netlistPanelKey(fsPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' || platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/** The open previews, by file. */
export class NetlistPanelRegistry {
  private readonly panels = new Map<string, NetlistLinkPanel>();
  private readonly waiters = new Map<string, Set<(panel: NetlistLinkPanel) => void>>();

  constructor(private readonly schedule: Schedule = defaultSchedule) {}

  /** Register [panel] under [key]; call the result when the panel closes. */
  adopt(key: string, panel: NetlistLinkPanel): () => void {
    this.panels.set(key, panel);
    for (const waiter of [...(this.waiters.get(key) ?? [])]) waiter(panel);
    return () => {
      if (this.panels.get(key) === panel) this.panels.delete(key);
    };
  }

  /** The panel for [key], waiting up to [timeoutMs] for it to be created. */
  waitFor(key: string, timeoutMs: number = LINK_LOAD_TIMEOUT_MS): Promise<NetlistLinkPanel | undefined> {
    const existing = this.panels.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set();
      this.waiters.set(key, set);
      let cancel = (): void => {};
      const finish = (panel: NetlistLinkPanel | undefined): void => {
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(key);
        cancel();
        resolve(panel);
      };
      const waiter = (panel: NetlistLinkPanel): void => finish(panel);
      set.add(waiter);
      cancel = this.schedule(() => finish(undefined), timeoutMs);
    });
  }
}
