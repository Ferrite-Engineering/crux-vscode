import type { Disposable } from '../cxp/emitter';
import type { NameIndex } from '../names/name-index';
import { timerScheduler, type Scheduler } from '../names/stems-index-service';
import { buildAnnotations, type LineAnnotation } from './annotations';
import {
  PinnedPathStore,
  resolveViewport,
  type AnnotationLimits,
  type ViewportLine,
  type ViewportResolution,
} from './model';
import {
  noSignalValueSource,
  type AnnotationCancellation,
  type SignalValueSnapshot,
  type SignalValueSource,
} from './value-source';

/**
 * The loop: cursor moves, scroll happens, decorations follow.
 *
 * ### Debounce is the feature, not a safeguard
 *
 * A cursor drag in the waveform and a scroll in the editor both produce a
 * dense stream of events — VSCode fires `onDidChangeTextEditorVisibleRanges`
 * per rendered frame of a smooth scroll. Recomputing per event would be
 * correct and would also make the editor feel like it is fighting the user,
 * which is the one outcome that makes an annotation feature worse than no
 * annotation feature. So every trigger goes through one coalescing window,
 * and the window restarts on each trigger: during a continuous scroll
 * nothing is computed at all, and one pass runs when the user stops.
 *
 * [DEFAULT_DEBOUNCE_MS] is 60 — under a fifth of the ~250 ms a person reads
 * as "instant" for a passive change, and long enough to swallow every frame
 * of a scroll gesture.
 *
 * ### The visible range is the whole input
 *
 * Nothing here ever sees the document. The editor seam offers the ranges it
 * is currently displaying and the text of a line, and the resolution pass
 * is bounded by [AnnotationLimits] on top of that. A 200 000-line netlist
 * and a 40-line testbench cost the same, because the viewport is the same
 * size.
 *
 * ### Generations, not cancellation tokens
 *
 * The value query is asynchronous and the user keeps moving. Every pass
 * takes a generation number; a snapshot that comes back into a generation
 * that has moved on is dropped without rendering. That is the whole race
 * condition, and it is why an out-of-order or slow answer can never paint
 * stale values into a file the user has since scrolled.
 */

/** Coalescing window for cursor-move and scroll triggers, in milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 60;

/** One visible region, 1-based and inclusive at both ends. */
export interface VisibleRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * The editor operations the loop needs.
 *
 * An interface for the same reason `editor/editor-host.ts` has one:
 * host-core's tests run under a `vscode` stand-in that has no editors, and
 * every behaviour worth testing here — coalescing, viewport-only
 * resolution, generation discipline, clearing on disable — is exactly the
 * part that does not need a real one.
 */
export interface AnnotatableEditor {
  /** Real filesystem path of the document. Stable for the editor's life. */
  readonly fsPath: string;
  /** VSCode language id, e.g. `systemverilog`. */
  readonly languageId: string;
  /** What is on screen right now, 1-based inclusive. */
  visibleRanges(): readonly VisibleRange[];
  /** Text of a 1-based line, or `undefined` past the end of the document. */
  lineText(line: number): string | undefined;
}

/** Paints (or clears) a set of annotations in one editor. */
export interface AnnotationRenderer {
  render(editor: AnnotatableEditor, annotations: readonly LineAnnotation[]): void;
  clear(editor: AnnotatableEditor): void;
}

/** One recomputation, measured. Fed to [RtlAnnotationControllerOptions.onProfile]. */
export interface AnnotationProfileSample {
  readonly fsPath: string;
  /** Visible lines examined. */
  readonly linesScanned: number;
  /** `NameIndex.candidatesFor` calls made. */
  readonly lookups: number;
  /** Distinct paths sent to the value source. */
  readonly paths: number;
  /** Lines that ended up carrying at least one annotation. */
  readonly annotatedLines: number;
  /**
   * Milliseconds for the **synchronous** half: viewport scan, identifier
   * extraction, index lookups, and building the annotation list. This is
   * the number that decides whether the editor feels laggy, because it is
   * the only part that runs on the extension host's thread while the user
   * is scrolling. The value query is off-thread and off-process.
   */
  readonly resolveMs: number;
  /** Milliseconds for the whole pass, including the value round trip. */
  readonly totalMs: number;
}

/** Construction options for [RtlAnnotationController]. */
export interface RtlAnnotationControllerOptions {
  /** The live stems index, or `undefined` when none is loaded yet. */
  readonly index: () => NameIndex | undefined;
  /** The waveform to ask. Defaults to [noSignalValueSource]. */
  readonly valueSource?: () => SignalValueSource | undefined;
  /** Where the annotations are painted. */
  readonly renderer: AnnotationRenderer;
  /** The `edacrux.rtlAnnotation.enabled` gate, read live. */
  readonly isEnabled: () => boolean;
  /** Timer seam. Defaults to [timerScheduler]. */
  readonly schedule?: Scheduler;
  /** Coalescing window. Defaults to [DEFAULT_DEBOUNCE_MS]. */
  readonly debounceMs?: number;
  /** Viewport bounds. See [AnnotationLimits]. */
  readonly limits?: Partial<AnnotationLimits>;
  /** Clock seam for [AnnotationProfileSample]. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Every completed pass, measured. Wired to the output channel. */
  readonly onProfile?: (sample: AnnotationProfileSample) => void;
  /**
   * Called the first time this session that annotations are actually
   * painted. The only telemetry RTL annotation emits — a closed `feature` token, no
   * property derived from a path, a value, or a file. See
   * `value-source.ts` on why nothing else may be reported.
   */
  readonly onFirstRender?: () => void;
}

export class RtlAnnotationController implements Disposable {
  /** Ambiguities the user has settled, per file+identifier. */
  readonly pinned = new PinnedPathStore();

  private pending: Disposable | undefined;
  private pendingEditor: AnnotatableEditor | undefined;
  private generation = 0;
  private rendered = false;
  private everRendered = false;
  private disposed = false;

  constructor(private readonly options: RtlAnnotationControllerOptions) {}

  /**
   * Recompute [editor]'s annotations once the trigger stream settles.
   *
   * Safe to call from a cursor-move handler, a scroll handler, a settings
   * change and a fresh value snapshot — which is the point of it being the
   * only entry point the extension wires.
   */
  refresh(editor: AnnotatableEditor): void {
    if (this.disposed) return;
    if (!this.options.isEnabled()) {
      this.clear(editor);
      return;
    }
    this.pending?.dispose();
    this.pendingEditor = editor;
    const delay = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const schedule = this.options.schedule ?? timerScheduler;
    this.pending = schedule(() => {
      this.pending = undefined;
      this.pendingEditor = undefined;
      void this.run(editor);
    }, delay);
  }

  /** Recompute now, skipping the debounce. For commands and for tests. */
  async refreshNow(editor: AnnotatableEditor): Promise<void> {
    if (this.disposed) return;
    this.pending?.dispose();
    this.pending = undefined;
    this.pendingEditor = undefined;
    if (!this.options.isEnabled()) {
      this.clear(editor);
      return;
    }
    await this.run(editor);
  }

  /** Whether a pass is queued — the debounce, observable. */
  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  /** The editor a queued pass is for, if any. */
  get pendingFsPath(): string | undefined {
    return this.pendingEditor?.fsPath;
  }

  /**
   * Drop [editor]'s decorations and any queued pass.
   *
   * Bumps the generation, so a value query already in flight cannot paint
   * into an editor that has just been cleared — turning the setting off
   * while a query is outstanding is the ordinary way to hit that.
   */
  clear(editor: AnnotatableEditor): void {
    this.pending?.dispose();
    this.pending = undefined;
    this.pendingEditor = undefined;
    this.generation += 1;
    if (this.rendered) {
      this.rendered = false;
      this.options.renderer.clear(editor);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending?.dispose();
    this.pending = undefined;
    this.pendingEditor = undefined;
    this.generation += 1;
    this.pinned.clear();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async run(editor: AnnotatableEditor): Promise<void> {
    const generation = (this.generation += 1);
    const cancellation: AnnotationCancellation = {
      isCancelled: () => this.disposed || this.generation !== generation,
    };
    const now = this.options.now ?? Date.now;
    const started = now();

    const index = this.options.index();
    if (index === undefined || index.isEmpty) {
      this.renderInto(editor, []);
      return;
    }

    const resolution = resolveViewport({
      index,
      fsPath: editor.fsPath,
      languageId: editor.languageId,
      lines: visibleLines(editor, this.options.limits?.maxLines),
      ...(this.options.limits !== undefined ? { limits: this.options.limits } : {}),
      pinned: this.pinned,
    });
    const resolveMs = now() - started;

    const snapshot = await this.valuesFor(resolution, cancellation);
    if (cancellation.isCancelled()) return;

    const annotations = buildAnnotations(resolution, snapshot);
    this.renderInto(editor, annotations);
    this.options.onProfile?.({
      fsPath: editor.fsPath,
      linesScanned: resolution.linesScanned,
      lookups: resolution.lookups,
      paths: resolution.paths.length,
      annotatedLines: annotations.length,
      resolveMs,
      totalMs: now() - started,
    });
  }

  private async valuesFor(
    resolution: ViewportResolution,
    cancellation: AnnotationCancellation,
  ): Promise<SignalValueSnapshot> {
    const source = this.options.valueSource?.() ?? noSignalValueSource;
    // Not asking is the fast path a window with no waveform takes on every
    // keystroke, and it must not cost a promise round trip.
    if (resolution.paths.length === 0 || !source.isReady()) {
      return { values: new Map<string, string>() };
    }
    return await source.valuesAt(resolution.paths, cancellation);
  }

  private renderInto(editor: AnnotatableEditor, annotations: readonly LineAnnotation[]): void {
    if (annotations.length === 0) {
      // Only clear if something is up: `setDecorations` with an empty array
      // is cheap but not free, and this runs on every settled scroll over a
      // file with no stems coverage.
      if (this.rendered) {
        this.rendered = false;
        this.options.renderer.clear(editor);
      }
      return;
    }
    this.rendered = true;
    this.options.renderer.render(editor, annotations);
    if (!this.everRendered) {
      this.everRendered = true;
      this.options.onFirstRender?.();
    }
  }
}

/**
 * The visible lines, flattened and bounded.
 *
 * VSCode reports several ranges when regions are folded, and reports them
 * in display order. They are concatenated as given: the resolution pass
 * does not care about order, and sorting them would cost more than it could
 * possibly save.
 */
export function visibleLines(
  editor: AnnotatableEditor,
  maxLines: number = Number.POSITIVE_INFINITY,
): readonly ViewportLine[] {
  const lines: ViewportLine[] = [];
  for (const range of editor.visibleRanges()) {
    const first = Math.max(1, Math.trunc(range.startLine));
    const last = Math.trunc(range.endLine);
    for (let line = first; line <= last; line++) {
      if (lines.length >= maxLines) return lines;
      const text = editor.lineText(line);
      if (text === undefined) break;
      lines.push({ line, text });
    }
  }
  return lines;
}
