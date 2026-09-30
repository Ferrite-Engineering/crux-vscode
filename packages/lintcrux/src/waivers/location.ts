/**
 * Where `.lintcrux-waivers.json` belongs for a given source file.
 *
 * The app resolves it as `<LintProject.rootPath>/.lintcrux-waivers.json`
 * and has a project object to ask. This extension has a workspace and a
 * file path, so it has to find the same root a different way — and getting
 * it wrong means writing a waiver the app never loads, which is the one
 * failure mode a code action must not have.
 *
 * The walk, from the file's directory upward and stopping at the workspace
 * folder that contains it:
 *
 * 1. a directory that already has `.lintcrux-waivers.json` — the app is
 *    already reading that file, so it is the answer by definition;
 * 2. a directory that has a `*.lintcrux` project file — that is what
 *    `LintProject.rootPath` is set from when the app opens a project;
 * 3. failing both, the workspace folder root itself.
 *
 * Deliberately never leaves the workspace: a waiver file written above the
 * folder the user opened is one they will not find, will not commit, and
 * cannot review.
 */
import path from 'node:path';
import { WAIVER_FILE_NAME } from './model';

/** Filesystem questions [resolveWaiverFile] needs answered. */
export interface WaiverFileLookup {
  /** Whether [directory] already contains `.lintcrux-waivers.json`. */
  readonly hasWaiverFile: (directory: string) => boolean;
  /** Whether [directory] contains a `*.lintcrux` project file. */
  readonly hasProjectFile: (directory: string) => boolean;
}

/** Options for [resolveWaiverFile]. */
export interface ResolveWaiverFileOptions {
  /** Absolute path of the source file the violation is in. */
  readonly filePath: string;
  /** Absolute workspace folder roots, as `workspace.workspaceFolders` gives them. */
  readonly workspaceFolders: readonly string[];
  readonly lookup: WaiverFileLookup;
}

/** The workspace folder containing [filePath], longest (most specific) first. */
function containingFolder(
  filePath: string,
  workspaceFolders: readonly string[],
): string | undefined {
  let best: string | undefined;
  for (const folder of workspaceFolders) {
    const normalized = path.normalize(folder);
    const relative = path.relative(normalized, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (best === undefined || normalized.length > best.length) best = normalized;
  }
  return best;
}

/**
 * The absolute path of the waiver file to read and append to for
 * [ResolveWaiverFileOptions.filePath], or `undefined` when the file is not
 * inside any open workspace folder.
 */
export function resolveWaiverFile(options: ResolveWaiverFileOptions): string | undefined {
  const filePath = path.normalize(options.filePath);
  const root = containingFolder(filePath, options.workspaceFolders);
  if (root === undefined) return undefined;
  let directory = path.dirname(filePath);
  for (;;) {
    if (options.lookup.hasWaiverFile(directory) || options.lookup.hasProjectFile(directory)) {
      return path.join(directory, WAIVER_FILE_NAME);
    }
    if (directory === root) break;
    const parent = path.dirname(directory);
    // `dirname('/')` is `'/'`: without this the loop would spin at the
    // filesystem root for a file whose workspace folder it never reaches.
    if (parent === directory) break;
    directory = parent;
  }
  return path.join(root, WAIVER_FILE_NAME);
}
