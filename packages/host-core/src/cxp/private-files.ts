/**
 * Owner-only files and directories on the manifest path — CXP §10.1–10.2,
 * and `cxp_private_files.dart` in crux_cxp.
 *
 * Since wire 1.2 the manifest directory holds every local peer's token, and
 * presenting a token proves file access only if other users cannot read it
 * (§11.4, item 2). `mkdir` and `writeFile` take the process umask: under the
 * usual `022` that is a `0755` directory and a `0644` file, which is private
 * only when a directory above it is. On macOS `~/Library` is, and on Windows
 * the user profile's access-control list is; on a Linux system whose home
 * directories are `0755`, a common default, every local user could read
 * every peer's token. So a writer keeps the path private itself:
 *
 * - every directory it creates on the manifest path is made `0700`, and the
 *   manifest directory is tightened to `0700` if it grants group or others
 *   anything (an older build, or another product, may have made it `0755`).
 *   Directories it found already there above the manifest directory are the
 *   user's, not this protocol's, and are left alone;
 * - the manifest goes through a scratch file created exclusively (so a name
 *   planted in advance is never followed) with mode `0600`, before the token
 *   is written into it, and is then renamed over the destination, which
 *   keeps the mode. No file others can read ever holds the token, not even
 *   for the instant before the rename.
 *
 * POSIX only. On Windows a mode is not the access control that matters, the
 * profile's list is, and a directory made under `%APPDATA%` inherits it, so
 * nothing is changed there. Setting a mode is best effort: a filesystem
 * without modes, or a directory owned by another user, keeps what it has, and
 * the manifest is still written.
 */
import { chmod, mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { atomicTempPath } from './atomic-write';
import type { JsonObject } from './json';

/** `rwx------`: what CXP §10.1 asks of a directory a peer creates on the manifest path. */
export const CXP_OWNER_ONLY_DIRECTORY_MODE = 0o700;

/** `rw-------`: what CXP §10.2 asks of a manifest, which carries a token. */
export const CXP_OWNER_ONLY_FILE_MODE = 0o600;

/** Group and other permission bits: anything here is access for someone who is not the owner. */
const GROUP_OR_OTHER_BITS = 0o077;

/** Whether this platform's access control is a POSIX mode. */
const POSIX = process.platform !== 'win32';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

async function setModeBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // A filesystem without modes, or a directory someone else owns.
  }
}

/**
 * Create [path] if it does not exist, owner-only, and tighten it to
 * owner-only if it does. See the module docs for which directories are
 * touched.
 */
export async function ensureCxpPrivateDirectory(path: string): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let current = target;
  while (!(await isDirectory(current))) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of missing) {
    // One level at a time, so every directory made here is known and gets
    // the mode; `mkdir`'s own mode is masked by the umask, so it is set
    // again below. A concurrent creator — another peer starting at the same
    // moment — is harmless: the directory exists either way, and the mode
    // is set either way.
    try {
      await mkdir(directory, { mode: CXP_OWNER_ONLY_DIRECTORY_MODE });
    } catch (error) {
      if (!isErrno(error, 'EEXIST') || !(await isDirectory(directory))) throw error;
    }
    if (POSIX) await setModeBestEffort(directory, CXP_OWNER_ONLY_DIRECTORY_MODE);
  }
  if (!POSIX) return;
  const { mode } = await stat(target);
  if ((mode & GROUP_OR_OTHER_BITS) !== 0) {
    await setModeBestEffort(target, CXP_OWNER_ONLY_DIRECTORY_MODE);
  }
}

/** Test seams for [writeJsonPrivateAtomic], fired with the scratch file's path. */
export interface PrivateWriteHooks {
  /** Just before the contents are written into the (empty) scratch file. */
  readonly onBeforeWrite?: (scratchPath: string) => void | Promise<void>;
  /** Just before the scratch file is renamed over the destination. */
  readonly onBeforeRename?: (scratchPath: string) => void | Promise<void>;
}

/**
 * Crash-safely replace [filePath] with the JSON encoding of [value],
 * owner-only on POSIX.
 *
 * The same scratch naming and the same encoding as `writeJsonAtomic`, so
 * discovery's orphan sweep and every scanner see no difference; the
 * difference is the mode, set before a byte of [value] exists on disk. The
 * parent directory must exist: the manifest writer makes it with
 * [ensureCxpPrivateDirectory] first. On failure the scratch file is removed,
 * best effort, and the error is rethrown.
 */
export async function writeJsonPrivateAtomic(
  filePath: string,
  value: JsonObject,
  hooks: PrivateWriteHooks = {},
): Promise<void> {
  const scratch = atomicTempPath(filePath);
  let handle: FileHandle | undefined;
  try {
    // `wx` is O_CREAT | O_EXCL: it refuses an existing name, a link
    // included. The mode passed here can only lose bits to the umask, so the
    // file is never wider than `0600` from its first instant; the `chmod`
    // makes it exactly that.
    handle = await open(scratch, 'wx', CXP_OWNER_ONLY_FILE_MODE);
    if (POSIX) {
      await handle.chmod(CXP_OWNER_ONLY_FILE_MODE).catch(() => undefined);
    }
    await hooks.onBeforeWrite?.(scratch);
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    await hooks.onBeforeRename?.(scratch);
    await rename(scratch, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(scratch, { force: true }).catch(() => undefined);
    throw error;
  }
}
