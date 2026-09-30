import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { NameIndex } from '../../src/names/name-index';
import { parseStems, type StemsEntry } from '../../src/names/stems-parser';
import type { Disposable } from '../../src/cxp/emitter';
import type { Scheduler } from '../../src/names/stems-index-service';
import type { LineAnnotation } from '../../src/annotate/annotations';
import {
  DEFAULT_DEBOUNCE_MS,
  RtlAnnotationController,
  visibleLines,
  type AnnotatableEditor,
  type AnnotationProfileSample,
  type AnnotationRenderer,
  type VisibleRange,
} from '../../src/annotate/controller';
import type {
  AnnotationCancellation,
  SignalValueSnapshot,
  SignalValueSource,
} from '../../src/annotate/value-source';

const FIXTURES = fileURLToPath(new URL('../fixtures/stems', import.meta.url));

/** Let a fired debounce callback's async pass run to completion. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fixture(name: string): readonly StemsEntry[] {
  return parseStems(readFileSync(`${FIXTURES}/${name}`, 'utf8')).entries;
}

function loadedIndex(): NameIndex {
  const index = new NameIndex('linux');
  index.replace('/ws/top.stems', fixture('ambiguous-instantiations.stems'));
  return index;
}

/** A hand-driven [Scheduler]: nothing runs until the test says so. */
class ManualScheduler {
  private queued: (() => void)[] = [];
  /** Delays the controller asked for, in order — the debounce, observable. */
  readonly delays: number[] = [];

  readonly schedule: Scheduler = (run, delayMs): Disposable => {
    this.delays.push(delayMs);
    const entry = (): void => {
      run();
    };
    this.queued.push(entry);
    return {
      dispose: () => {
        this.queued = this.queued.filter((queued) => queued !== entry);
      },
    };
  };

  get pending(): number {
    return this.queued.length;
  }

  /** Fire every queued callback. */
  fire(): void {
    const queued = this.queued;
    this.queued = [];
    for (const run of queued) run();
  }
}

/** A fake editor over a fixed set of lines. */
class FakeEditor implements AnnotatableEditor {
  /** Every line number whose text was read — the visible-range assertion. */
  readonly read: number[] = [];

  constructor(
    readonly fsPath: string,
    private readonly text: Map<number, string>,
    private readonly ranges: readonly VisibleRange[],
    readonly languageId = 'systemverilog',
  ) {}

  visibleRanges(): readonly VisibleRange[] {
    return this.ranges;
  }

  lineText(line: number): string | undefined {
    const text = this.text.get(line);
    if (text === undefined) return undefined;
    this.read.push(line);
    return text;
  }
}

function editorOver(
  lines: Record<number, string>,
  ranges: readonly VisibleRange[],
  fsPath = '/ws/rtl/top.sv',
): FakeEditor {
  return new FakeEditor(
    fsPath,
    new Map(Object.entries(lines).map(([line, text]) => [Number(line), text])),
    ranges,
  );
}

class RecordingRenderer implements AnnotationRenderer {
  readonly rendered: (readonly LineAnnotation[])[] = [];
  cleared = 0;

  render(_editor: AnnotatableEditor, annotations: readonly LineAnnotation[]): void {
    this.rendered.push(annotations);
  }

  clear(): void {
    this.cleared += 1;
  }
}

function valueSource(values: Record<string, string>, ready = true): SignalValueSource {
  return {
    isReady: () => ready,
    valuesAt: async (): Promise<SignalValueSnapshot> =>
      await Promise.resolve({ values: new Map(Object.entries(values)) }),
  };
}

interface Harness {
  readonly controller: RtlAnnotationController;
  readonly renderer: RecordingRenderer;
  readonly scheduler: ManualScheduler;
}

function harness(
  options: {
    enabled?: boolean;
    index?: NameIndex | undefined;
    source?: SignalValueSource;
    onProfile?: (sample: AnnotationProfileSample) => void;
    onFirstRender?: () => void;
  } = {},
): Harness {
  const renderer = new RecordingRenderer();
  const scheduler = new ManualScheduler();
  const index = 'index' in options ? options.index : loadedIndex();
  const controller = new RtlAnnotationController({
    index: () => index,
    valueSource: () => options.source ?? valueSource({ 'top.clk': '1' }),
    renderer,
    isEnabled: () => options.enabled ?? true,
    schedule: scheduler.schedule,
    ...(options.onProfile !== undefined ? { onProfile: options.onProfile } : {}),
    ...(options.onFirstRender !== undefined ? { onFirstRender: options.onFirstRender } : {}),
  });
  return { controller, renderer, scheduler };
}

describe('visibleLines', () => {
  it('flattens several ranges, which is what a folded document reports', () => {
    const editor = editorOver({ 1: 'a', 2: 'b', 9: 'c', 10: 'd' }, [
      { startLine: 1, endLine: 2 },
      { startLine: 9, endLine: 10 },
    ]);
    expect(visibleLines(editor).map((line) => line.line)).toEqual([1, 2, 9, 10]);
  });

  it('stops at the end of the document', () => {
    const editor = editorOver({ 1: 'a' }, [{ startLine: 1, endLine: 5_000 }]);
    expect(visibleLines(editor)).toHaveLength(1);
  });

  it('clamps a range that starts before line 1', () => {
    const editor = editorOver({ 1: 'a' }, [{ startLine: -8, endLine: 1 }]);
    expect(visibleLines(editor).map((line) => line.line)).toEqual([1]);
  });

  it('honours the line budget', () => {
    const editor = editorOver({ 1: 'a', 2: 'b', 3: 'c' }, [{ startLine: 1, endLine: 3 }]);
    expect(visibleLines(editor, 2)).toHaveLength(2);
  });
});

describe('RtlAnnotationController — debounce', () => {
  it('does not compute until the trigger stream settles', async () => {
    const { controller, renderer, scheduler } = harness();
    const editor = editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]);

    controller.refresh(editor);
    expect(renderer.rendered).toHaveLength(0);
    expect(controller.hasPending).toBe(true);

    scheduler.fire();
    await flush();
    expect(renderer.rendered).toHaveLength(1);
  });

  it('coalesces a burst into one pass', async () => {
    // A smooth scroll fires `onDidChangeTextEditorVisibleRanges` per rendered
    // frame. Computing per event is what makes an editor feel like it is
    // fighting the user.
    const { controller, renderer, scheduler } = harness();
    const editor = editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]);

    for (let tick = 0; tick < 20; tick++) controller.refresh(editor);
    expect(scheduler.pending).toBe(1);

    scheduler.fire();
    await flush();
    expect(renderer.rendered).toHaveLength(1);
  });

  it('uses the documented window', () => {
    const { controller, scheduler } = harness();
    controller.refresh(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(scheduler.delays).toEqual([DEFAULT_DEBOUNCE_MS]);
    expect(DEFAULT_DEBOUNCE_MS).toBe(60);
  });

  it('refreshNow skips the debounce entirely', async () => {
    const { controller, renderer, scheduler } = harness();
    await controller.refreshNow(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(renderer.rendered).toHaveLength(1);
    expect(scheduler.pending).toBe(0);
  });
});

describe('RtlAnnotationController — the visible range is the whole input', () => {
  it('reads only the lines the editor says are visible', async () => {
    const lines: Record<number, string> = {};
    for (let line = 1; line <= 2_000; line++) lines[line] = 'wire clk;';
    const editor = editorOver(lines, [{ startLine: 900, endLine: 939 }]);
    const { controller } = harness();

    await controller.refreshNow(editor);

    // Forty lines out of two thousand — the cost is the viewport's, not the
    // file's, and a bigger design does not make it worse.
    expect(editor.read).toHaveLength(40);
    expect(editor.read[0]).toBe(900);
    expect(editor.read.at(-1)).toBe(939);
  });

  it('asks the value source only about what is on screen', async () => {
    const asked: string[][] = [];
    const source: SignalValueSource = {
      isReady: () => true,
      valuesAt: async (paths: readonly string[]): Promise<SignalValueSnapshot> => {
        asked.push([...paths]);
        return await Promise.resolve({ values: new Map([['top.clk', '1']]) });
      },
    };
    const { controller } = harness({ source });
    await controller.refreshNow(
      editorOver({ 4: 'wire clk;', 5: 'wire nothing_here;' }, [{ startLine: 4, endLine: 5 }]),
    );
    expect(asked).toEqual([['top.clk']]);
  });

  it('does not ask at all when nothing on screen resolved', async () => {
    const valuesAt = vi.fn();
    const source: SignalValueSource = { isReady: () => true, valuesAt };
    const { controller } = harness({ source });
    await controller.refreshNow(
      editorOver({ 4: 'wire nothing_here;' }, [{ startLine: 4, endLine: 4 }]),
    );
    expect(valuesAt).not.toHaveBeenCalled();
  });

  it('does not ask a source that is not ready', async () => {
    const valuesAt = vi.fn();
    const source: SignalValueSource = { isReady: () => false, valuesAt };
    const { controller } = harness({ source });
    await controller.refreshNow(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(valuesAt).not.toHaveBeenCalled();
  });
});

describe('RtlAnnotationController — off by default and clearing', () => {
  it('renders nothing and clears when disabled', async () => {
    const { controller, renderer } = harness({ enabled: false });
    const editor = editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]);
    controller.refresh(editor);
    expect(controller.hasPending).toBe(false);
    await controller.refreshNow(editor);
    expect(renderer.rendered).toHaveLength(0);
  });

  it('clears the decorations it had painted', async () => {
    const { controller, renderer } = harness();
    const editor = editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]);
    await controller.refreshNow(editor);
    expect(renderer.rendered).toHaveLength(1);

    controller.clear(editor);
    expect(renderer.cleared).toBe(1);
    // Idempotent: nothing is painted, so there is nothing to clear again.
    controller.clear(editor);
    expect(renderer.cleared).toBe(1);
  });

  it('does not clear an editor it never painted', () => {
    const { controller, renderer } = harness();
    controller.clear(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(renderer.cleared).toBe(0);
  });

  it('renders nothing when no stems index is loaded', async () => {
    const { controller, renderer } = harness({ index: undefined });
    await controller.refreshNow(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(renderer.rendered).toHaveLength(0);
  });
});

describe('RtlAnnotationController — generations', () => {
  it('drops a snapshot that arrives after the viewport moved on', async () => {
    let release: ((snapshot: SignalValueSnapshot) => void) | undefined;
    const source: SignalValueSource = {
      isReady: () => true,
      valuesAt: async (): Promise<SignalValueSnapshot> =>
        await new Promise((resolve) => {
          release = resolve;
        }),
    };
    const { controller, renderer } = harness({ source });
    const editor = editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]);

    const first = controller.refreshNow(editor);
    // The user scrolls while the query is in flight.
    controller.clear(editor);
    release?.({ values: new Map([['top.clk', 'stale']]) });
    await first;

    // Nothing was painted from the superseded generation.
    expect(renderer.rendered).toHaveLength(0);
  });

  it('drops a snapshot that arrives after dispose', async () => {
    let release: ((snapshot: SignalValueSnapshot) => void) | undefined;
    const source: SignalValueSource = {
      isReady: () => true,
      valuesAt: async (
        _paths: readonly string[],
        cancellation: AnnotationCancellation,
      ): Promise<SignalValueSnapshot> => {
        expect(cancellation.isCancelled()).toBe(false);
        return await new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const { controller, renderer } = harness({ source });
    const pass = controller.refreshNow(
      editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]),
    );
    controller.dispose();
    release?.({ values: new Map([['top.clk', '1']]) });
    await pass;
    expect(renderer.rendered).toHaveLength(0);
  });
});

describe('RtlAnnotationController — what it reports', () => {
  it('measures every pass', async () => {
    const samples: AnnotationProfileSample[] = [];
    const { controller } = harness({ onProfile: (sample) => samples.push(sample) });
    await controller.refreshNow(
      editorOver({ 4: 'wire clk;', 5: 'assign x = clk;' }, [{ startLine: 4, endLine: 5 }]),
    );
    const [sample] = samples;
    expect(sample?.linesScanned).toBe(2);
    expect(sample?.paths).toBe(1);
    expect(sample?.annotatedLines).toBe(2);
    expect(sample?.resolveMs).toBeGreaterThanOrEqual(0);
    expect(sample?.fsPath).toBe('/ws/rtl/top.sv');
  });

  it('fires the feature hook once per session, not once per pass', async () => {
    const onFirstRender = vi.fn();
    const { controller } = harness({ onFirstRender });
    const editor = editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]);
    await controller.refreshNow(editor);
    await controller.refreshNow(editor);
    await controller.refreshNow(editor);
    expect(onFirstRender).toHaveBeenCalledTimes(1);
  });

  it('does not fire the feature hook when nothing was painted', async () => {
    const onFirstRender = vi.fn();
    const { controller } = harness({ onFirstRender });
    await controller.refreshNow(
      editorOver({ 4: 'wire nothing_here;' }, [{ startLine: 4, endLine: 4 }]),
    );
    expect(onFirstRender).not.toHaveBeenCalled();
  });
});

describe('RtlAnnotationController — what it renders', () => {
  it('labels a value with the identifier as written in the file', async () => {
    const { controller, renderer } = harness({ source: valueSource({ 'top.clk': "1'b1" }) });
    await controller.refreshNow(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(renderer.rendered[0]).toEqual([
      {
        line: 4,
        entries: [{ identifier: 'clk', label: "clk = 1'b1", path: 'top.clk', value: "1'b1" }],
      },
    ]);
  });

  it('drops an identifier the app had no value for', async () => {
    // Three states look alike and are not: `x`, "declined to answer", and a
    // value that happens to be 0. Only the app knows which, so the host
    // renders what it was given and nothing where it was given nothing.
    const { controller, renderer } = harness({ source: valueSource({}) });
    await controller.refreshNow(editorOver({ 4: 'wire clk;' }, [{ startLine: 4, endLine: 4 }]));
    expect(renderer.rendered).toHaveLength(0);
  });

  it('renders an ambiguity even with no values at all', async () => {
    const { controller, renderer } = harness({ source: valueSource({}) });
    await controller.refreshNow(
      editorOver({ 21: 'wire result;' }, [{ startLine: 21, endLine: 21 }], '/ws/rtl/alu.sv'),
    );
    expect(renderer.rendered[0]).toEqual([
      {
        line: 21,
        entries: [
          {
            identifier: 'result',
            label: 'result = ? (2 signals)',
            ambiguousPaths: ['top.alu_a.result', 'top.alu_b.result'],
          },
        ],
      },
    ]);
  });
});
