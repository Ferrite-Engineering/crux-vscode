/**
 * Finding the file a netlist's `src` attribute names.
 *
 * A path Yosys wrote is whatever the run that produced the netlist saw. It is
 * absolute when the flow passed absolute paths, relative to the directory
 * Yosys ran in when it did not, and from another machine's layout when a CI job
 * produced the netlist. Going to source has to work for all three, so a name is
 * tried as written, then against the places a relative one can be rooted (the
 * netlist's own folder, each open workspace folder), and last by how much of its
 * tail matches a file the workspace holds.
 *
 * What this module decides is only *which file*. Whether the editor may open
 * it, a file outside every open folder being refused, is the containment check
 * `openContainedSourceLocation` makes on the value returned here.
 */
import path from 'node:path';

/** The environment the search runs in. */
export interface SourcePathDeps {
  /** Whether [fsPath] names an existing file. */
  readonly exists: (fsPath: string) => Promise<boolean>;
  /** Workspace files whose base name is [baseName], as absolute paths. */
  readonly findByBaseName: (baseName: string) => Promise<readonly string[]>;
}

/** Where a relative path may be rooted. */
export interface SourcePathContext {
  /** The folder holding the netlist. */
  readonly netlistDirectory: string;
  /** The open workspace folders. */
  readonly workspaceFolders: readonly string[];
}

/** What the search found. */
export type SourcePathResult =
  | { readonly kind: 'found'; readonly fsPath: string }
  /** Several files match equally well: the user picks. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'missing' };

/** The segments of [file], whichever separator wrote it, without empty or `.` ones. */
function segmentsOf(file: string): string[] {
  return file.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
}

/** How many trailing segments of [candidate] equal those of [wanted]. */
function sharedTail(wanted: readonly string[], candidate: readonly string[]): number {
  let shared = 0;
  while (
    shared < wanted.length &&
    shared < candidate.length &&
    wanted[wanted.length - 1 - shared] === candidate[candidate.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}

/** Resolve [file] to a file on this machine. */
export async function resolveNetlistSourcePath(
  file: string,
  context: SourcePathContext,
  deps: SourcePathDeps,
): Promise<SourcePathResult> {
  const trimmed = file.trim();
  if (trimmed.length === 0) return { kind: 'missing' };

  if (path.isAbsolute(trimmed) && (await deps.exists(trimmed))) {
    return { kind: 'found', fsPath: trimmed };
  }

  const segments = segmentsOf(trimmed);
  if (segments.length === 0) return { kind: 'missing' };

  if (!path.isAbsolute(trimmed)) {
    for (const root of [context.netlistDirectory, ...context.workspaceFolders]) {
      const candidate = path.join(root, ...segments);
      if (await deps.exists(candidate)) return { kind: 'found', fsPath: candidate };
    }
  }

  const baseName = segments[segments.length - 1] ?? '';
  const matches = await deps.findByBaseName(baseName);
  if (matches.length === 0) return { kind: 'missing' };
  const scored = matches.map((fsPath) => ({
    fsPath,
    shared: sharedTail(segments, segmentsOf(fsPath)),
  }));
  const best = Math.max(...scored.map((entry) => entry.shared));
  const top = scored.filter((entry) => entry.shared === best).map((entry) => entry.fsPath);
  const first = top[0];
  if (top.length === 1 && first !== undefined) return { kind: 'found', fsPath: first };
  return { kind: 'ambiguous', candidates: [...top].sort() };
}
