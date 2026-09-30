/**
 * WaveCrux's wiring for RTL annotation.
 *
 * host-core owns the behaviour — the index, the viewport resolution, the
 * debounce, the decorations, the two commands. This module supplies the two
 * things only the WaveCrux extension can: **where the stems files are**
 * (a workspace scan and a watcher) and **which waveform to ask** (whichever
 * panel is live).
 *
 * ### Why the value source is a registry and not a field
 *
 * A window can have several waveform tabs open. Only one of them is worth
 * asking — the most recently opened — and the annotation loop must never
 * hold a reference to a panel that has been disposed, because a disposed
 * webview's `postMessage` resolves `false` forever and the decorations would
 * silently stop updating with no sign of why. So each tab *adopts* the role
 * and hands back a release, and the release restores whichever tab held it
 * before rather than clearing it: closing the second of two open waveforms
 * should leave the first one annotating.
 */
import * as vscode from 'vscode';
import { annotate, names, telemetry } from '@crux-vscode/host-core';
import type { WebviewValueSource } from '../webview/value-query';

/**
 * The `feature` token for `feature.used`.
 *
 * The **only** thing RTL annotation reports. Signal paths and values are
 * the user's design data; they are rendered into their own editor and go
 * nowhere else. A closed token with no properties is what the telemetry
 * rules allow and all they allow.
 */
export const RTL_ANNOTATION_FEATURE = 'rtl_annotation';

/** How many stems files one workspace scan will index. */
const MAX_STEMS_FILES = 512;

/** What `extension.ts` hands the rest of the surface. */
export interface RtlAnnotationSurface extends vscode.Disposable {
  /** Adopt a panel's waveform as the one annotation asks about. */
  adoptValueSource(source: WebviewValueSource): () => void;
  /** Re-render the visible editors — the cursor moved, or a waveform landed. */
  refreshAnnotations(): void;
  /**
   * The stems-backed name resolver this surface already maintains.
   *
   * Exposed rather than rebuilt because the *other* direction needs the
   * same index: annotation asks it `file+line+identifier → design path` per
   * visible line, and the waveform-selection follow asks it
   * `design path → file+line`. `NameIndex` is bidirectional from the first
   * commit for exactly this (see host-core `names/index.ts`), so a second
   * `StemsIndexService` in this extension would mean two workspace scans,
   * two file watchers and two copies of a 240 000-entry index that can
   * disagree with each other after an edit. It is also what WaveCrux
   * contributes to the window for the `edacrux.*` send commands.
   */
  readonly resolver: names.NameResolver;
}

/** What the surface needs from the extension. */
export interface RtlAnnotationSurfaceOptions {
  /** host-core's `TelemetryClient.record`. */
  readonly record?: (event: telemetry.TelemetryEvent) => void;
  /** The output channel, for the profile line. */
  readonly log?: (line: string) => void;
}

export function registerRtlAnnotationSurface(
  options: RtlAnnotationSurfaceOptions = {},
): RtlAnnotationSurface {
  const stems = new names.StemsIndexService({
    readFile: names.vscodeStemsReader,
    fileSize: names.vscodeStemsFileSize,
    watcher: names.vscodeStemsWatcher(),
  });

  // Deliberately not awaited: activation must not block on a workspace scan,
  // and an index that fills in a moment later costs nothing — the annotation
  // loop reads it live and the watcher keeps it current from then on.
  void scanStems(stems, options.log);

  // No `hierarchy` fallback, matching `netcrux/src/extension.ts`: the
  // forward direction this is used for (`design path → file + line`) has no
  // hierarchy answer to fall back to — a design hierarchy knows where a
  // signal lives in the design, not which line of which file declared it.
  // "Resolve from stems or not at all" is the correct behaviour here.
  const resolver = new names.NameResolver({
    index: stems.index,
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });

  /** Adoption stack. See the module comment on why this is a stack. */
  const sources: WebviewValueSource[] = [];
  const activeSource = (): WebviewValueSource | undefined => sources[sources.length - 1];

  const registration = annotate.registerRtlAnnotation({
    index: () => stems.index,
    valueSource: activeSource,
    onProfile: (sample) => {
      // One line per settled recompute. This is the number the performance
      // claim rests on, and it is in the product rather than only in a
      // benchmark so it can be read on a user's own file when they say the
      // editor feels slow.
      options.log?.(
        `   rtl annotation: ${sample.linesScanned} lines, ${sample.lookups} lookups, ` +
          `${sample.paths} paths, ${sample.annotatedLines} annotated — ` +
          `resolve ${sample.resolveMs.toFixed(1)} ms, total ${sample.totalMs.toFixed(1)} ms`,
      );
    },
    onFirstRender: () => {
      options.record?.({
        name: telemetry.TELEMETRY_EVENTS.featureUsed,
        properties: { feature: RTL_ANNOTATION_FEATURE },
      });
    },
  });

  return {
    resolver,
    adoptValueSource: (source) => {
      sources.push(source);
      registration.refreshAll();
      return () => {
        const index = sources.indexOf(source);
        if (index >= 0) sources.splice(index, 1);
        registration.refreshAll();
      };
    },
    refreshAnnotations: () => {
      registration.refreshAll();
    },
    dispose: () => {
      registration.dispose();
      stems.dispose();
      sources.length = 0;
    },
  };
}

/** Index every stems file in the open folders, bounded. */
async function scanStems(
  stems: names.StemsIndexService,
  log: ((line: string) => void) | undefined,
): Promise<void> {
  try {
    const found = await vscode.workspace.findFiles(
      names.STEMS_GLOB,
      '**/node_modules/**',
      MAX_STEMS_FILES,
    );
    await stems.load(found.map((uri) => uri.fsPath));
    log?.(`   stems: ${found.length} file(s), ${stems.index.size} entries indexed`);
  } catch {
    // A workspace that cannot be searched (no folder open, a provider that
    // refused) leaves an empty index, which is exactly "nothing to annotate".
  }
}
