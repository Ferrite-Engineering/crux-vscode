import { describe, expect, it } from 'vitest';
import { createVscodePeerIdentity } from '../src/cxp/peer-id';
import {
  BASE_VSCODE_CAPABILITIES,
  KNOWN_PEER_CAPABILITIES,
  SurfaceRegistry,
  type CruxSurface,
} from '../src/surface/index';

const WAVECRUX: CruxSurface = {
  id: 'wavecrux',
  extensionId: 'ferrite-engineering.wavecrux',
  capabilities: [
    KNOWN_PEER_CAPABILITIES.wavecruxSignalValue,
    KNOWN_PEER_CAPABILITIES.wavecruxCursorTimeFs,
    'request_highlight',
  ],
};

const LINTCRUX: CruxSurface = {
  id: 'lintcrux',
  extensionId: 'ferrite-engineering.lintcrux',
  capabilities: ['lintcrux.diagnostics'],
};

describe('SurfaceRegistry — capability composition', () => {
  it('advertises only the base capabilities with no surface installed', () => {
    const registry = new SurfaceRegistry();
    expect(registry.surfaces).toEqual([]);
    expect(registry.capabilities()).toEqual([...BASE_VSCODE_CAPABILITIES]);
    // A bare window can open a file at a line, and resolve an artifact for
    // a design through the shared workspace; it cannot highlight a signal,
    // because there is nothing to route that request to.
    expect(registry.capabilities()).toContain('request_open_source');
    expect(registry.capabilities()).toContain('request_open_artifact');
    expect(registry.capabilities()).not.toContain('request_highlight');
  });

  it('a window with only LintCrux does not advertise waveform capabilities', () => {
    const registry = new SurfaceRegistry();
    registry.register(LINTCRUX);
    const capabilities = registry.capabilities();
    expect(capabilities).toContain('lintcrux.diagnostics');
    expect(capabilities).not.toContain(KNOWN_PEER_CAPABILITIES.wavecruxSignalValue);
    expect(capabilities).not.toContain(KNOWN_PEER_CAPABILITIES.wavecruxCursorTimeFs);
    expect(capabilities).not.toContain('request_highlight');
  });

  it('unions the registered surfaces, deduplicated and sorted', () => {
    const registry = new SurfaceRegistry();
    registry.register(WAVECRUX);
    registry.register(LINTCRUX);
    registry.register({
      id: 'simcrux',
      extensionId: 'ferrite-engineering.simcrux',
      // Deliberately repeats one WaveCrux offers: the window advertises
      // it once.
      capabilities: ['request_highlight', 'simcrux.tests'],
    });
    expect(registry.capabilities()).toEqual([
      'lintcrux.diagnostics',
      'request_highlight',
      'request_open_artifact',
      'request_open_source',
      'simcrux.tests',
      'wavecrux.cursor_time_fs',
      'wavecrux.signal_value',
    ]);
  });

  it('is stable regardless of activation order', () => {
    const a = new SurfaceRegistry();
    a.register(WAVECRUX);
    a.register(LINTCRUX);
    const b = new SurfaceRegistry();
    b.register(LINTCRUX);
    b.register(WAVECRUX);
    expect(a.capabilities()).toEqual(b.capabilities());
  });

  it('drops a surface again when its registration is disposed', () => {
    const registry = new SurfaceRegistry();
    const registration = registry.register(WAVECRUX);
    expect(registry.has('wavecrux')).toBe(true);
    registration.dispose();
    expect(registry.has('wavecrux')).toBe(false);
    expect(registry.capabilities()).toEqual([...BASE_VSCODE_CAPABILITIES]);
    registration.dispose(); // idempotent
    expect(registry.capabilities()).toEqual([...BASE_VSCODE_CAPABILITIES]);
  });

  it('replaces a re-registered surface instead of doubling it', () => {
    const registry = new SurfaceRegistry();
    registry.register(WAVECRUX);
    registry.register({ ...WAVECRUX, capabilities: ['wavecrux.signal_value'] });
    expect(registry.surfaces).toHaveLength(1);
    expect(registry.capabilities()).toEqual([
      'request_open_artifact',
      'request_open_source',
      'wavecrux.signal_value',
    ]);
  });

  it('a stale disposal never unregisters the registration that replaced it', () => {
    // An extension that deactivates slowly must not tear down the
    // activation that took its place.
    const registry = new SurfaceRegistry();
    const stale = registry.register(WAVECRUX);
    registry.register({ ...WAVECRUX, capabilities: ['wavecrux.signal_value'] });
    stale.dispose();
    expect(registry.has('wavecrux')).toBe(true);
    expect(registry.capabilities()).toContain('wavecrux.signal_value');
  });

  it('announces the new capability list on every change', () => {
    const registry = new SurfaceRegistry();
    const seen: readonly string[][] = [];
    const announced: (readonly string[])[] = [...seen];
    registry.onDidChange.listen((capabilities) => announced.push(capabilities));
    const registration = registry.register(LINTCRUX);
    registration.dispose();
    expect(announced).toEqual([
      ['lintcrux.diagnostics', 'request_open_artifact', 'request_open_source'],
      ['request_open_artifact', 'request_open_source'],
    ]);
  });
});

describe('SurfaceRegistry — feeding the CXP identity', () => {
  it('is what the published identity advertises', () => {
    const registry = new SurfaceRegistry();
    registry.register(LINTCRUX);
    const identity = createVscodePeerIdentity({
      workspaceFolder: '/Users/dev/project',
      productVersion: '0.1.0',
      capabilities: registry.capabilities(),
      pid: 4242,
      startedAt: 1784742061000,
    });
    expect(identity.capabilities).toEqual([
      'lintcrux.diagnostics',
      'request_open_artifact',
      'request_open_source',
    ]);
    expect(identity.productName).toBe('VSCode');
  });
});
