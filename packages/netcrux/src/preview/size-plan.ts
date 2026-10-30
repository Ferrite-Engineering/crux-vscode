/**
 * What the preview does with a file of a given size.
 *
 * The web viewer reads a document as one string, parses it in the page, and
 * lays a scope out in WebAssembly in a worker. All of that is bounded by what a
 * webview process can hold, where the desktop app streams a netlist from disk
 * and takes any size. So above a threshold the preview does not load the file
 * at all: it says so and offers the desktop app, rather than freezing the
 * editor window on a document the page cannot hold.
 */

/** Default threshold in MiB, the `netcrux.preview.maxFileSizeMB` setting's default. */
export const DEFAULT_MAX_FILE_SIZE_MB = 100;

/** The setting's bounds. Above the upper one the viewer's string handling is not trusted. */
export const MIN_MAX_FILE_SIZE_MB = 1;
export const MAX_MAX_FILE_SIZE_MB = 256;

/** Bytes in a MiB. */
const MIB = 1024 * 1024;

/** [value] as a usable threshold in MiB: an integer within the setting's bounds. */
export function normalizeMaxFileSizeMb(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_FILE_SIZE_MB;
  return Math.min(MAX_MAX_FILE_SIZE_MB, Math.max(MIN_MAX_FILE_SIZE_MB, Math.floor(value)));
}

/** What to do with the file. */
export type NetlistPlan =
  /** Load it into the viewer. */
  | { readonly kind: 'preview' }
  /** Empty: nothing to draw. */
  | { readonly kind: 'empty' }
  /** Larger than the threshold: offer the desktop app instead. */
  | { readonly kind: 'too-large'; readonly limitMb: number };

/** Decide from the file's [sizeBytes] and the threshold in MiB. */
export function planNetlist(sizeBytes: number, maxFileSizeMb: unknown): NetlistPlan {
  if (sizeBytes <= 0) return { kind: 'empty' };
  const limitMb = normalizeMaxFileSizeMb(maxFileSizeMb);
  if (sizeBytes > limitMb * MIB) return { kind: 'too-large', limitMb };
  return { kind: 'preview' };
}
