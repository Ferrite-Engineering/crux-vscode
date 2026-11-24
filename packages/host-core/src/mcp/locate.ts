/**
 * Finds the headless binary that serves a product's `mcp` command.
 *
 * Order: the setting, then the places the platform keeps command-line
 * tools. The Pro binary wins over the open-core one wherever both exist,
 * across every directory, so a Pro install is never shadowed by an
 * open-core binary that happens to sit earlier on `PATH`.
 *
 * Why not the desktop app's install locations: the desktop app and the
 * headless binary are different programs, and on Linux the app can carry
 * the same file name as the Pro CLI (`<product>_pro`). Running an app with
 * `mcp --root ...` would open a window, so a candidate that sits in a
 * Flutter desktop bundle (it has `data/flutter_assets` beside it) is
 * skipped.
 */
import type { McpProductInfo } from './products';

/** Injected environment, so the search is testable on any platform. */
export interface LocateMcpDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory. */
  readonly home: string;
  readonly exists: (path: string) => boolean;
  readonly join: (...segments: string[]) => string;
  readonly dirname: (path: string) => string;
  readonly pathDelimiter: string;
}

/** Why a search ended where it did. */
export type McpBinaryResolution =
  | { readonly kind: 'found'; readonly path: string; readonly source: 'setting' | 'search' }
  | { readonly kind: 'setting-missing'; readonly path: string }
  | { readonly kind: 'not-found' };

/** Directories searched after `PATH`, because a GUI-launched VSCode often lacks the shell's `PATH`. */
function conventionalDirectories(deps: LocateMcpDeps): string[] {
  // Windows keeps its tools on `PATH`; there is no conventional extra place.
  if (deps.platform === 'win32') return [];
  const dirs = ['/usr/local/bin', deps.join(deps.home, '.local', 'bin')];
  if (deps.platform === 'darwin') dirs.unshift('/opt/homebrew/bin');
  return dirs;
}

function searchDirectories(deps: LocateMcpDeps): string[] {
  const fromPath = (deps.env['PATH'] ?? deps.env['Path'] ?? '')
    .split(deps.pathDelimiter)
    .filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  return [...fromPath, ...conventionalDirectories(deps)].filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

/** True when [file] sits in a Flutter desktop bundle (the app, not the CLI). */
function isDesktopBundle(file: string, deps: LocateMcpDeps): boolean {
  return deps.exists(deps.join(deps.dirname(file), 'data', 'flutter_assets'));
}

/**
 * Resolve the binary for [product].
 *
 * [configured] is the executable setting, already trimmed; empty means
 * unset. A configured path that does not exist is reported as such rather
 * than falling through to a search: a user who named a binary wants that
 * one, and silently running a different one is a wrong answer.
 */
export function locateMcpBinary(
  product: McpProductInfo,
  configured: string,
  deps: LocateMcpDeps,
): McpBinaryResolution {
  const suffix = deps.platform === 'win32' ? '.exe' : '';
  const directories = searchDirectories(deps);
  // The default value of SimCrux's existing executable setting is the bare
  // product name, which means "look it up", exactly as an empty value does.
  // Without this the Pro binary would never be preferred there.
  if (configured !== '' && configured !== product.product) {
    if (!/[\\/]/.test(configured)) {
      // A bare name the person chose: looked up on the search path.
      for (const directory of directories) {
        const candidate = deps.join(directory, `${configured}${suffix}`);
        if (deps.exists(candidate)) return { kind: 'found', path: candidate, source: 'setting' };
      }
      return { kind: 'setting-missing', path: configured };
    }
    return deps.exists(configured)
      ? { kind: 'found', path: configured, source: 'setting' }
      : { kind: 'setting-missing', path: configured };
  }
  for (const name of product.executableNames) {
    for (const directory of directories) {
      const candidate = deps.join(directory, `${name}${suffix}`);
      if (deps.exists(candidate) && !isDesktopBundle(candidate, deps)) {
        return { kind: 'found', path: candidate, source: 'search' };
      }
    }
  }
  return { kind: 'not-found' };
}
