/**
 * "A file not opened before is confirmed first."
 *
 * In the desktop apps "opened before" is an open tab or the recent-files list.
 * An editor window keeps no recent list an extension can read, so here it is
 * an open tab only: a file the user has in front of them in this window. That
 * is the stricter of the two readings (a file opened yesterday asks again),
 * which can only cost a click, never open something unasked.
 *
 * Compared by file identity: both sides resolved through symbolic links and
 * case-folded where the filesystem folds case, so a tab opened through one
 * spelling matches a link through another.
 */
import { realpath as nodeRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/** What the comparison needs. Injectable for tests. */
export interface OpenedBeforeOptions {
  readonly realpath?: (path: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
}

/** [path] as a comparable key: resolved, symbolic links followed, case folded where the filesystem folds it. */
export async function linkPathKey(path: string, options: OpenedBeforeOptions = {}): Promise<string> {
  const realpath = options.realpath ?? nodeRealpath;
  const platform = options.platform ?? process.platform;
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    canonical = resolve(path);
  }
  return platform === 'darwin' || platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * The first of [openPaths] that is the same file as [resolvedPath], or
 * `undefined` when none is. The caller opens that tab's own path, so a tab
 * opened through a symbolic link is focused rather than a second tab opened
 * beside it.
 */
export async function findOpenedPath(
  resolvedPath: string,
  openPaths: Iterable<string>,
  options: OpenedBeforeOptions = {},
): Promise<string | undefined> {
  const key = await linkPathKey(resolvedPath, options);
  for (const path of openPaths) {
    if (path.length === 0) continue;
    if ((await linkPathKey(path, options)) === key) return path;
  }
  return undefined;
}
