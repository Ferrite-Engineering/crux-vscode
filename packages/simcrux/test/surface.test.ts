import { describe, expect, it } from 'vitest';
import { surface } from '@crux-vscode/host-core';
import {
  SIMCRUX_RESULTS_CAPABILITY,
  SIMCRUX_SURFACE,
  registerSimCruxSurface,
} from '../src/surface';

describe('SIMCRUX_SURFACE', () => {
  it('registers under the product short name the four-product vocabulary uses', () => {
    expect(SIMCRUX_SURFACE.id).toBe('simcrux');
  });

  it('composes its extension id from host-core rather than spelling it', () => {
    expect(SIMCRUX_SURFACE.extensionId).toBe('ferrite-engineering.simcrux');
  });

  it('advertises exactly one capability', () => {
    expect(SIMCRUX_SURFACE.capabilities).toEqual([SIMCRUX_RESULTS_CAPABILITY]);
  });

  it('registers no highlight handler, and therefore claims no highlight capability', () => {
    // A capability is a promise the sender need not defend against
    // `unsupported`; advertising a kind nothing routes costs a peer a round
    // trip to learn we lied.
    expect(SIMCRUX_SURFACE.highlight).toBeUndefined();
    expect(SIMCRUX_SURFACE.capabilities).not.toContain('request_highlight');
  });

  it('claims nothing waveform-shaped, even though it can open a counterexample', () => {
    // It opens one by asking WaveCrux's editor to. That capability belongs
    // to WaveCrux's surface and disappears with WaveCrux's extension.
    expect(SIMCRUX_SURFACE.capabilities.join(' ')).not.toContain('wavecrux');
    expect(SIMCRUX_SURFACE.capabilities.join(' ')).not.toContain('signal');
  });
});

describe('registerSimCruxSurface', () => {
  it('adds its capability to the window’s composed list', () => {
    const registry = new surface.SurfaceRegistry();
    expect(registry.capabilities()).toEqual(['request_open_artifact', 'request_open_source']);
    registerSimCruxSurface(registry);
    // Sorted, so two windows with the same extensions publish identical
    // manifests whatever order they activated in.
    expect(registry.capabilities()).toEqual([
      'request_open_artifact',
      'request_open_source',
      SIMCRUX_RESULTS_CAPABILITY,
    ]);
  });

  it('removes it again on dispose, so an uninstalled extension stops advertising', () => {
    const registry = new surface.SurfaceRegistry();
    const registration = registerSimCruxSurface(registry);
    registration.dispose();
    expect(registry.capabilities()).toEqual(['request_open_artifact', 'request_open_source']);
    expect(registry.has('simcrux')).toBe(false);
  });

  it('does not double the capability when the extension reactivates', () => {
    const registry = new surface.SurfaceRegistry();
    registerSimCruxSurface(registry);
    registerSimCruxSurface(registry);
    // Sorted, so two windows with the same extensions publish identical
    // manifests whatever order they activated in.
    expect(registry.capabilities()).toEqual([
      'request_open_artifact',
      'request_open_source',
      SIMCRUX_RESULTS_CAPABILITY,
    ]);
  });
});
