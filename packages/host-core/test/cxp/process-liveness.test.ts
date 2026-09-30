import { describe, expect, it } from 'vitest';
import { peerIdLiveness, pidLiveness, PidLiveness } from '../../src/cxp/process-liveness';

describe('pidLiveness', () => {
  it('reads this process as alive', () => {
    expect(pidLiveness(process.pid)).toBe(PidLiveness.alive);
  });

  it('refuses to answer for a pid that is not a positive integer', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(pidLiveness(pid)).toBe(PidLiveness.indeterminate);
    }
  });

  it('reads a Linux /proc entry without touching the target', () => {
    // Exercises the /proc branch on any host: the probe is injected, so
    // the platform switch is what is under test, not the filesystem.
    expect(
      pidLiveness(1234, { platform: 'linux', probe: () => PidLiveness.dead }),
    ).toBe(PidLiveness.dead);
  });
});

describe('peerIdLiveness', () => {
  it('is indeterminate for an id with no pid segment', () => {
    // A two-segment id — the shape `vscode-<hash>` would have had. Every
    // peer would fall back to the TTL for us.
    expect(peerIdLiveness('vscode-3f2a91c7')).toBe(PidLiveness.indeterminate);
  });

  it('reads the pid out of the second-to-last segment', () => {
    const seen: number[] = [];
    peerIdLiveness(`vscode-3f2a91c7-${process.pid}-1784742061000`, {
      probe: (pid) => {
        seen.push(pid);
        return PidLiveness.alive;
      },
    });
    expect(seen).toEqual([process.pid]);
  });

  it('reads a live four-segment id as alive end to end', () => {
    expect(peerIdLiveness(`vscode-3f2a91c7-${process.pid}-1784742061000`)).toBe(PidLiveness.alive);
  });
});
