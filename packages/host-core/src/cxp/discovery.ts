import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Emitter } from './emitter';
import { isJsonObject } from './json';
import { decodeCxpPeerManifest, manifestEndpointKey, type CxpPeerManifest } from './manifest';
import { ensureCxpPrivateDirectory } from './private-files';
import { peerIdLiveness, PidLiveness, type PidLivenessValue } from './process-liveness';

/** Recommended manifest refresh interval (CXP §10.3). */
export const CXP_DEFAULT_MANIFEST_HEARTBEAT_MS = 30_000;
/** Recommended directory rescan interval (CXP §10.4). */
export const CXP_DEFAULT_SCAN_INTERVAL_MS = 2_000;
/** Recommended staleness threshold (CXP §10.4). */
export const CXP_DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;
/** How long a *foreign* stale manifest survives on disk. See [CxpDiscoveryOptions.reapThresholdMs]. */
export const CXP_DEFAULT_REAP_THRESHOLD_MS = 24 * 60 * 60_000;

/** A peer appearing in, or vanishing from, the manifest directory. */
export interface CxpDiscoveryEvent {
  /** True for a peer that appeared, false for one that vanished. */
  readonly added: boolean;
  /** The manifest that appeared or disappeared. */
  readonly manifest: CxpPeerManifest;
}

/** Construction options for [CxpDiscovery]. */
export interface CxpDiscoveryOptions {
  /** Directory holding `<peer_id>.json` files. Created if absent. */
  readonly manifestDirectory: string;
  /**
   * This process's own peer id.
   *
   * Two distinct effects, and the asymmetry between them **is** the
   * point — see the class docs:
   * - our own manifest is ignored when building the view (§10.4);
   * - our own manifest is deleted from disk *as soon as it is stale*,
   *   where a foreign one is not.
   */
  readonly selfPeerId?: string;
  /** Rescan period. Defaults to [CXP_DEFAULT_SCAN_INTERVAL_MS]. */
  readonly scanIntervalMs?: number;
  /**
   * Manifests whose `started_at` is older than this are dropped from the
   * view. Must stay comfortably above the 30 s heartbeat so one late
   * refresh does not evict a live peer (§10.4). Defaults to 5 minutes.
   */
  readonly staleThresholdMs?: number;
  /**
   * A stale *foreign* manifest is deleted from disk only once it is older
   * than this — long past the point where a merely-asleep-but-alive peer
   * would have re-freshened it on wake. Bounds on-disk accumulation
   * (a real machine has been found carrying 11 leftover manifests) without
   * reintroducing the on-wake mass-delete described in the class docs.
   * Defaults to 24 hours.
   */
  readonly reapThresholdMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Pid-liveness probe, injectable for tests. Defaults to
   * [peerIdLiveness], which reads the pid out of the peer id.
   */
  readonly livenessProbe?: (peerId: string) => PidLivenessValue;
}

/**
 * Watches the shared CXP manifest directory and reports which peers are
 * live (CXP §10.4).
 *
 * ### The pruning rule is asymmetric, and the asymmetry is the point
 *
 * "Prune stale manifests" is one sentence hiding two very different
 * decisions. Dropping a peer from *our view* is cheap and reversible: the
 * peer's next heartbeat brings it back two seconds later. Deleting its
 * *file* is neither — it destroys evidence another process owns.
 *
 * So:
 *
 * | Case | View | Disk |
 * |---|---|---|
 * | our own manifest, fresh | ignored (§10.4) | kept |
 * | our own manifest, stale | ignored | **deleted at once** |
 * | foreign, pid provably dead | dropped | **deleted at once** |
 * | foreign, stale, pid alive/unknown | dropped | kept until 24 h |
 * | orphaned `*.tmp` older than the stale cutoff | n/a | deleted |
 *
 * Deleting foreign files at the five-minute mark once turned a laptop
 * sleep into a suite-wide cross-product disconnect: on wake, every
 * product's 2 s scan runs before any product's 30 s heartbeat, so all four
 * apps deleted each other's manifests and every connector tore down every
 * link. The dead-pid row does **not** re-arm that, because it is a
 * definitive answer rather than an inference — an asleep-but-alive peer's
 * process still exists, so it never reads as dead.
 *
 * The *current* self manifest is exempt from the dead-pid reap: if this
 * code is running, our process is alive by construction, so a `dead`
 * reading for our own id can only be a recycled pid (or, in a test, a
 * synthetic one). A leftover self manifest from a prior crashed session
 * carries a *different* peer id — an older pid — so it is still reaped.
 *
 * DIVERGENCE from `crux_cxp`: its `CxpDiscovery` keeps a fresh self
 * manifest in the view and relies on the connector to skip it. §10.4 says
 * a peer MUST ignore its own manifest when scanning, so we drop it here
 * as well as in the connector; the connector's own self-check stays,
 * because it must be correct independently.
 */
export class CxpDiscovery {
  /** Directory holding `<peer_id>.json` manifest files. */
  readonly manifestDirectory: string;
  /** This process's own peer id, when known. */
  readonly selfPeerId: string | undefined;
  /** Rescan period in milliseconds. */
  readonly scanIntervalMs: number;
  /** View-staleness threshold in milliseconds. */
  readonly staleThresholdMs: number;
  /** Foreign-manifest disk-reap threshold in milliseconds. */
  readonly reapThresholdMs: number;

  /** Fires as peers appear and vanish. */
  readonly onEvent = new Emitter<CxpDiscoveryEvent>();

  private readonly now: () => number;
  private readonly livenessProbe: (peerId: string) => PidLivenessValue;
  private readonly known = new Map<string, CxpPeerManifest>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private scanning = false;

  constructor(options: CxpDiscoveryOptions) {
    this.manifestDirectory = options.manifestDirectory;
    this.selfPeerId = options.selfPeerId;
    this.scanIntervalMs = options.scanIntervalMs ?? CXP_DEFAULT_SCAN_INTERVAL_MS;
    this.staleThresholdMs = options.staleThresholdMs ?? CXP_DEFAULT_STALE_THRESHOLD_MS;
    this.reapThresholdMs = options.reapThresholdMs ?? CXP_DEFAULT_REAP_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
    this.livenessProbe = options.livenessProbe ?? ((peerId) => peerIdLiveness(peerId));
  }

  /** Whether [start] has been called and [stop] has not. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Snapshot of the peers currently believed live. Excludes ourselves. */
  get peers(): readonly CxpPeerManifest[] {
    return [...this.known.values()];
  }

  /**
   * Create the directory if absent, scan once, then rescan every
   * [scanIntervalMs]. The first scan completes before this resolves, so a
   * caller that starts the connector next already sees pre-existing peers.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Owner-only, as the manifest writer makes it: whichever of the two runs
    // first creates the directory that will hold every peer's token.
    await ensureCxpPrivateDirectory(this.manifestDirectory);
    await this.scanNow();
    if (!this.running) return;
    this.timer = setInterval(() => {
      void this.scanNow();
    }, this.scanIntervalMs);
    // Never hold the event loop open on discovery's account.
    this.timer.unref();
  }

  /** Stop rescanning. The view is retained; [start] resumes from it. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Run one scan.
   *
   * This is exactly what the interval timer calls; it is public so a
   * "refresh peers" command — and the tests — can drive discovery without
   * waiting out a tick. Overlapping calls are collapsed: a scan already in
   * flight makes this a no-op rather than doubling the I/O.
   */
  async scanNow(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.scan();
    } finally {
      this.scanning = false;
    }
  }

  private async scan(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.manifestDirectory);
    } catch {
      // Directory removed under us (a cleaner, a test teardown). The next
      // tick recreates nothing — start() owns creation — but a missing
      // directory simply means no peers.
      return;
    }

    const now = this.now();
    const staleCutoff = now - this.staleThresholdMs;
    const reapCutoff = now - this.reapThresholdMs;
    const found = new Map<string, CxpPeerManifest>();

    for (const entry of entries) {
      const path = join(this.manifestDirectory, entry);
      // Order matters: `<peer>.json.<micros>-<counter>.tmp` ends in `.tmp`
      // AND contains `.json`, and §10.2 requires a scanner to ignore
      // in-progress writes. Sweep first, then filter.
      if (entry.endsWith('.tmp')) {
        await this.sweepOrphanedTemp(path, staleCutoff);
        continue;
      }
      // §10.2: a scanner MUST ignore files not ending in `.json`.
      if (!entry.endsWith('.json')) continue;

      const manifest = await this.readManifest(path);
      if (manifest === undefined) continue;

      const peerId = manifest.identity.peerId;
      const isSelf = this.selfPeerId !== undefined && peerId === this.selfPeerId;

      // (a) Definitive pid liveness. A manifest whose owning process is
      // provably gone is reaped at once — file and view — regardless of
      // age or owner. Our own current manifest is exempt; see class docs.
      if (!isSelf && this.livenessProbe(peerId) === PidLiveness.dead) {
        await this.deleteQuietly(path);
        continue;
      }

      // (b) TTL. Always drops from the view; the file goes only under the
      // asymmetric rule.
      if (manifest.startedAt < staleCutoff) {
        if (isSelf || manifest.startedAt < reapCutoff) {
          await this.deleteQuietly(path);
        }
        continue;
      }

      // §10.4: a peer MUST ignore its own manifest when scanning.
      if (isSelf) continue;

      found.set(peerId, manifest);
    }

    dedupeByEndpoint(found);
    this.publish(found);
  }

  private async readManifest(path: string): Promise<CxpPeerManifest | undefined> {
    try {
      const text = await readFile(path, 'utf8');
      const decoded: unknown = JSON.parse(text);
      if (!isJsonObject(decoded)) return undefined;
      return decodeCxpPeerManifest(decoded, path);
    } catch {
      // Unreadable, half-written, or not a manifest at all. A foreign file
      // in a user-writable directory must never take the scanner down.
      return undefined;
    }
  }

  /**
   * Delete a `<peer>.json.<micros>-<counter>.tmp` scratch file left behind
   * when a manifest write succeeded but its rename did not.
   *
   * The rename that follows the temp write is effectively instantaneous,
   * so a temp file older than the stale cutoff cannot be a write in
   * progress — it is an orphan, and nothing else ever sweeps them.
   * Unlike manifests these are safe to delete regardless of owner,
   * precisely because a live writer's temp file is always younger than the
   * cutoff.
   */
  private async sweepOrphanedTemp(path: string, staleCutoff: number): Promise<void> {
    try {
      const info = await stat(path);
      if (info.mtimeMs < staleCutoff) await this.deleteQuietly(path);
    } catch {
      // Raced with the owning process's rename. Nothing to sweep.
    }
  }

  private async deleteQuietly(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch {
      // Best effort — raced with the owning process's write or delete.
    }
  }

  /**
   * Swap the view to [found] and announce the difference.
   *
   * **The view is updated BEFORE the events fire, and that ordering is
   * load-bearing.** A listener's natural handler is "something changed —
   * re-read [peers]", and with the events emitted first that read returns
   * the *previous* scan's view: an `added:false` handler still sees the
   * peer it was just told had vanished, and because the following scan
   * finds no further difference, no second event ever corrects it.
   *
   * Found by live verification, not by a test — every unit test here
   * asserts the emitted events, which were right the whole time. What was
   * wrong was what [peers] answered *during* them: a desktop app quit,
   * "Peer disconnected" appeared in the cross-probe panel's event log, and
   * the peer's row stayed in the list until something unrelated happened.
   */
  private publish(found: Map<string, CxpPeerManifest>): void {
    const previous = new Map(this.known);
    this.known.clear();
    for (const [peerId, manifest] of found) this.known.set(peerId, manifest);
    for (const [peerId, manifest] of found) {
      if (!previous.has(peerId)) this.onEvent.emit({ added: true, manifest });
    }
    for (const [peerId, manifest] of previous) {
      if (!found.has(peerId)) this.onEvent.emit({ added: false, manifest });
    }
  }
}

/**
 * Collapse manifests naming the same running endpoint down to one, newest
 * `started_at` winning.
 *
 * Two live manifests advertising the same product on the same `host:port`
 * cannot both be a distinct running peer — only one process can hold a
 * listening socket — so a momentarily-doubled manifest (an old file
 * lingering while a restarted peer rebinds the same port) must not surface
 * as two discovery rows, which has been observed happening. The loser is
 * dropped from the **view only**: deleting it here would be a foreign
 * delete at the five-minute mark by another name, and reaping belongs to
 * the liveness/TTL paths.
 *
 * Exported for the tests that pin this rule; the scanner is its only
 * production caller.
 */
export function dedupeByEndpoint(found: Map<string, CxpPeerManifest>): void {
  if (found.size < 2) return;
  const byEndpoint = new Map<string, CxpPeerManifest>();
  for (const manifest of found.values()) {
    const key = manifestEndpointKey(manifest);
    const existing = byEndpoint.get(key);
    if (existing === undefined || manifest.startedAt > existing.startedAt) {
      byEndpoint.set(key, manifest);
    }
  }
  if (byEndpoint.size === found.size) return;
  const winners = new Set([...byEndpoint.values()].map((m) => m.identity.peerId));
  for (const peerId of [...found.keys()]) {
    if (!winners.has(peerId)) found.delete(peerId);
  }
}
