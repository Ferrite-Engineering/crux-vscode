import { describe, expect, it } from 'vitest';
import { Emitter, type Disposable } from '../../src/cxp/emitter';
import {
  StemsIndexService,
  type Scheduler,
  type StemsFileChange,
  type StemsFileWatcher,
  type StemsIndexUpdate,
} from '../../src/names/stems-index-service';
import { NameIndex } from '../../src/names/name-index';

/** A watcher driven by hand — the seam that keeps this testable in Node. */
class FakeWatcher implements StemsFileWatcher {
  private readonly emitter = new Emitter<StemsFileChange>();
  disposed = false;

  onDidChange(listener: (change: StemsFileChange) => void): Disposable {
    return this.emitter.listen(listener);
  }

  fire(type: StemsFileChange['type'], fsPath: string): void {
    this.emitter.emit({ type, fsPath });
  }

  dispose(): void {
    this.disposed = true;
    this.emitter.clear();
  }
}

/**
 * A [Scheduler] whose timers only run when the test says so.
 *
 * Real timers would make the debounce assertions a race against the clock;
 * this makes "the burst was coalesced into one parse" an exact claim.
 */
class ManualScheduler {
  private queue: (() => void)[] = [];

  readonly schedule: Scheduler = (run) => {
    this.queue.push(run);
    return {
      dispose: (): void => {
        this.queue = this.queue.filter((queued) => queued !== run);
      },
    };
  };

  get pending(): number {
    return this.queue.length;
  }

  /** Fire every timer still queued. */
  flush(): void {
    const queued = this.queue;
    this.queue = [];
    for (const run of queued) run();
  }
}

const STEMS_A = '++ comp 0 file /ws/rtl/a.sv\n++ module top.a 0 1\n+++ var sig_a 0 5\n';
const STEMS_B = '++ comp 0 file /ws/rtl/b.sv\n++ module top.b 0 1\n+++ var sig_b 0 7\n';

interface Setup {
  readonly service: StemsIndexService;
  readonly watcher: FakeWatcher;
  readonly scheduler: ManualScheduler;
  readonly files: Map<string, string>;
  readonly reads: string[];
  readonly updates: StemsIndexUpdate[];
}

function setup(initial: Record<string, string> = {}): Setup {
  const files = new Map(Object.entries(initial));
  const reads: string[] = [];
  const watcher = new FakeWatcher();
  const scheduler = new ManualScheduler();
  const updates: StemsIndexUpdate[] = [];
  const service = new StemsIndexService({
    index: new NameIndex('linux'),
    readFile: (fsPath) => {
      reads.push(fsPath);
      return Promise.resolve(files.get(fsPath));
    },
    watcher,
    schedule: scheduler.schedule,
  });
  service.onDidUpdate.listen((update) => updates.push(update));
  return { service, watcher, scheduler, files, reads, updates };
}

/** Let the service's in-flight reads settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('StemsIndexService — initial load', () => {
  it('indexes every stems file it is given', async () => {
    const { service } = setup({ '/ws/a.stems': STEMS_A, '/ws/b.stems': STEMS_B });
    await service.load(['/ws/a.stems', '/ws/b.stems']);

    expect(service.index.size).toBe(4);
    expect(service.index.locationsFor('top.a.sig_a')[0]?.lineNumber).toBe(5);
    expect(service.index.locationsFor('top.b.sig_b')[0]?.lineNumber).toBe(7);
  });

  it('skips a file it cannot read without failing the load', async () => {
    const { service, updates } = setup({ '/ws/a.stems': STEMS_A });
    await service.load(['/ws/a.stems', '/ws/gone.stems']);

    expect(service.index.stemsFiles).toEqual(['/ws/a.stems']);
    expect(updates.find((u) => u.fsPath === '/ws/gone.stems')?.outcome).toBe('unreadable');
  });

  it('survives a reader that rejects', async () => {
    const service = new StemsIndexService({
      index: new NameIndex('linux'),
      readFile: () => Promise.reject(new Error('EACCES')),
    });
    await expect(service.load(['/ws/a.stems'])).resolves.toBeUndefined();
    expect(service.index.isEmpty).toBe(true);
  });
});

describe('StemsIndexService — watching for regeneration', () => {
  it('rebuilds the index when a stems file changes', async () => {
    const { service, watcher, scheduler, files } = setup({ '/ws/a.stems': STEMS_A });
    await service.load(['/ws/a.stems']);

    files.set('/ws/a.stems', '++ comp 0 file /ws/rtl/a.sv\n++ module top.a 0 1\n+++ var sig_a 0 9');
    watcher.fire('changed', '/ws/a.stems');
    scheduler.flush();
    await settle();

    expect(service.index.locationsFor('top.a.sig_a')[0]?.lineNumber).toBe(9);
    expect(service.index.declarationsAt('/ws/rtl/a.sv', 5)).toEqual([]);
  });

  it('coalesces a regeneration burst into one parse', async () => {
    const { service, watcher, scheduler, reads } = setup({ '/ws/a.stems': STEMS_A });
    await service.load(['/ws/a.stems']);
    reads.length = 0;

    // A generator truncating, writing and renaming looks like this.
    watcher.fire('changed', '/ws/a.stems');
    watcher.fire('changed', '/ws/a.stems');
    watcher.fire('changed', '/ws/a.stems');
    expect(scheduler.pending).toBe(1);

    scheduler.flush();
    await settle();
    expect(reads).toEqual(['/ws/a.stems']);
  });

  it('re-indexes only the file that changed', async () => {
    const { service, watcher, scheduler, reads } = setup({
      '/ws/a.stems': STEMS_A,
      '/ws/b.stems': STEMS_B,
    });
    await service.load(['/ws/a.stems', '/ws/b.stems']);
    reads.length = 0;

    watcher.fire('changed', '/ws/a.stems');
    scheduler.flush();
    await settle();

    // The whole point of sharding: b was not re-read and its entries are
    // exactly the ones it had.
    expect(reads).toEqual(['/ws/a.stems']);
    expect(service.index.locationsFor('top.b.sig_b')[0]?.lineNumber).toBe(7);
  });

  it('indexes a stems file that appears after activation', async () => {
    const { service, watcher, scheduler, files } = setup();
    expect(service.index.isEmpty).toBe(true);

    files.set('/ws/new.stems', STEMS_B);
    watcher.fire('created', '/ws/new.stems');
    scheduler.flush();
    await settle();

    expect(service.index.locationsFor('top.b.sig_b')).toHaveLength(1);
  });

  it('drops a deleted stems file and leaves the rest alone', async () => {
    const { service, watcher, scheduler, updates } = setup({
      '/ws/a.stems': STEMS_A,
      '/ws/b.stems': STEMS_B,
    });
    await service.load(['/ws/a.stems', '/ws/b.stems']);

    watcher.fire('deleted', '/ws/a.stems');
    scheduler.flush();
    await settle();

    expect(service.index.stemsFiles).toEqual(['/ws/b.stems']);
    expect(service.index.locationsFor('top.a.sig_a')).toEqual([]);
    expect(updates.at(-1)).toEqual({ fsPath: '/ws/a.stems', entryCount: 0, outcome: 'deleted' });
  });

  it('lets the last event of a burst decide', async () => {
    const { service, watcher, scheduler } = setup({ '/ws/a.stems': STEMS_A });
    await service.load(['/ws/a.stems']);

    watcher.fire('changed', '/ws/a.stems');
    watcher.fire('deleted', '/ws/a.stems');
    scheduler.flush();
    await settle();

    expect(service.index.stemsFiles).toEqual([]);
  });

  it('discards a slow read that a newer change has overtaken', async () => {
    // The race this guards: read #1 is issued, the file changes again, read
    // #2 finishes first, and then read #1 lands and reinstates the old
    // entries. Without the revision check the index would be a generation
    // behind, permanently and undetectably.
    const files = new Map([['/ws/a.stems', STEMS_A]]);
    const gates: (() => void)[] = [];
    const service = new StemsIndexService({
      index: new NameIndex('linux'),
      readFile: (fsPath) =>
        new Promise<string | undefined>((resolve) => {
          gates.push(() => resolve(files.get(fsPath)));
        }),
    });

    const stale = service.apply({ type: 'changed', fsPath: '/ws/a.stems' });
    await settle();
    files.set('/ws/a.stems', '++ comp 0 file /ws/rtl/a.sv\n++ module top.a 0 1\n+++ var sig_a 0 42');
    const fresh = service.apply({ type: 'changed', fsPath: '/ws/a.stems' });
    await settle();
    expect(gates).toHaveLength(2);

    // Resolve the *newer* read first, then let the stale one land.
    gates[1]?.();
    await fresh;
    gates[0]?.();
    await stale;

    expect(service.index.locationsFor('top.a.sig_a')[0]?.lineNumber).toBe(42);
  });
});

describe('StemsIndexService — bounds and disposal', () => {
  it('refuses a stems file larger than the parse bound without reading it', async () => {
    const reads: string[] = [];
    const updates: StemsIndexUpdate[] = [];
    const service = new StemsIndexService({
      index: new NameIndex('linux'),
      readFile: (fsPath) => {
        reads.push(fsPath);
        return Promise.resolve(STEMS_A);
      },
      fileSize: () => Promise.resolve(64 * 1024 * 1024),
      limits: { maxLength: 1024 },
    });
    service.onDidUpdate.listen((update) => updates.push(update));

    await service.load(['/ws/huge.stems']);

    expect(reads).toEqual([]);
    expect(service.index.isEmpty).toBe(true);
    expect(updates[0]?.outcome).toBe('too-large');
  });

  it('still bounds a file whose size it could not stat', async () => {
    const service = new StemsIndexService({
      index: new NameIndex('linux'),
      readFile: () => Promise.resolve(STEMS_A),
      limits: { maxLength: 4 },
    });
    await service.load(['/ws/a.stems']);
    expect(service.index.isEmpty).toBe(true);
  });

  it('disposes the watcher and drops pending timers', async () => {
    const { service, watcher, scheduler, reads } = setup({ '/ws/a.stems': STEMS_A });
    await service.load(['/ws/a.stems']);
    reads.length = 0;

    watcher.fire('changed', '/ws/a.stems');
    expect(service.hasPending('/ws/a.stems')).toBe(true);

    service.dispose();

    expect(watcher.disposed).toBe(true);
    expect(scheduler.pending).toBe(0);
    expect(service.hasPending('/ws/a.stems')).toBe(false);
    expect(service.index.isEmpty).toBe(true);

    scheduler.flush();
    await settle();
    expect(reads).toEqual([]);
  });

  it('ignores events that arrive after disposal', async () => {
    const { service, watcher, scheduler, reads } = setup({ '/ws/a.stems': STEMS_A });
    service.dispose();
    reads.length = 0;

    watcher.fire('changed', '/ws/a.stems');
    scheduler.flush();
    await settle();

    expect(reads).toEqual([]);
  });

  it('is safe to dispose twice', () => {
    const { service } = setup();
    service.dispose();
    expect(() => {
      service.dispose();
    }).not.toThrow();
  });
});
