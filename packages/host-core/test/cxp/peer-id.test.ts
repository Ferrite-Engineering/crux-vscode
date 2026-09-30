import { describe, expect, it } from 'vitest';
import { pidFromPeerId } from '../../src/cxp/identity';
import {
  createVscodePeerIdentity,
  mintVscodePeerId,
  VSCODE_PRODUCT_NAME,
  workspaceHash8,
} from '../../src/cxp/peer-id';

describe('mintVscodePeerId', () => {
  it('mints vscode-<workspaceHash8>-<pid>-<startedAtMillis>', () => {
    const peerId = mintVscodePeerId({
      workspaceFolder: '/Users/dev/project',
      pid: 48213,
      startedAt: 1784742061000,
    });
    expect(peerId).toMatch(/^vscode-[0-9a-f]{8}-48213-1784742061000$/);
    expect(peerId.split('-')).toHaveLength(4);
  });

  it('puts the pid where every Dart peer looks for it', () => {
    // The reason the id is four segments and not two: pidFromPeerId reads
    // the second-to-last segment, and a two-segment id yields nothing, so
    // a crashed window's manifest would linger until the 24 h TTL.
    const peerId = mintVscodePeerId({ workspaceFolder: '/w', pid: 4242, startedAt: 1 });
    expect(pidFromPeerId(peerId)).toBe(4242);
  });

  it('pins that a two-segment id carries no pid', () => {
    expect(pidFromPeerId('vscode-3f2a91c7')).toBeUndefined();
  });

  it('defaults the pid and start time to this process and now', () => {
    const before = Date.now();
    const peerId = mintVscodePeerId({ workspaceFolder: '/w' });
    expect(pidFromPeerId(peerId)).toBe(process.pid);
    const startedAt = Number(peerId.split('-').at(-1));
    expect(startedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('workspaceHash8', () => {
  it('is stable for the same folder', () => {
    expect(workspaceHash8('/Users/dev/project')).toBe(workspaceHash8('/Users/dev/project'));
  });

  it('ignores a trailing separator', () => {
    expect(workspaceHash8('/Users/dev/project/')).toBe(workspaceHash8('/Users/dev/project'));
  });

  it('differs between folders', () => {
    expect(workspaceHash8('/Users/dev/a')).not.toBe(workspaceHash8('/Users/dev/b'));
  });

  it('is eight lowercase hex characters, so the id stays filename-legal', () => {
    expect(workspaceHash8('/Users/dev/project')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('never contains a hyphen, which would move the pid segment', () => {
    for (const folder of ['/a-b/c-d', '/Users/dev/my-project', undefined]) {
      expect(workspaceHash8(folder)).not.toContain('-');
    }
  });

  it('hashes a sentinel for a window with no folder open', () => {
    expect(workspaceHash8(undefined)).toBe(workspaceHash8(''));
    expect(workspaceHash8(undefined)).not.toBe(workspaceHash8('/'));
  });
});

describe('createVscodePeerIdentity', () => {
  it('announces one product name for the whole window', () => {
    const identity = createVscodePeerIdentity({
      workspaceFolder: '/w',
      productVersion: '0.1.0',
      capabilities: ['request_open_source'],
      pid: 7,
      startedAt: 8,
    });
    expect(identity.productName).toBe(VSCODE_PRODUCT_NAME);
    expect(identity.productName).toBe('VSCode');
    expect(identity.productVersion).toBe('0.1.0');
    expect(identity.peerId).toBe(`vscode-${workspaceHash8('/w')}-7-8`);
  });

  it('advertises exactly the capabilities it is given, and none by default', () => {
    expect(
      createVscodePeerIdentity({ workspaceFolder: '/w', productVersion: '0.1.0' }).capabilities,
    ).toEqual([]);
    expect(
      createVscodePeerIdentity({
        workspaceFolder: '/w',
        productVersion: '0.1.0',
        capabilities: ['lintcrux.diagnostics'],
      }).capabilities,
    ).toEqual(['lintcrux.diagnostics']);
  });
});
