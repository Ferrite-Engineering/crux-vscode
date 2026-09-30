/**
 * Best-effort local install detection for NetCrux Desktop.
 *
 * Everywhere else in this pack, "is the desktop app here" means "is a CXP
 * peer for it present" (`desktop-detect/`) — a question the shared manifest
 * directory answers precisely. "What drives this?" asks a different question
 * for the no-peer case: not "is it running" but "is it *installed*", so a
 * launch can be offered instead of only a download link. Nothing else in
 * this pack needs that distinction, so there is no shared answer to reuse —
 * this module is deliberately narrow rather than a general "find any
 * installed application" facility.
 *
 * ### Why these particular names
 *
 * These are **installed-application** locations only; nothing here looks
 * for a source checkout. The released desktop app installs on disk as
 * **"NetCrux Pro"** — `NetCrux Pro.app` on macOS, `NetCrux Pro\netcrux_pro.exe`
 * on Windows, `netcrux_pro` on Linux — even though the public brand and the
 * download are named "NetCrux". The open-core app, built from source, is
 * plain "NetCrux" (`NetCrux.app`, `netcrux.exe`, `netcrux`). Both spellings
 * are checked, the released one first, so this keeps working for either
 * build and if the released app's on-disk name is ever normalised to match
 * the brand.
 *
 * This is explicitly **not exhaustive**. It does not read the Windows
 * uninstall registry, does not search `/Applications` beyond the two exact
 * names, and — because NetCrux's only Linux packaging is a portable tarball
 * and an AppImage extracted wherever the user chose — treats "found on
 * `$PATH`" as the whole of Linux detection. Missing an install some other
 * way is not a correctness bug here: the worst case is offering the
 * "install" boundary message to someone who already has NetCrux tucked away
 * somewhere unusual, which is exactly the message they would have gotten
 * before this module existed.
 */

/** Injected environment for [locateNetCruxExecutable]. */
export interface LocateNetCruxDeps {
  /** Whether [path] exists on disk. Production: `fs.existsSync`. */
  readonly exists: (path: string) => boolean;
  /** `process.platform`-shaped platform tag. Production: `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Environment variables. Production: `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Path separator for splitting `$PATH`. Production: `path.delimiter`. */
  readonly pathDelimiter: string;
  /** Path segment joiner. Production: `path.join`. */
  readonly join: (...segments: string[]) => string;
}

/** macOS `.app` bundle names to check under `/Applications`, in order. */
const MACOS_APP_NAMES = ['NetCrux Pro.app', 'NetCrux.app'];

/** Windows install directory names to check under each root, in order. */
const WINDOWS_DIR_NAMES = ['NetCrux Pro', 'NetCrux'];
const WINDOWS_EXE_NAMES = ['netcrux_pro.exe', 'netcrux.exe'];

/** Executable names to look for on `$PATH` on Linux and other POSIX platforms. */
const POSIX_EXECUTABLE_NAMES = ['netcrux_pro', 'netcrux'];

/**
 * The path to launch NetCrux Desktop with, if this best-effort search finds
 * one — an `.app` bundle on macOS (suitable for `env.openExternal`, which
 * resolves a `.app` path through the OS's own opener exactly as a Finder
 * double-click would), an `.exe` on Windows, or a bare executable name found
 * on `$PATH` on Linux/POSIX.
 */
export function locateNetCruxExecutable(deps: LocateNetCruxDeps): string | undefined {
  switch (deps.platform) {
    case 'darwin':
      return MACOS_APP_NAMES.map((name) => deps.join('/Applications', name)).find(deps.exists);
    case 'win32':
      return locateWindows(deps);
    default:
      return locatePosixOnPath(deps);
  }
}

function locateWindows(deps: LocateNetCruxDeps): string | undefined {
  const roots = [deps.env['LOCALAPPDATA'], deps.env['ProgramFiles'], deps.env['ProgramFiles(x86)']];
  for (const root of roots) {
    if (root === undefined || root.length === 0) continue;
    const programsBase = root === deps.env['LOCALAPPDATA'] ? deps.join(root, 'Programs') : root;
    for (const dirName of WINDOWS_DIR_NAMES) {
      for (const exeName of WINDOWS_EXE_NAMES) {
        const candidate = deps.join(programsBase, dirName, exeName);
        if (deps.exists(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function locatePosixOnPath(deps: LocateNetCruxDeps): string | undefined {
  const entries = (deps.env['PATH'] ?? '').split(deps.pathDelimiter).filter((entry) => entry.length > 0);
  for (const directory of entries) {
    for (const name of POSIX_EXECUTABLE_NAMES) {
      const candidate = deps.join(directory, name);
      if (deps.exists(candidate)) return candidate;
    }
  }
  return undefined;
}
