import { surface } from '@crux-vscode/host-core';
import { describe, expect, it } from 'vitest';
import { LINTCRUX_SURFACE, registerLintCruxSurface } from '../src/surface';

describe('the LintCrux CXP surface', () => {
  it('advertises lint capabilities and nothing waveform-shaped', () => {
    const registry = new surface.SurfaceRegistry();
    registerLintCruxSurface(registry);
    const capabilities = registry.capabilities();
    expect(capabilities).toContain('lintcrux.diagnostics');
    expect(capabilities).not.toContain(surface.KNOWN_PEER_CAPABILITIES.wavecruxSignalValue);
    expect(capabilities).not.toContain(surface.KNOWN_PEER_CAPABILITIES.wavecruxCursorTimeFs);
  });

  it('does not claim `request_highlight`, because nothing here routes one', () => {
    const registry = new surface.SurfaceRegistry();
    registerLintCruxSurface(registry);
    expect(registry.capabilities()).not.toContain('request_highlight');
    expect(LINTCRUX_SURFACE.highlight).toBeUndefined();
  });

  it('keeps the base capability every window has', () => {
    const registry = new surface.SurfaceRegistry();
    registerLintCruxSurface(registry);
    expect(registry.capabilities()).toEqual([
      'lintcrux.diagnostics',
      'request_open_artifact',
      'request_open_source',
    ]);
  });

  it('names the extension id the marketplace listing uses', () => {
    expect(LINTCRUX_SURFACE.id).toBe('lintcrux');
    expect(LINTCRUX_SURFACE.extensionId).toBe('ferrite-engineering.lintcrux');
  });

  it('is removed again when its registration is disposed', () => {
    const registry = new surface.SurfaceRegistry();
    const registration = registerLintCruxSurface(registry);
    registration.dispose();
    expect(registry.has('lintcrux')).toBe(false);
    expect(registry.capabilities()).toEqual(['request_open_artifact', 'request_open_source']);
  });
});
