import { join } from 'node:path';

/**
 * Thrown when the shared CXP manifest directory cannot be resolved because
 * the platform's home / application-data environment variable is missing.
 *
 * This is **"discovery unavailable", not a crash**: a headless CI container
 * with no `HOME`, or a Windows service account with no `%APPDATA%`, simply
 * cannot participate in file-based peer discovery. Callers catch this and
 * run the extension without discovery — the CXP server still listens and
 * still accepts inbound connections. Mirrors the `StateError` that
 * `sharedCxpManifestDirectory()` throws in `crux_cxp`.
 */
export class CxpDiscoveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CxpDiscoveryUnavailableError';
  }
}

/** Injection points for [sharedCxpManifestDirectory]. */
export interface SharedCxpManifestDirectoryOptions {
  /** Environment to read. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Platform selector. Accepts Node's names (`darwin`, `win32`, `linux`)
   * and Dart's (`macos`, `windows`) so a test can be written against
   * either vocabulary. Defaults to `process.platform`.
   */
  readonly platform?: string;
}

/**
 * Resolves the suite-shared CXP manifest directory for this user.
 *
 * Discovery only works if every Crux product publishes into — and scans —
 * the **same** directory, so the trailing `crux/cxp/peers` segment is a
 * wire-level constant (CXP §10.1), not a preference. The base must be the
 * *user's* application-data root and **never an app-private container**:
 * macOS bundle-scoped Application Support, Windows `%APPDATA%\<org>\<app>`
 * and the like are private to one product, so every peer would publish
 * where no other peer looks. That was a real defect — each Dart product
 * resolved the directory through `path_provider` and cross-product
 * discovery was structurally impossible, including between a dev build and
 * an installed build of the *same* product.
 *
 * - **macOS**: `$HOME/Library/Application Support/crux/cxp/peers`
 * - **Windows**: `%APPDATA%\crux\cxp\peers`
 * - **Linux / other POSIX**:
 *   `${XDG_DATA_HOME:-$HOME/.local/share}/crux/cxp/peers`
 *
 * The exact port of `sharedCxpManifestDirectory()` in
 * `crux_cxp/lib/src/cxp_manifest_directory.dart`. VSCode's own
 * `ExtensionContext.globalStorageUri` is deliberately *not* used: it is
 * per-extension, which is precisely the app-private container this
 * resolver exists to avoid.
 *
 * @throws {CxpDiscoveryUnavailableError} when the required variable is
 * unset or empty.
 */
export function sharedCxpManifestDirectory(
  options: SharedCxpManifestDirectoryOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const requireEnv = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      throw new CxpDiscoveryUnavailableError(
        `sharedCxpManifestDirectory: $${name} is not set; cannot resolve the ` +
          'shared CXP manifest directory',
      );
    }
    return value;
  };

  let base: string;
  switch (platform) {
    case 'darwin':
    case 'macos':
      base = join(requireEnv('HOME'), 'Library', 'Application Support');
      break;
    case 'win32':
    case 'windows':
      base = requireEnv('APPDATA');
      break;
    default: {
      // Linux and other POSIX: honour XDG, fall back to ~/.local/share.
      const xdg = env['XDG_DATA_HOME'];
      base = xdg !== undefined && xdg.length > 0 ? xdg : join(requireEnv('HOME'), '.local', 'share');
      break;
    }
  }
  return join(base, 'crux', 'cxp', 'peers');
}
