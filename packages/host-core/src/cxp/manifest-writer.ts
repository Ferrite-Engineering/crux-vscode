import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cxpProcessAuthToken } from './auth-token';
import { CXP_DEFAULT_MANIFEST_HEARTBEAT_MS } from './discovery';
import type { PeerIdentity } from './identity';
import { encodeCxpPeerManifest, type CxpPeerManifest } from './manifest';
import { ensureCxpPrivateDirectory, writeJsonPrivateAtomic } from './private-files';

/** Construction options for [CxpManifestWriter]. */
export interface CxpManifestWriterOptions {
  /** Directory the manifest is published into. Created owner-only if absent. */
  readonly manifestDirectory: string;
  /**
   * Period between automatic `started_at` refreshes. `null` disables the
   * heartbeat — **only** for tests that assert on a single write, never in
   * production; see the class docs for why.
   */
  readonly heartbeatIntervalMs?: number | null;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The token published in the manifest as the one diallers must present
   * (wire 1.2). Defaults to [cxpProcessAuthToken], which is also what
   * [LocalCxpServer] requires by default, so a caller that constructs both
   * with defaults needs no wiring between them. Pass the server's
   * `authToken` explicitly when it was given one.
   */
  readonly authToken?: string;
}

/**
 * Publishes this peer's `<peer_id>.json` manifest and — the part that is
 * easy to skip and fatal to skip — **keeps it fresh**.
 *
 * ### The heartbeat is not optional
 *
 * CXP §10.3 calls this out as *the single most common way a
 * conforming-looking implementation silently fails*: a peer that publishes
 * once, listens correctly, and never refreshes accepts connections
 * normally until it crosses every other peer's staleness threshold, at
 * which point they all prune it and stop dialling — with no error
 * anywhere. It is not a warning drawn from theory. Historically the refresh
 * was documented as each Dart product's responsibility and no product
 * implemented it, which was the "peer vanishes after five minutes" half of
 * the suite's cross-discovery defect. So the writer owns the schedule
 * rather than trusting a caller to run one.
 *
 * Every write — the first and every refresh — is atomic (tmp-then-rename,
 * §10.2), so a scanner never reads a torn manifest.
 *
 * Every write also publishes [authToken] (wire 1.2), the token this peer's
 * server requires in a `hello`, so every write is owner-only on POSIX
 * (§10.1–10.2): the manifest directory, and each directory created on the
 * way to it, is `0700`, and the manifest is `0600` before the token is
 * written into it. A token proves file access only if other users cannot
 * read it — see `private-files.ts` for the case that makes this more than a
 * formality, and `auth-token.ts` for what the token is for.
 */
export class CxpManifestWriter {
  /** Directory the manifest is published into. */
  readonly manifestDirectory: string;
  /** Heartbeat period in milliseconds, or null when disabled. */
  readonly heartbeatIntervalMs: number | null;
  /** The token published in every manifest this writer writes. Never log it. */
  readonly authToken: string;

  private readonly now: () => number;
  private published: { identity: PeerIdentity; host: string; port: number } | undefined;
  private path: string | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly writing = new Set<Promise<void>>();

  constructor(options: CxpManifestWriterOptions) {
    this.manifestDirectory = options.manifestDirectory;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs === undefined
        ? CXP_DEFAULT_MANIFEST_HEARTBEAT_MS
        : options.heartbeatIntervalMs;
    this.now = options.now ?? Date.now;
    this.authToken = options.authToken ?? cxpProcessAuthToken();
  }

  /** Path of the published manifest, or undefined when nothing is published. */
  get manifestPath(): string | undefined {
    return this.path;
  }

  /**
   * Publish a manifest for [identity] listening on `host:port`, then start
   * the heartbeat. Overwrites any existing manifest for the same peer id.
   */
  async write(options: {
    readonly identity: PeerIdentity;
    readonly host: string;
    readonly port: number;
  }): Promise<void> {
    this.published = { identity: options.identity, host: options.host, port: options.port };
    await this.writeOnce();
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const interval = this.heartbeatIntervalMs;
    if (interval !== null) {
      this.heartbeat = setInterval(() => {
        void this.refresh();
      }, interval);
      this.heartbeat.unref();
    }
  }

  /**
   * Rewrite the manifest with a fresh `started_at`.
   *
   * This is what the heartbeat timer calls; it is public so a caller that
   * has just changed the advertised capabilities (a product extension
   * activating mid-session) can republish immediately instead of waiting
   * out a beat. A no-op when nothing is published.
   *
   * Failures are swallowed: a refresh that cannot write is retried on the
   * next beat, and a persistently unwritable directory degrades to the
   * pre-heartbeat behaviour (peers prune us at their stale threshold)
   * rather than taking down a timer callback with an unhandled rejection.
   */
  async refresh(): Promise<void> {
    if (this.published === undefined) return;
    try {
      await this.writeOnce();
    } catch {
      // Best effort; retried on the next beat.
    }
  }

  /**
   * Delete our manifest and stop the heartbeat.
   *
   * The **clean-shutdown hook**. It must run both on a deliberate
   * CXP shutdown and on extension `deactivate`, so our manifest never
   * lingers for peers to re-dial after the window is gone. A crash that
   * skips it is still handled — peers reap by pid liveness the moment they
   * next scan — but a clean exit must not lean on that. Idempotent.
   *
   * Writes already in flight are waited out before the delete: otherwise a
   * heartbeat's rename lands after it and republishes the manifest of a peer
   * that has gone.
   */
  async remove(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.published = undefined;
    await Promise.allSettled([...this.writing]);
    const path = this.path;
    this.path = undefined;
    if (path === undefined) return;
    try {
      await rm(path, { force: true });
    } catch {
      // Best effort — the file may already be gone.
    }
  }

  /** Alias for [remove], matching the suite's dispose convention. */
  async dispose(): Promise<void> {
    await this.remove();
  }

  private async writeOnce(): Promise<void> {
    const write = this.writeManifest();
    this.writing.add(write);
    try {
      await write;
    } finally {
      this.writing.delete(write);
    }
  }

  private async writeManifest(): Promise<void> {
    const published = this.published;
    if (published === undefined) return;
    const path = join(this.manifestDirectory, `${published.identity.peerId}.json`);
    const manifest: CxpPeerManifest = {
      identity: published.identity,
      host: published.host,
      port: published.port,
      startedAt: this.now(),
      manifestPath: path,
      token: this.authToken,
    };
    await ensureCxpPrivateDirectory(this.manifestDirectory);
    await writeJsonPrivateAtomic(path, encodeCxpPeerManifest(manifest));
    this.path = path;
  }
}
