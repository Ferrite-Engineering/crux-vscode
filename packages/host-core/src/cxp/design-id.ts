/**
 * `design_id` — the shared token that keys the shared workspace manifest and
 * rides on the wire as `crux.design_id` (CXP 1.1).
 *
 * A **port** of `crux_cxp`'s `cxpDesignIdForPath`
 * (`crux-shared/packages/crux_cxp/lib/src/cxp_design_id.dart`), not a second
 * convention. Three earlier prompts in this repo declined to send
 * `request_open_artifact` on the grounds that the id's derivation was
 * "owned by the Dart side" and a second copy would drift silently. The first
 * half of that was a misreading — the derivation is a fully specified,
 * deterministic function of a path and the filesystem, and the dartdoc's
 * "all four apps MUST use this one helper" is a warning about *divergence*,
 * not a claim that only Dart can compute it. The second half was right, and
 * is why `test/cxp/design-id-conformance.test.ts` exists: the two
 * implementations are run over one shared corpus and asserted
 * byte-identical, so a drift is a failing test rather than a join that
 * silently never happens.
 *
 * ### The derivation, in four steps
 *
 * 1. Normalize the input and strip any trailing separator.
 * 2. Resolve to the **containing directory** — the path itself when it is a
 *    directory, otherwise its parent. A file and the folder holding it
 *    therefore yield the same token, which is the whole point: a design is a
 *    folder, and each app passes its own primary input (WaveCrux the loaded
 *    waveform, SimCrux the `simcrux.yaml`, NetCrux the top source, LintCrux
 *    the `.lintcrux` project).
 * 3. Canonicalize that directory against the filesystem, **resolving
 *    symlinks**, when it exists; else fall back to a pure-path
 *    canonicalization so the function stays total for a design that has not
 *    been created yet.
 * 4. Return the first 16 hex characters of the `sha256` of the canonical
 *    directory path.
 *
 * ### Where a naive port would diverge — all four found by the conformance run
 *
 * - **Trailing separators.** Dart's `p.normalize('/a/b/')` is `/a/b`; Node's
 *   `path.normalize` keeps the trailing slash. Unfixed, `/a/b/` and `/a/b`
 *   hash differently on this side and identically on the other, so the two
 *   peers key the same folder two ways. [stripTrailingSeparators] is the fix
 *   and it is applied in both the filesystem and the lexical branch.
 * - **Case folding is a Windows rule, not a case-insensitive-filesystem
 *   rule.** `package:path`'s `canonicalize` lowercases only under the
 *   *Windows* style; on macOS it uses the POSIX style and does **not** fold,
 *   even though the volume is usually case-insensitive. Folding on darwin
 *   "because HFS+ is case-insensitive" would be a divergence in the direction
 *   nobody would ever look.
 * - **`realpath(3)`, not a re-implementation.** Dart's
 *   `Directory.resolveSymbolicLinksSync()` calls `realpath` on POSIX and
 *   `GetFinalPathNameByHandle` on Windows. Node's `fs.realpathSync` is a JS
 *   walk with its own caching semantics; `fs.realpathSync.native` is the
 *   same syscall Dart makes. On Windows that difference is visible — the
 *   native call is the one that returns the canonical casing.
 * - **The fallback canonicalizes the *directory*, not the input.** Step 2
 *   runs first and step 3's `catch` sees only its result. Canonicalizing the
 *   original path in the fallback would give a not-yet-created *file* its own
 *   token instead of its folder's.
 *
 * Every dependency is behind [DesignIdEnvironment] so the Windows flavour can
 * be exercised from a macOS or Linux test run — the lexical branch is pure,
 * and it is the branch whose platform rules differ.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path, { type PlatformPath } from 'node:path';

/** Shape of a `design_id`: 16 lowercase hex characters, and nothing else. */
export const CXP_DESIGN_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * The filesystem and path seams [cxpDesignIdForPath] uses.
 *
 * Defaults to the real filesystem and the running platform's `path`. Tests
 * inject a `win32`/`posix` flavour to check the lexical branch on any host.
 */
export interface DesignIdEnvironment {
  /** Whether [p] exists **and** is a directory, following symlinks. */
  readonly isDirectory: (p: string) => boolean;
  /** `realpath(3)` equivalent. **Throws** when the path does not exist. */
  readonly realpath: (p: string) => string;
  /** Path algebra — `node:path`, or its `posix` / `win32` flavour. */
  readonly path: PlatformPath;
  /** Working directory, for canonicalizing a relative path. */
  readonly cwd: () => string;
  /**
   * Whether pure-path canonicalization lowercases.
   *
   * `true` only for the Windows path style, mirroring `package:path`'s
   * `Style.windows.canonicalizePart`. Not a property of the filesystem.
   */
  readonly foldsCase: boolean;
}

/** The real environment: this process, this platform, this filesystem. */
export const NODE_DESIGN_ID_ENVIRONMENT: DesignIdEnvironment = {
  isDirectory(candidate: string): boolean {
    try {
      // `statSync` follows symlinks, exactly as Dart's
      // `FileSystemEntity.typeSync(followLinks: true)` default does — a
      // symlink pointing at a directory *is* a directory here.
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  },
  realpath(candidate: string): string {
    return realpathSync.native(candidate);
  },
  path,
  cwd: () => process.cwd(),
  foldsCase: process.platform === 'win32',
};

/**
 * [value] with any trailing separator removed, unless it *is* a root.
 *
 * Node's `path.normalize` preserves a trailing separator and Dart's
 * `p.normalize` removes it; this closes that gap. `/` stays `/`, `C:\` stays
 * `C:\`, `\\server\share\` stays whole — a root with its separator taken off
 * is a different path, not a tidier one.
 */
function stripTrailingSeparators(value: string, flavour: PlatformPath): string {
  const root = flavour.parse(value).root;
  let result = value;
  // Only `flavour.sep`: `normalize` has already rewritten every separator to
  // it, so a surviving `/` on the Windows flavour would be a literal
  // character in a name rather than a separator.
  while (result.length > root.length && result.endsWith(flavour.sep)) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * `p.canonicalize` — absolute, normalized, and (Windows only) case-folded.
 *
 * The fallback for a directory that does not exist. There is nothing on disk
 * to resolve symlinks against, so the answer is purely lexical; it is still
 * deterministic for the same lexical folder, which is what keeps the whole
 * function total for a design nobody has created yet.
 */
function canonicalizeLexically(directory: string, environment: DesignIdEnvironment): string {
  const flavour = environment.path;
  const absolute = flavour.isAbsolute(directory)
    ? flavour.normalize(directory)
    : flavour.normalize(flavour.join(environment.cwd(), directory));
  const stripped = stripTrailingSeparators(absolute, flavour);
  return environment.foldsCase ? stripped.toLowerCase() : stripped;
}

/**
 * The canonical absolute path of the directory that owns [input]'s design.
 *
 * Exported because the conformance corpus asserts the pre-hash step
 * independently of the digest: when the two implementations disagree, it is
 * always here, and a mismatched 16-hex token says nothing about *which* of
 * the four steps drifted.
 */
export function cxpDesignDirectoryForPath(
  input: string,
  environment: DesignIdEnvironment = NODE_DESIGN_ID_ENVIRONMENT,
): string {
  const flavour = environment.path;
  const normalized = stripTrailingSeparators(flavour.normalize(input), flavour);
  const directory = environment.isDirectory(normalized)
    ? normalized
    : flavour.dirname(normalized);
  try {
    return environment.realpath(directory);
  } catch {
    return canonicalizeLexically(directory, environment);
  }
}

/**
 * The `design_id` for the design that owns [fileOrDirPath].
 *
 * Total: a path that does not exist, a path with no read permission, and a
 * path whose parent was deleted between two calls all produce a token rather
 * than an error. Byte-identical to `crux_cxp`'s `cxpDesignIdForPath` for the
 * same input on the same machine — that is a tested property, not an
 * intention (`test/cxp/design-id-conformance.test.ts`).
 */
export function cxpDesignIdForPath(
  fileOrDirPath: string,
  environment: DesignIdEnvironment = NODE_DESIGN_ID_ENVIRONMENT,
): string {
  const canonicalDirectory = cxpDesignDirectoryForPath(fileOrDirPath, environment);
  return createHash('sha256').update(canonicalDirectory, 'utf8').digest('hex').slice(0, 16);
}
