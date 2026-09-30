import { existsSync } from 'node:fs';
import { pidFromPeerId } from './identity';

/**
 * The outcome of asking whether a peer manifest's owning process is still
 * running on this machine.
 *
 * CXP peers are all localhost, single-user processes, so a manifest's pid
 * always names a process on *this* host — which makes a direct liveness
 * probe possible, and definitive where the platform supports one. When it
 * does not, the answer is `indeterminate` and callers fall back to the
 * time-to-live heuristic; a live-but-quiet peer must never be pruned on a
 * guess.
 */
export const PidLiveness = {
  /** The process is running. */
  alive: 'alive',
  /**
   * The process is definitively gone (`ESRCH`, or `/proc/<pid>` absent on
   * Linux). Safe to reap the manifest at once — this is *not* a
   * merely-asleep peer.
   */
  dead: 'dead',
  /**
   * Liveness could not be determined (a permission error, an unparseable
   * pid, an unknown platform). Callers must treat the manifest as present
   * and let the TTL decide.
   */
  indeterminate: 'indeterminate',
} as const;

/** One of the [PidLiveness] values. */
export type PidLivenessValue = (typeof PidLiveness)[keyof typeof PidLiveness];

/** Injection points for [pidLiveness]. */
export interface PidLivenessOptions {
  /** Platform selector; accepts Node and Dart names. Defaults to `process.platform`. */
  readonly platform?: string;
  /**
   * The raw probe. Defaults to a signal-0 `process.kill`. Injectable so a
   * test can assert the reaping policy without spawning processes.
   */
  readonly probe?: (pid: number) => PidLivenessValue;
}

/**
 * Whether the process named by [pid] is alive on this machine.
 *
 * The probe is deliberately **non-signalling** — it never delivers a real
 * signal to the target:
 *
 * - **Linux**: presence of `/proc/<pid>`, which needs no syscall against
 *   the target at all.
 * - **Everything else**: `process.kill(pid, 0)`, which sends no signal but
 *   throws `ESRCH` iff no such process exists. `EPERM` (a process owned by
 *   another user) is [PidLiveness.indeterminate], never `dead` — we must
 *   not reap on an ambiguous result.
 *
 * DIVERGENCE from `crux_cxp`: the Dart probe answers `indeterminate` on
 * Windows because pure Dart has no dependency-free probe there. Node's
 * `process.kill(pid, 0)` is documented to work on Windows, so we use it and
 * a crashed Windows peer's manifest is reaped promptly instead of waiting
 * out the 24 h TTL. This is safe in exactly the way the shared policy
 * requires: `dead` is a *definitive* answer, and being able to produce it
 * more often only ever removes files that could never have belonged to a
 * live peer.
 */
export function pidLiveness(pid: number, options: PidLivenessOptions = {}): PidLivenessValue {
  if (!Number.isInteger(pid) || pid <= 0) return PidLiveness.indeterminate;
  const probe = options.probe;
  if (probe !== undefined) return probe(pid);
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') {
    try {
      return existsSync(`/proc/${pid}`) ? PidLiveness.alive : PidLiveness.dead;
    } catch {
      return PidLiveness.indeterminate;
    }
  }
  return killZeroLiveness(pid);
}

function killZeroLiveness(pid: number): PidLivenessValue {
  try {
    process.kill(pid, 0);
    return PidLiveness.alive;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return PidLiveness.dead;
    // EPERM means the process exists but is owned by someone else; every
    // other code is an unknown failure. Neither may reap.
    return PidLiveness.indeterminate;
  }
}

/**
 * The liveness of the process that owns [peerId], or
 * [PidLiveness.indeterminate] when the id carries no parseable pid.
 *
 * See [pidFromPeerId] for why a peer id must keep its pid in the
 * second-to-last hyphen segment: an id shaped without one costs *every*
 * peer in the suite its fast crash detection for this peer.
 */
export function peerIdLiveness(peerId: string, options: PidLivenessOptions = {}): PidLivenessValue {
  const pid = pidFromPeerId(peerId);
  if (pid === undefined) return PidLiveness.indeterminate;
  return pidLiveness(pid, options);
}
