/**
 * Whether the file a link names may be opened, and which file that is once
 * symbolic links resolve. The port of the desktop products'
 * `vetWaveCruxLinkTarget` / `vetNetCruxLinkTarget`, step for step.
 */
import { lstat as nodeLstat, realpath as nodeRealpath, stat as nodeStat } from 'node:fs/promises';
import { extname } from 'node:path';
import { isWindowsDeviceOrStream, refuseLinkPath } from './path-floor';

/** Why the file a link names was not opened. */
export type LinkTargetRefusal =
  /** Not an absolute, well-formed local path, or a Windows device or stream. */
  | 'path-refused'
  /** Not one of the product's link extensions, as named or once links resolve. */
  | 'wrong-kind'
  /** Nothing is there, or it is not a regular file. */
  | 'file-not-found';

/** The outcome of [vetLinkTarget]. */
export type LinkTargetResult =
  | {
      readonly ok: true;
      /**
       * The link's path with every symbolic link resolved. This is the value
       * checked, shown to the user and opened.
       */
      readonly path: string;
    }
  | { readonly ok: false; readonly refusal: LinkTargetRefusal };

/** The filesystem questions [vetLinkTarget] asks. Injectable for tests. */
export interface LinkTargetFs {
  /** Whether [path], following links, is a regular file. Rejects when absent. */
  isFile(path: string): Promise<boolean>;
  /** Whether [path] itself, not following links, is a regular file. */
  isFileNoFollow(path: string): Promise<boolean>;
  /** [path] with every symbolic link resolved. */
  realpath(path: string): Promise<string>;
}

/** The real filesystem. */
export const NODE_LINK_TARGET_FS: LinkTargetFs = {
  isFile: async (path) => (await nodeStat(path)).isFile(),
  isFileNoFollow: async (path) => (await nodeLstat(path)).isFile(),
  realpath: (path) => nodeRealpath(path),
};

/** What [vetLinkTarget] needs. */
export interface LinkTargetOptions {
  /** The extensions a link may open, lower case with the dot: `.vcd`. */
  readonly extensions: ReadonlySet<string>;
  /** Defaults to the host. Tests pin it. */
  readonly windows?: boolean;
  /** Defaults to [NODE_LINK_TARGET_FS]. */
  readonly fs?: LinkTargetFs;
  /**
   * The path rule, replaceable only so a test can show that a handler which
   * opens a relative path is caught. Defaults to [refuseLinkPath].
   */
  readonly refusePath?: (path: string, options: { readonly windows: boolean }) => string | undefined;
}

/** Whether [path]'s extension is one of [extensions], ignoring case. */
export function hasLinkExtension(path: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(path).toLowerCase());
}

/**
 * In order, stopping at the first refusal:
 *
 * 1. the floor ([refuseLinkPath]) judges the path as spelled, before anything
 *    reads the filesystem;
 * 2. on Windows, an alternate data stream or a device name is refused, also
 *    by spelling;
 * 3. the extension, as spelled, must be one of [LinkTargetOptions.extensions];
 * 4. the path must exist and resolve, every link followed, to a regular file
 *    whose own extension is one of them too: `dump.vcd` linking to
 *    `~/.ssh/id_ed25519` is refused, not opened; and the resolved path is
 *    held to the floor as well, since it is the one opened.
 */
export async function vetLinkTarget(file: string, options: LinkTargetOptions): Promise<LinkTargetResult> {
  const windows = options.windows ?? process.platform === 'win32';
  const fs = options.fs ?? NODE_LINK_TARGET_FS;
  const refusePath = options.refusePath ?? refuseLinkPath;
  const refuse = (refusal: LinkTargetRefusal): LinkTargetResult => ({ ok: false, refusal });

  if (refusePath(file, { windows }) !== undefined) return refuse('path-refused');
  if (windows && isWindowsDeviceOrStream(file)) return refuse('path-refused');
  if (!hasLinkExtension(file, options.extensions)) return refuse('wrong-kind');
  let resolved: string;
  try {
    if (!(await fs.isFile(file))) return refuse('file-not-found');
    resolved = await fs.realpath(file);
    if (!(await fs.isFileNoFollow(resolved))) return refuse('file-not-found');
  } catch {
    return refuse('file-not-found');
  }
  if (!hasLinkExtension(resolved, options.extensions)) return refuse('wrong-kind');
  if (refusePath(resolved, { windows }) !== undefined) return refuse('path-refused');
  return { ok: true, path: resolved };
}
