import { realpath as nodeRealpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Why a path a peer named was refused.
 *
 * A closed set so callers branch on a value rather than on prose; the
 * human-readable (and wire-visible) text for each lives in `strings.ts`.
 */
export type WorkspacePathRefusal =
  /** `file_path` was empty or whitespace. */
  | 'empty-path'
  /** No workspace folder is open, so nothing can be inside one. */
  | 'no-workspace'
  /** The real path resolved outside every open folder. */
  | 'outside-workspace'
  /** Inside the workspace, but no such file exists. */
  | 'not-found';

/** Outcome of resolving a peer-supplied path against the workspace. */
export type ResolvedWorkspacePath =
  | {
      readonly ok: true;
      /**
       * The **real** path, symlinks resolved. This exact value is what the
       * caller must open: validating one string and opening another is how
       * a containment check becomes decorative.
       */
      readonly fsPath: string;
      /** The open folder that contains it, also symlink-resolved. */
      readonly root: string;
    }
  | { readonly ok: false; readonly reason: WorkspacePathRefusal };

/** Injection points for [resolveWorkspacePath]. */
export interface WorkspacePathOptions {
  /**
   * Absolute paths of the folders the user has already opened —
   * `vscode.workspace.workspaceFolders` mapped to `uri.fsPath`.
   *
   * "Already opened" is the whole security model (CXP §11): the user
   * granting a folder to the window is the consent, and a peer can only
   * ever reach inside what the user already granted.
   */
  readonly workspaceFolders: readonly string[];
  /** Symlink resolver. Injectable for tests; defaults to `fs.realpath`. */
  readonly realpath?: (path: string) => Promise<string>;
  /**
   * Platform tag deciding whether path comparison folds case. Defaults to
   * `process.platform`; tests pin it so a Linux CI runner and a macOS
   * laptop assert the same thing.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Whether path comparison on [platform] should ignore case.
 *
 * Case-folding cannot *widen* containment — a real path that differs from a
 * root only by case is the same directory on a case-insensitive volume —
 * but declining to fold would reject legitimate requests on macOS and
 * Windows, where `realpath` need not return the casing the workspace folder
 * was recorded with.
 */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function comparable(path: string, platform: NodeJS.Platform): string {
  return foldsCase(platform) ? path.toLowerCase() : path;
}

/**
 * `realpath(path)`, or `undefined` when it does not exist.
 *
 * Non-existence is not an error here: it is one of the outcomes, and the
 * caller distinguishes "inside the workspace but missing" from "outside the
 * workspace" from it.
 */
async function realpathOrUndefined(
  path: string,
  realpath: (p: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** A path with every symlink its filesystem knows about already resolved. */
interface CanonicalPath {
  /** The canonical form. Equal to `realpath(path)` when the file exists. */
  readonly real: string;
  /** Whether the path itself exists. */
  readonly exists: boolean;
}

/**
 * Canonicalise [path] whether or not it exists.
 *
 * `realpath` fails outright on a missing file, which would leave a
 * non-existent path uncanonicalised — and that is not a cosmetic gap. On
 * macOS `/var` is a symlink to `/private/var`, so an *existing* workspace
 * root canonicalises into `/private/var/...` while a missing file under it
 * would still read `/var/...`, and the containment test would call a file
 * that is plainly inside the workspace an escape.
 *
 * So: resolve the longest existing ancestor and re-append the remainder.
 * The existing part gets true filesystem semantics; the part that does not
 * exist yet cannot contain a symlink, because there is nothing there to be
 * one.
 */
async function canonicalise(
  path: string,
  realpath: (p: string) => Promise<string>,
): Promise<CanonicalPath> {
  const direct = await realpathOrUndefined(path, realpath);
  if (direct !== undefined) return { real: direct, exists: true };

  const trailing: string[] = [];
  let current = resolve(path);
  for (;;) {
    const parent = dirname(current);
    trailing.unshift(basename(current));
    if (parent === current) return { real: resolve(path), exists: false };
    const real = await realpathOrUndefined(parent, realpath);
    if (real !== undefined) return { real: join(real, ...trailing), exists: false };
    current = parent;
  }
}

/**
 * The first root in [roots] that contains [target], or `undefined`.
 *
 * Prefix matching is done on `root + separator` so `/work/project-secrets`
 * is not treated as inside `/work/project`. An exact match on the root
 * itself counts — opening the folder is inside the folder.
 */
function containingRoot(
  target: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
): string | undefined {
  const comparableTarget = comparable(target, platform);
  for (const root of roots) {
    if (comparableTarget === comparable(root, platform)) return root;
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (comparableTarget.startsWith(comparable(prefix, platform))) return root;
  }
  return undefined;
}

/**
 * Resolve a peer-supplied `file_path` to a real path inside an open
 * workspace folder, or refuse it — CXP §11, and a MUST rather than a
 * nicety.
 *
 * ### The threat
 *
 * CXP's handshake token (wire 1.2) proves only that a peer can read the
 * user's files, and the manifest directory is user-writable: any process
 * running as the user can read our token, dial us — or publish a manifest,
 * be dialled — and send us `request_open_source` naming any path it likes.
 * "Open what the peer
 * asked for" therefore means "open what any local process asked for", and
 * opening a file in an editor is not passive — it renders the file, runs
 * language servers over it, and can trigger workspace-trust-gated tooling.
 *
 * ### The rule enforced here
 *
 * 1. A blank path is refused (`empty-path`).
 * 2. With no folder open, everything is refused (`no-workspace`) — there is
 *    no directory the user has consented to.
 * 3. The candidate is resolved with `realpath`, so **symlinks are followed
 *    before** the containment test. A symlink sitting inside the workspace
 *    and pointing at `~/.ssh/id_ed25519` resolves to `~/.ssh/id_ed25519`
 *    and is refused; a workspace folder that is *itself* reached through a
 *    symlink still matches, because the roots are resolved the same way.
 * 4. `..` segments are collapsed by `path.resolve` and then by `realpath`,
 *    so `/work/project/../../etc/passwd` is tested as `/etc/passwd`.
 * 5. The value returned is the resolved real path, and it is the value the
 *    caller opens. Check-one-string-open-another is the classic way this
 *    kind of guard is defeated.
 *
 * A relative `file_path` is tried against each open folder in order. The
 * spec calls `file_path` "presently an absolute path" (§9.6) but does not
 * forbid a relative one, and a relative path is *safer*: it cannot name
 * anything outside the folder it is joined to.
 */
export async function resolveWorkspacePath(
  filePath: string,
  options: WorkspacePathOptions,
): Promise<ResolvedWorkspacePath> {
  const realpath = options.realpath ?? nodeRealpath;
  const platform = options.platform ?? process.platform;

  if (filePath.trim().length === 0) return { ok: false, reason: 'empty-path' };
  if (options.workspaceFolders.length === 0) return { ok: false, reason: 'no-workspace' };

  // Resolve the roots first: a workspace opened through a symlink (a very
  // common `~/src -> /Volumes/work/src` setup) would otherwise fail to
  // contain any of its own files once the candidate is realpath'd.
  const roots: string[] = [];
  for (const folder of options.workspaceFolders) {
    roots.push((await realpathOrUndefined(folder, realpath)) ?? resolve(folder));
  }

  const candidates = isAbsolute(filePath)
    ? [resolve(filePath)]
    : options.workspaceFolders.map((folder) => join(folder, filePath));

  let sawMissingInsideWorkspace = false;
  for (const candidate of candidates) {
    const { real, exists } = await canonicalise(candidate, realpath);
    const root = containingRoot(real, roots, platform);
    // Containment is tested first, existence second. Answering `not-found`
    // for something outside the workspace would report on a file the peer
    // has no business asking about.
    if (root === undefined) continue;
    if (!exists) {
      sawMissingInsideWorkspace = true;
      continue;
    }
    return { ok: true, fsPath: real, root };
  }

  return { ok: false, reason: sawMissingInsideWorkspace ? 'not-found' : 'outside-workspace' };
}
