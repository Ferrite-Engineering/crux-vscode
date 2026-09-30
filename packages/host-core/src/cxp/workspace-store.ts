/**
 * The shared-workspace artifact link — a port of `crux_cxp`'s
 * `CxpWorkspaceStore` (`crux-shared/packages/crux_cxp/lib/src/cxp_workspace.dart`).
 *
 * ### What it is for
 *
 * `request_open_artifact` names a *design* and a *kind*, not a file: "open
 * the waveform for design `a3f…`". The mapping from the pair to a concrete
 * path is this store, one JSON document per design at
 * `<user-app-data>/crux/cxp/workspace/<design_id>.json`, sibling to the
 * `peers/` directory the same root resolves. File-based and server-free,
 * which is the suite's standing preference.
 *
 * ```json
 * {
 *   "design_id": "3f2a…",
 *   "artifacts": [
 *     {"kind": "waveform", "path": "/abs/cdc_capture.vcd", "producer": "simcrux", "ts": 0}
 *   ]
 * }
 * ```
 *
 * ### The join rule, restated because it is the part that is easy to get wrong
 *
 * The **producer** upserts under *its own* `design_id` with the artifact's
 * real absolute path. The **sender** attaches that same id to the message.
 * The **consumer** reads `crux.design_id` off the wire and looks it up — it
 * never re-derives an id from the artifact it is about to open. A consumer
 * that re-derived would key the *output* directory (a build tree, `/tmp`)
 * while the producer keyed the *input* directory, and the two would never
 * meet.
 *
 * ### Why the editor is a producer at all
 *
 * A VSCode window holds files open that no desktop app has ever seen. When
 * the user hands one to a desktop peer (`desktop-detect/artifact-handoff.ts`)
 * the receiver resolves through *its* copy of this store — LintCrux's handler
 * does not even look at the request's optional `path` hint — so a handoff
 * that skipped the upsert would be refused by a running app for a file the
 * user is looking at. Publishing first is what makes the protocol-native
 * handoff work rather than merely be sent.
 *
 * ### Deliberate simplifications against the Dart original
 *
 * Reads are `async` here where Dart's `readArtifacts` is sync. Dart could
 * afford `readAsStringSync` on a UI isolate; blocking the VSCode extension
 * host on a filesystem read is a frame the user's editor does not paint. No
 * behaviour differs — the document is the same, the pruning is the same, the
 * resolution order is the same.
 */
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeJsonAtomic } from './atomic-write';
import { asInteger, asString, isJsonObject, type JsonObject } from './json';
import { sharedCxpManifestDirectory, type SharedCxpManifestDirectoryOptions } from './manifest-directory';

/**
 * The shared workspace directory: the `peers/` sibling under the same
 * per-user root, so the two can never resolve under different bases.
 *
 * @throws {CxpDiscoveryUnavailableError} exactly as
 * [sharedCxpManifestDirectory] does.
 */
export function sharedCxpWorkspaceDirectory(
  options: SharedCxpManifestDirectoryOptions = {},
): string {
  return join(dirname(sharedCxpManifestDirectory(options)), 'workspace');
}

/** How long an entry survives without a refreshing upsert. Dart's default. */
export const CXP_WORKSPACE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** One produced file belonging to a shared design. */
export interface WorkspaceArtifact {
  /** Opaque artifact kind — `waveform`, `netlist`, `source`, … */
  readonly kind: string;
  /** Absolute path to the produced file. */
  readonly path: string;
  /** Short name of the producing product — `simcrux`, `vscode`, … */
  readonly producer: string;
  /** Milliseconds since epoch of the last upsert. Drives TTL pruning. */
  readonly ts: number;
  /** Optional top-module name — a descriptive resolver hint. */
  readonly topModule?: string;
  /** Optional file leaf. Absent means "the leaf of `path`". */
  readonly basename?: string;
}

/** The leaf used for descriptive matching: `basename` if set, else `path`'s. */
export function effectiveArtifactBasename(artifact: WorkspaceArtifact): string {
  return artifact.basename ?? basename(artifact.path);
}

function decodeArtifact(json: JsonObject): WorkspaceArtifact | undefined {
  const kind = asString(json['kind']);
  const path = asString(json['path']);
  const producer = asString(json['producer']);
  // A malformed entry is skipped, not fatal. This document is written by
  // four other products and by builds newer than this one; refusing the
  // whole design because one row is odd would lose the rows that are fine.
  if (kind === undefined || path === undefined || producer === undefined) return undefined;
  const topModule = asString(json['top_module']);
  const artifactBasename = asString(json['basename']);
  return {
    kind,
    path,
    producer,
    ts: asInteger(json['ts']) ?? 0,
    ...(topModule !== undefined ? { topModule } : {}),
    ...(artifactBasename !== undefined ? { basename: artifactBasename } : {}),
  };
}

function encodeArtifact(artifact: WorkspaceArtifact): JsonObject {
  return {
    kind: artifact.kind,
    path: artifact.path,
    producer: artifact.producer,
    ts: artifact.ts,
    ...(artifact.topModule !== undefined ? { top_module: artifact.topModule } : {}),
    ...(artifact.basename !== undefined ? { basename: artifact.basename } : {}),
  };
}

/** Construction options for [CxpWorkspaceStore]. */
export interface CxpWorkspaceStoreOptions {
  /** Directory holding `<design_id>.json`. Defaults to the shared one. */
  readonly workspaceDirectory: string;
  /** Entry TTL in milliseconds. Defaults to [CXP_WORKSPACE_DEFAULT_TTL_MS]. */
  readonly ttlMs?: number;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
  /** Whether a path exists on disk. Injectable for tests. */
  readonly exists?: (path: string) => Promise<boolean>;
}

/** What [CxpWorkspaceStore.upsertArtifact] records. */
export interface WorkspaceArtifactUpsert {
  readonly designId: string;
  readonly kind: string;
  readonly path: string;
  readonly producer: string;
  readonly topModule?: string;
  readonly basename?: string;
  readonly ts?: number;
}

/** Built from its code point so no raw NUL byte can ever land in this file. */
const NUL = String.fromCharCode(0);

/**
 * Whether [child] lies strictly inside [parent] — `p.isWithin` in Dart's
 * `package:path`, lexically: no filesystem access, the parent itself is not
 * within itself, and a sibling that merely shares a prefix (`/ws-evil` beside
 * `/ws`) is not within it. A child whose first segment is a name that merely
 * starts with two dots (`..json`, `..hidden.json`) IS within it.
 */
function isWithin(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent.length > 0 &&
    fromParent !== '..' &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * File-based store linking a design to the artifacts produced for it.
 *
 * Every method is best-effort about *reading*: a document that is missing,
 * truncated, or written by a newer build reads as "no artifacts" rather than
 * throwing, because a workspace link is a courtesy and must never break the
 * path that invoked it. Writing is not best-effort — [upsertArtifact]
 * propagates a write failure, so a handoff that could not publish knows it.
 */
export class CxpWorkspaceStore {
  private readonly workspaceDirectory: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly exists: (path: string) => Promise<boolean>;

  constructor(options: CxpWorkspaceStoreOptions) {
    this.workspaceDirectory = options.workspaceDirectory;
    this.ttlMs = options.ttlMs ?? CXP_WORKSPACE_DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.exists = options.exists ?? pathExists;
  }

  /**
   * Whether [designId] names a record file inside the workspace directory —
   * `CxpWorkspaceStore.isValidDesignId` in crux_cxp.
   *
   * A `design_id` is opaque on the wire (CXP §9.10.1) and arrives from a peer
   * on every `request_open_artifact`, so the one thing this store does with it
   * — turn it into a file name — has to be safe for any string. Joining it
   * onto the directory is not: a `..` segment walks out, and an absolute id
   * names a file anywhere (Dart's `p.join` drops the directory in front of
   * it; Node's `path.join` keeps it, and `path.resolve` — used here, so the
   * two agree — drops it again). An id that does not stay inside the
   * directory is a design with no records, which is the only truthful answer:
   * no record can exist for it.
   *
   * This is a containment check, not a parse: an id with a separator in it
   * (`designs/cdc_capture`) still keys a file one level down, as it always
   * has. Empty and NUL-bearing ids are refused outright.
   */
  isValidDesignId(designId: string): boolean {
    if (designId.length === 0 || designId.includes(NUL)) return false;
    return isWithin(this.workspaceDirectory, resolve(this.workspaceDirectory, `${designId}.json`));
  }

  /**
   * The `<design_id>.json` document path for [designId], or `undefined` when
   * the id does not stay inside the workspace directory — see
   * [isValidDesignId]. Every read and write goes through this, so no path a
   * peer chose is ever opened.
   */
  fileFor(designId: string): string | undefined {
    return this.isValidDesignId(designId)
      ? resolve(this.workspaceDirectory, `${designId}.json`)
      : undefined;
  }

  /**
   * Record — or refresh — the artifact of [kind] at [path] for a design.
   *
   * Keyed by (`path`, `kind`): a repeat call updates `ts` and any changed
   * descriptive fields rather than appending a duplicate. Stale entries are
   * pruned as part of the write, so ordinary producer activity bounds the
   * document without a separate sweeper.
   *
   * A `designId` that does not stay inside the workspace directory (see
   * [isValidDesignId]) records nothing and returns the empty list — nothing is
   * written anywhere, not even the directory. Every id the suite mints comes
   * from `cxpDesignIdForPath`, which cannot produce one; the guard is for ids
   * that arrived over the wire.
   */
  async upsertArtifact(upsert: WorkspaceArtifactUpsert): Promise<readonly WorkspaceArtifact[]> {
    if (!this.isValidDesignId(upsert.designId)) return [];
    const ts = upsert.ts ?? this.now();
    const current = await this.prune(await this.readRaw(upsert.designId));
    const next: WorkspaceArtifact[] = [];
    let replaced = false;
    for (const artifact of current) {
      if (artifact.path === upsert.path && artifact.kind === upsert.kind) {
        next.push({
          ...artifact,
          ts,
          producer: upsert.producer,
          ...(upsert.topModule !== undefined ? { topModule: upsert.topModule } : {}),
          ...(upsert.basename !== undefined ? { basename: upsert.basename } : {}),
        });
        replaced = true;
      } else {
        next.push(artifact);
      }
    }
    if (!replaced) {
      next.push({
        kind: upsert.kind,
        path: upsert.path,
        producer: upsert.producer,
        ts,
        ...(upsert.topModule !== undefined ? { topModule: upsert.topModule } : {}),
        ...(upsert.basename !== undefined ? { basename: upsert.basename } : {}),
      });
    }
    await this.write(upsert.designId, next);
    return next;
  }

  /** The stale-pruned artifacts recorded for [designId]. */
  async readArtifacts(designId: string): Promise<readonly WorkspaceArtifact[]> {
    return await this.prune(await this.readRaw(designId));
  }

  /**
   * The artifact of [kind] for [designId], by the reference
   * implementation's resolution order:
   *
   * 1. the only artifact of that kind, when there is exactly one;
   * 2. a `topModule` match, when a hint was given;
   * 3. a `basename`/leaf match, when a hint was given;
   * 4. otherwise the most recently upserted.
   *
   * `undefined` when the design has no artifact of that kind.
   */
  async resolveArtifact(
    designId: string,
    kind: string,
    hints: { readonly topModule?: string; readonly basename?: string } = {},
  ): Promise<WorkspaceArtifact | undefined> {
    if (!this.isValidDesignId(designId)) return undefined;
    const ofKind = (await this.readArtifacts(designId)).filter(
      (artifact) => artifact.kind === kind,
    );
    if (ofKind.length === 0) return undefined;
    if (ofKind.length === 1) return ofKind[0];

    if (hints.topModule !== undefined) {
      const match = ofKind.find((artifact) => artifact.topModule === hints.topModule);
      if (match !== undefined) return match;
    }
    if (hints.basename !== undefined) {
      const leaf = basename(hints.basename);
      const match = ofKind.find(
        (artifact) =>
          effectiveArtifactBasename(artifact) === leaf ||
          effectiveArtifactBasename(artifact) === hints.basename,
      );
      if (match !== undefined) return match;
    }
    return [...ofKind].sort((a, b) => b.ts - a.ts)[0];
  }

  /** Persist the stale-pruned set, deleting the document when it empties. */
  async pruneDesign(designId: string): Promise<readonly WorkspaceArtifact[]> {
    const raw = await this.readRaw(designId);
    const pruned = await this.prune(raw);
    if (pruned.length !== raw.length) await this.write(designId, pruned);
    return pruned;
  }

  /**
   * Drop entries whose file is gone or whose `ts` is older than the TTL.
   *
   * Existence pruning applies regardless of the TTL: an artifact whose file
   * was deleted is worse than a missing one, because a receiver would open
   * a stale path and report the failure as its own.
   */
  private async prune(
    artifacts: readonly WorkspaceArtifact[],
  ): Promise<readonly WorkspaceArtifact[]> {
    const cutoff = this.now() - this.ttlMs;
    const kept: WorkspaceArtifact[] = [];
    for (const artifact of artifacts) {
      if (artifact.ts < cutoff) continue;
      if (!(await this.exists(artifact.path))) continue;
      kept.push(artifact);
    }
    return kept;
  }

  private async readRaw(designId: string): Promise<readonly WorkspaceArtifact[]> {
    const file = this.fileFor(designId);
    if (file === undefined) return [];
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isJsonObject(decoded)) return [];
    const rawArtifacts = decoded['artifacts'];
    if (!Array.isArray(rawArtifacts)) return [];
    const result: WorkspaceArtifact[] = [];
    for (const entry of rawArtifacts) {
      if (!isJsonObject(entry)) continue;
      const artifact = decodeArtifact(entry);
      if (artifact !== undefined) result.push(artifact);
    }
    return result;
  }

  private async write(
    designId: string,
    artifacts: readonly WorkspaceArtifact[],
  ): Promise<void> {
    const file = this.fileFor(designId);
    // An id that cannot name a file inside the workspace has nothing to
    // write to; the callers return the (empty) list they computed, and
    // nothing lands outside the directory.
    if (file === undefined) return;
    if (artifacts.length === 0) {
      // An empty design document is noise; remove it rather than persist [].
      await rm(file, { force: true }).catch(() => undefined);
      return;
    }
    await writeJsonAtomic(file, {
      design_id: designId,
      artifacts: artifacts.map(encodeArtifact),
    });
  }
}

/** The `producer` string this editor writes into the shared workspace. */
export const VSCODE_WORKSPACE_PRODUCER = 'vscode';
