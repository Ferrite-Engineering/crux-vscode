import { describe, expect, it } from 'vitest';
import {
  decodeElementId,
  decodeElementIdList,
  isKnownElementKind,
  KNOWN_ELEMENT_KINDS,
} from '../../src/cxp/element-id';
import { CxpFormatError } from '../../src/cxp/errors';
import {
  decodePeerIdentity,
  encodePeerIdentity,
  peerIdentityEquals,
  pidFromPeerId,
} from '../../src/cxp/identity';
import { CXP_PROTOCOL_VERSION, isCompatibleCxpVersion } from '../../src/cxp/version';

describe('PeerIdentity', () => {
  const wire = {
    peer_id: 'netcrux-4242-1700000000000',
    product_name: 'NetCrux',
    product_version: '0.1.0',
    capabilities: ['notify_selection', 'request_open_source'],
  } as const;

  it('round-trips', () => {
    expect(encodePeerIdentity(decodePeerIdentity(wire))).toEqual(wire);
  });

  it.each(['peer_id', 'product_name', 'product_version'])('requires "%s"', (field) => {
    const json: Record<string, unknown> = { ...wire };
    delete json[field];
    expect(() => decodePeerIdentity(json as never)).toThrow(`missing "${field}"`);
  });

  it('tolerates missing, non-list and non-string capabilities', () => {
    expect(decodePeerIdentity({ ...wire, capabilities: undefined } as never).capabilities).toEqual(
      [],
    );
    expect(decodePeerIdentity({ ...wire, capabilities: 'nope' }).capabilities).toEqual([]);
    expect(decodePeerIdentity({ ...wire, capabilities: ['a', 7, 'b'] }).capabilities).toEqual([
      'a',
      'b',
    ]);
  });

  it('collapses duplicate capabilities, as the Dart Set does', () => {
    expect(decodePeerIdentity({ ...wire, capabilities: ['a', 'a', 'b'] }).capabilities).toEqual([
      'a',
      'b',
    ]);
  });

  it('compares capabilities as a set', () => {
    const a = decodePeerIdentity({ ...wire, capabilities: ['x', 'y'] });
    const b = decodePeerIdentity({ ...wire, capabilities: ['y', 'x'] });
    expect(peerIdentityEquals(a, b)).toBe(true);
    expect(peerIdentityEquals(a, { ...a, peerId: 'other' })).toBe(false);
  });
});

describe('pidFromPeerId', () => {
  it('reads the pid from the SECOND-TO-LAST hyphen segment', () => {
    expect(pidFromPeerId('wavecrux-4242-1700000000000')).toBe(4242);
    // The VSCode form: an extra workspace-hash segment in front must not
    // move the pid out from under the reader.
    expect(pidFromPeerId('vscode-1a2b3c4d-4242-1700000000000')).toBe(4242);
  });

  it('yields nothing for an id with fewer than three segments', () => {
    // The trap this guards: a two-segment `vscode-<workspaceHash>` id
    // reads as indeterminate on every Dart peer, so a crashed extension's
    // manifest is only reaped by the 24 h TTL instead of immediately.
    expect(pidFromPeerId('vscode-1a2b3c4d')).toBeUndefined();
    expect(pidFromPeerId('wavecrux')).toBeUndefined();
  });

  it('yields nothing for a non-numeric or non-positive pid', () => {
    expect(pidFromPeerId('wavecrux-abc-123')).toBeUndefined();
    expect(pidFromPeerId('wavecrux-0-123')).toBeUndefined();
    expect(pidFromPeerId('wavecrux--123')).toBeUndefined();
  });
});

describe('ElementId', () => {
  it('round-trips a known kind', () => {
    expect(decodeElementId({ kind: 'signal', path: 'top.cpu.alu.result[7:0]' })).toEqual({
      kind: 'signal',
      path: 'top.cpu.alu.result[7:0]',
    });
  });

  it('accepts a kind this build does not model — the vocabulary is open', () => {
    expect(decodeElementId({ kind: 'quantum_flux', path: 'top.q' }).kind).toBe('quantum_flux');
    expect(isKnownElementKind('quantum_flux')).toBe(false);
    expect(isKnownElementKind('signal')).toBe(true);
  });

  it('defines the ten kinds of CXP §8.2', () => {
    expect([...KNOWN_ELEMENT_KINDS]).toEqual([
      'signal',
      'scope',
      'instance',
      'net',
      'port',
      'marker',
      'rule',
      'test',
      'breakpoint',
      'source',
    ]);
  });

  it('rejects a missing, mistyped or empty kind and a missing path', () => {
    expect(() => decodeElementId({ path: 'a' })).toThrow(CxpFormatError);
    expect(() => decodeElementId({ kind: '', path: 'a' })).toThrow('empty "kind"');
    expect(() => decodeElementId({ kind: 'signal' })).toThrow('missing "path"');
    expect(() => decodeElementId({ kind: 7, path: 'a' })).toThrow('missing "kind"');
  });

  it('skips non-object entries when decoding a list', () => {
    expect(decodeElementIdList([{ kind: 'signal', path: 'a' }, 'junk', 7])).toEqual([
      { kind: 'signal', path: 'a' },
    ]);
    expect(decodeElementIdList('not a list')).toEqual([]);
    expect(decodeElementIdList(undefined)).toEqual([]);
  });
});

describe('version negotiation', () => {
  it('speaks 1.2 — the version crux_cxp ships, with the authenticated handshake', () => {
    expect(CXP_PROTOCOL_VERSION).toBe('1.2');
  });

  it('accepts any 1.x, including a bare "1"', () => {
    for (const v of ['1.0', '1.1', '1.2', '1.9', '1.99', '1']) {
      expect(isCompatibleCxpVersion(v), v).toBe(true);
    }
  });

  it('rejects a different major, and anything unparseable', () => {
    for (const v of ['2.0', '0.9', '10.0', 'garbage', '']) {
      expect(isCompatibleCxpVersion(v), v).toBe(false);
    }
  });
});
