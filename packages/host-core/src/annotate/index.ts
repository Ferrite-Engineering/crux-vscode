/**
 * RTL annotation — signal values as editor decorations in the user's own
 * Verilog/VHDL, following the waveform cursor.
 *
 * This is the capability where the extension is the *better* place for
 * something than the desktop app: RTL source annotation needs screen real
 * estate for a source view, and inside VSCode the editor already is one.
 *
 * The pieces, in the order the data moves:
 *
 * 1. `settings.ts` — `edacrux.rtlAnnotation.enabled`, **off by default**.
 * 2. `identifiers.ts` — what words are on a visible line.
 * 3. `model.ts` — those words against the stems index, exact matches only,
 *    ambiguity preserved rather than guessed.
 * 4. `value-source.ts` — the one question the host asks the app.
 * 5. `annotations.ts` — resolution + values → what to draw.
 * 6. `controller.ts` — debounce, visible range only, generations.
 * 7. `vscode-annotation.ts` — decoration types, commands, event wiring.
 *
 * Two rules run through all of it:
 *
 * - **Nothing is guessed into someone's source file.** Only stems-exact
 *   matches annotate; a name match against the loaded hierarchy is good
 *   enough for a quick-pick the user is reading and not good enough for
 *   ambient text they are not.
 * - **Nothing here is reported.** Paths and values are the user's design
 *   data. The only telemetry is `feature.used {feature: 'rtl_annotation'}`.
 *
 * See docs/implementation-map.md §2 (`annotate/*`), §6 and §6b (the stems
 * index it resolves against) and §6e (why `edacrux.rtlAnnotation.enabled` is
 * a restricted setting).
 */
export {
  DEFAULT_RTL_ANNOTATION_SETTINGS,
  RTL_ANNOTATION_SETTING_KEYS,
  readRtlAnnotationSettings,
  toggleRtlAnnotationEnabled,
  type RtlAnnotationSettings,
} from './settings';

export {
  HDL_LANGUAGE_IDS,
  hdlDialectFor,
  identifiersOnLine,
  stripNonCode,
  type HdlDialect,
} from './identifiers';

export {
  DEFAULT_ANNOTATION_LIMITS,
  NO_PINNED_PATHS,
  PinnedPathStore,
  resolveViewport,
  type AnnotationLimits,
  type PinnedPaths,
  type ResolveViewportOptions,
  type ResolvedIdentifier,
  type ResolvedLine,
  type ViewportLine,
  type ViewportResolution,
} from './model';

export {
  EMPTY_VALUE_SNAPSHOT,
  NEVER_CANCELLED,
  noSignalValueSource,
  type AnnotationCancellation,
  type SignalValueSnapshot,
  type SignalValueSource,
} from './value-source';

export {
  buildAnnotations,
  type AnnotationEntry,
  type LineAnnotation,
} from './annotations';

export {
  DEFAULT_DEBOUNCE_MS,
  RtlAnnotationController,
  visibleLines,
  type AnnotatableEditor,
  type AnnotationProfileSample,
  type AnnotationRenderer,
  type RtlAnnotationControllerOptions,
  type VisibleRange,
} from './controller';

export {
  RTL_ANNOTATION_COMMAND_IDS,
  VscodeAnnotatableEditor,
  VscodeAnnotationRenderer,
  registerRtlAnnotation,
  type RtlAnnotationRegistration,
  type RtlAnnotationRegistrationOptions,
} from './vscode-annotation';

export {
  annotationAmbiguousHoverBody,
  annotationAmbiguousHoverTitle,
  annotationAmbiguousLabel,
  annotationDisabledMessage,
  annotationEnabledMessage,
  annotationHoverTitle,
  annotationNoWaveformMessage,
  annotationPickLabel,
  annotationValueLabel,
} from './strings';
