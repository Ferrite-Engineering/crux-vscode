import * as vscode from 'vscode';
import { Emitter, type Disposable } from '../cxp/emitter';
import { NameIndex } from './name-index';
import {
  DEFAULT_STEMS_PARSE_LIMITS,
  parseStems,
  type StemsEntry,
  type StemsParseLimits,
  type StemsParseOutcome,
} from './stems-parser';

/**
 * Keeps a [NameIndex] current as stems files are written, regenerated and
 * deleted.
 *
 * ### Why this is not just "reparse everything on change"
 *
 * Stems files are *generated*. The user runs `vermin`, or imports a
 * Verilator AST, or a Makefile rule fires — and the generator writes the
 * file, sometimes several times within a second (truncate, write, rename),
 * sometimes one file per module across a whole design. Two behaviours fall
 * out of that and both are load-bearing:
 *
 * - **Debounce.** A regeneration burst produces several change events for
 *   one file; parsing on each of them wastes the work and, worse, exposes
 *   the half-written intermediate states.
 * - **Incremental rebuild.** Re-indexing every stems file because one was
 *   rewritten makes a regeneration run quadratic in the number of stems
 *   files. [NameIndex] is sharded per stems file precisely so that only the
 *   changed shard is replaced.
 *
 * ### Seams
 *
 * Reading files and watching them are both injected. host-core's unit tests
 * run under plain Node with a stand-in `vscode` module that cannot watch
 * anything, and the *behaviour* worth testing — coalescing, ordering,
 * incrementality, disposal — is exactly the part that does not need a real
 * filesystem. [vscodeStemsWatcher] and [vscodeStemsReader] are the thin
 * adapters that are not worth unit-testing.
 */

/** What happened to a stems file. */
export type StemsFileChangeType = 'created' | 'changed' | 'deleted';

/** One filesystem event about a stems file. */
export interface StemsFileChange {
  readonly type: StemsFileChangeType;
  /** Absolute path of the stems file. */
  readonly fsPath: string;
}

/**
 * A source of [StemsFileChange]s.
 *
 * Deliberately narrower than `vscode.FileSystemWatcher`: one event stream
 * with a type tag rather than three separate emitters, because every
 * consumer here treats create and change identically and the third case
 * differs only in dropping a shard.
 */
export interface StemsFileWatcher extends Disposable {
  /** Register [listener]; dispose the result to stop receiving events. */
  onDidChange(listener: (change: StemsFileChange) => void): Disposable;
}

/**
 * Cancellable delayed execution — `setTimeout`/`clearTimeout` behind a
 * seam so tests drive the debounce by hand instead of by clock.
 */
export type Scheduler = (run: () => void, delayMs: number) => Disposable;

/** The default [Scheduler]: real timers. */
export const timerScheduler: Scheduler = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return { dispose: () => clearTimeout(handle) };
};

/** Reported after a stems file has been (re)indexed or dropped. */
export interface StemsIndexUpdate {
  /** The stems file the update concerns. */
  readonly fsPath: string;
  /** Entries now indexed from it. Zero for a deletion or a refusal. */
  readonly entryCount: number;
  /** How the parse ended, or `'deleted'` when the file went away. */
  readonly outcome: StemsParseOutcome | 'deleted' | 'unreadable';
}

/** Construction options for [StemsIndexService]. */
export interface StemsIndexServiceOptions {
  /**
   * Read a stems file's text. Resolve `undefined` when it cannot be read —
   * deleted between the event and the read, permission changed, a binary
   * file. Never rejects, and if it does, the service treats it as
   * unreadable rather than letting it escape into the extension host.
   */
  readonly readFile: (fsPath: string) => Promise<string | undefined>;
  /**
   * Byte size of a stems file, when cheaply available.
   *
   * Checked *before* [readFile] so a pathological file is never brought
   * into memory at all. Optional: without it the size bound still applies,
   * just after the read, via [StemsParseLimits.maxLength].
   */
  readonly fileSize?: (fsPath: string) => Promise<number | undefined>;
  /** Where change events come from. Omit for a load-once index. */
  readonly watcher?: StemsFileWatcher;
  /** The index to maintain. A fresh one by default. */
  readonly index?: NameIndex;
  /** Parse bounds. See [StemsParseLimits]. */
  readonly limits?: StemsParseLimits;
  /**
   * Coalescing window for change events, in milliseconds. Default 250.
   *
   * Long enough to swallow a generator's write burst, short enough that a
   * user who regenerates stems and immediately cross-probes does not
   * notice.
   */
  readonly debounceMs?: number;
  /** Timer seam. Defaults to [timerScheduler]. */
  readonly schedule?: Scheduler;
}

const DEFAULT_DEBOUNCE_MS = 250;

/** Per-file debounce state. */
interface Pending {
  readonly timer: Disposable;
  readonly type: StemsFileChangeType;
}

export class StemsIndexService implements Disposable {
  /** Fires after each stems file is indexed, re-indexed or dropped. */
  readonly onDidUpdate = new Emitter<StemsIndexUpdate>();

  /** The index this service maintains. Query it directly; it is live. */
  readonly index: NameIndex;

  private readonly pending = new Map<string, Pending>();
  /**
   * Per-file revision counter.
   *
   * A read is asynchronous, so a second regeneration can land while the
   * first is still being read. Without this the older read could finish
   * last and install stale entries — a race that shows up as "the index is
   * one generation behind" and is almost impossible to reproduce
   * deliberately. Bumped whenever new work is queued; a completed read
   * whose revision has moved on is discarded.
   */
  private readonly revisions = new Map<string, number>();
  private readonly subscription: Disposable | undefined;
  private disposed = false;

  constructor(private readonly options: StemsIndexServiceOptions) {
    this.index = options.index ?? new NameIndex();
    this.subscription = options.watcher?.onDidChange((change) => {
      this.queue(change);
    });
  }

  /**
   * Index [fsPaths] now, in parallel — the initial scan.
   *
   * Not debounced: this is one deliberate call, not a burst of events.
   */
  async load(fsPaths: readonly string[]): Promise<void> {
    await Promise.all(fsPaths.map(async (fsPath) => await this.reindex(fsPath)));
  }

  /**
   * Apply [change] immediately, skipping the debounce.
   *
   * For callers that already know the write has settled — a command that
   * just generated the file, a test.
   */
  async apply(change: StemsFileChange): Promise<void> {
    this.bump(change.fsPath);
    if (change.type === 'deleted') {
      this.forget(change.fsPath);
      return;
    }
    await this.reindex(change.fsPath);
  }

  /** Whether a re-index is queued for [fsPath]. */
  hasPending(fsPath: string): boolean {
    return this.pending.has(fsPath);
  }

  /**
   * Stop watching and drop every timer.
   *
   * The watcher is disposed too: a `FileSystemWatcher` that outlives the
   * extension keeps firing into a dead listener, which in VSCode shows up
   * as a leak warning at best and a retained extension host at worst.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.timer.dispose();
    this.pending.clear();
    this.subscription?.dispose();
    this.options.watcher?.dispose();
    this.onDidUpdate.clear();
    this.index.clear();
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Queue [change], coalescing with anything already pending for the file. */
  private queue(change: StemsFileChange): void {
    if (this.disposed) return;
    // The revision bumps on *queueing*, not on firing: an in-flight read
    // started by the previous event is invalidated the moment we learn the
    // file changed again, not later.
    this.bump(change.fsPath);
    this.pending.get(change.fsPath)?.timer.dispose();

    const delay = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const schedule = this.options.schedule ?? timerScheduler;
    const timer = schedule(() => {
      this.pending.delete(change.fsPath);
      // The *last* event in the burst decides: a file created and then
      // deleted within one window is deleted, and one deleted and rewritten
      // (which is how many generators write) is indexed.
      if (change.type === 'deleted') {
        this.forget(change.fsPath);
        return;
      }
      void this.reindex(change.fsPath);
    }, delay);
    this.pending.set(change.fsPath, { timer, type: change.type });
  }

  private bump(fsPath: string): number {
    const next = (this.revisions.get(fsPath) ?? 0) + 1;
    this.revisions.set(fsPath, next);
    return next;
  }

  private forget(fsPath: string): void {
    this.index.remove(fsPath);
    this.onDidUpdate.emit({ fsPath, entryCount: 0, outcome: 'deleted' });
  }

  /**
   * Re-read and re-index one stems file, replacing only its shard.
   *
   * Every failure mode here is ordinary: a generator that deleted the file
   * between the event and the read, a size the bounds refuse, a parse that
   * found nothing. All of them resolve to "this file contributes nothing"
   * and none of them throws — an exception escaping a watcher callback
   * takes down the extension host's event loop for everyone.
   */
  private async reindex(fsPath: string): Promise<void> {
    const revision = this.revisions.get(fsPath) ?? this.bump(fsPath);
    const limits = this.options.limits ?? {};

    let content: string | undefined;
    try {
      const size = await this.options.fileSize?.(fsPath);
      const maxLength = limits.maxLength ?? DEFAULT_STEMS_PARSE_LIMITS.maxLength;
      if (size !== undefined && size > maxLength) {
        this.replace(fsPath, revision, [], 'too-large');
        return;
      }
      content = await this.options.readFile(fsPath);
    } catch {
      content = undefined;
    }

    if (content === undefined) {
      this.replace(fsPath, revision, [], 'unreadable');
      return;
    }

    const result = parseStems(content, limits);
    this.replace(fsPath, revision, result.entries, result.outcome);
  }

  /** Install a shard, unless a newer revision has already been queued. */
  private replace(
    fsPath: string,
    revision: number,
    entries: readonly StemsEntry[],
    outcome: StemsIndexUpdate['outcome'],
  ): void {
    if (this.disposed) return;
    if ((this.revisions.get(fsPath) ?? revision) !== revision) return;
    if (entries.length === 0) this.index.remove(fsPath);
    else this.index.replace(fsPath, entries);
    this.onDidUpdate.emit({ fsPath, entryCount: entries.length, outcome });
  }
}

/** Glob every stems file in the workspace. GTKWave's conventional suffix. */
export const STEMS_GLOB = '**/*.stems';

/**
 * A [StemsFileWatcher] over `vscode.workspace.createFileSystemWatcher`.
 *
 * VSCode's watcher is workspace-scoped, which is the containment property
 * we want for free: it never reports a file outside the folders the user
 * opened, so the index cannot be seeded from somewhere the user never
 * granted.
 */
export function vscodeStemsWatcher(glob: string = STEMS_GLOB): StemsFileWatcher {
  const watcher = vscode.workspace.createFileSystemWatcher(glob);
  const emitter = new Emitter<StemsFileChange>();
  const wired = [
    watcher.onDidCreate((uri) => {
      emitter.emit({ type: 'created', fsPath: uri.fsPath });
    }),
    watcher.onDidChange((uri) => {
      emitter.emit({ type: 'changed', fsPath: uri.fsPath });
    }),
    watcher.onDidDelete((uri) => {
      emitter.emit({ type: 'deleted', fsPath: uri.fsPath });
    }),
  ];
  return {
    onDidChange: (listener) => emitter.listen(listener),
    dispose: () => {
      for (const registration of wired) registration.dispose();
      emitter.clear();
      watcher.dispose();
    },
  };
}

/** Read a stems file through VSCode's filesystem API. Never rejects. */
export async function vscodeStemsReader(fsPath: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** Stat a stems file's size through VSCode's filesystem API. */
export async function vscodeStemsFileSize(fsPath: string): Promise<number | undefined> {
  try {
    return (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).size;
  } catch {
    return undefined;
  }
}
