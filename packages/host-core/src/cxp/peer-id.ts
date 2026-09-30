import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { PeerIdentity } from './identity';

/**
 * `product_name` every EDACrux VSCode window announces (CXP §8.1).
 *
 * One name for the whole window, not one per installed extension: a window
 * is a single process holding a single CXP socket, so it is a single peer.
 * *Which* products that peer can act for is carried by `capabilities`,
 * composed from the registered surfaces — see `surface/`.
 */
export const VSCODE_PRODUCT_NAME = 'VSCode';

/** The `<product>` segment of every peer id we mint. */
export const VSCODE_PEER_ID_PREFIX = 'vscode';

/** Stand-in workspace key for a window with no folder open. */
const NO_WORKSPACE_KEY = '(no-workspace)';

/**
 * Eight lowercase hex characters derived from [workspaceFolder].
 *
 * Stable for a given folder across restarts and across the four extensions
 * in the same window, so a peer id stays recognisably "this project" in a
 * directory listing. Truncated to eight characters because it shares a
 * filename with three other segments and a full digest makes the manifest
 * name unreadable; collision risk is irrelevant — the hash is not the
 * uniqueness mechanism, the pid and start time are.
 *
 * `undefined` (a window with no folder open — a single loose file, or an
 * empty window) hashes a fixed sentinel rather than the empty string, so
 * two such windows are still distinguished by their pid, never by an
 * accidental collision with a real path that hashes the same.
 */
export function workspaceHash8(workspaceFolder: string | undefined): string {
  const key =
    workspaceFolder === undefined || workspaceFolder.length === 0
      ? NO_WORKSPACE_KEY
      : normaliseWorkspacePath(workspaceFolder);
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
}

function normaliseWorkspacePath(folder: string): string {
  const absolute = resolve(folder);
  // Strip trailing separators so `/a/b` and `/a/b/` are one workspace.
  let end = absolute.length;
  while (end > 1 && (absolute[end - 1] === sep || absolute[end - 1] === '/')) end -= 1;
  return absolute.slice(0, end);
}

/** Inputs to [mintVscodePeerId] / [createVscodePeerIdentity]. */
export interface VscodePeerIdOptions {
  /** Absolute path of the window's first workspace folder, if any. */
  readonly workspaceFolder?: string | undefined;
  /** Process id. Defaults to `process.pid`. */
  readonly pid?: number;
  /** Epoch milliseconds this peer began listening. Defaults to now. */
  readonly startedAt?: number;
}

/**
 * Mint this window's `peer_id`: `vscode-<workspaceHash8>-<pid>-<startedAtMillis>`.
 *
 * **A deliberate refinement of "`vscode-<stable hash of the workspace
 * folder>`", and the shape is load-bearing.** Taken literally that phrase
 * is a *two-segment* id, and `pidFromPeerId` — ours and, more importantly,
 * `crux_cxp`'s, which every Dart peer in the suite runs — reads the pid
 * from the **second-to-last** hyphen segment of the conventional
 * `<product>-<pid>-<startedAtMillis>` form and yields nothing for an id
 * with fewer than three segments. A two-segment id therefore reads as
 * `PidLiveness.indeterminate` on every peer, and a crashed VSCode window's
 * manifest would linger until the 24 h TTL instead of being reaped the
 * moment any peer next scans.
 *
 * Four segments keep the workspace-stable component the requirement asks
 * for, stay filename-legal, and put the pid exactly where every peer
 * already looks. Sample: `vscode-3f2a91c7-48213-1784742061000`.
 *
 * Neither the prefix nor the hash may ever contain a hyphen, or the pid
 * moves out from under the second-to-last segment.
 */
export function mintVscodePeerId(options: VscodePeerIdOptions = {}): string {
  const hash = workspaceHash8(options.workspaceFolder);
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  return `${VSCODE_PEER_ID_PREFIX}-${hash}-${pid}-${startedAt}`;
}

/** Inputs to [createVscodePeerIdentity]. */
export interface VscodePeerIdentityOptions extends VscodePeerIdOptions {
  /** The extension pack's version string. */
  readonly productVersion: string;
  /**
   * Capabilities to advertise. **Compose these from the registered
   * surfaces** (`surface/`'s `SurfaceRegistry.capabilities()`) — a window
   * with only the LintCrux extension installed must not advertise waveform
   * capabilities.
   */
  readonly capabilities?: readonly string[];
}

/** Build the [PeerIdentity] this window announces and publishes. */
export function createVscodePeerIdentity(options: VscodePeerIdentityOptions): PeerIdentity {
  return {
    peerId: mintVscodePeerId(options),
    productName: VSCODE_PRODUCT_NAME,
    productVersion: options.productVersion,
    capabilities: [...(options.capabilities ?? [])],
  };
}
