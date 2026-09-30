import { surface } from '@crux-vscode/host-core';
import { describe, expect, it } from 'vitest';
import { NETCRUX_SURFACE, registerNetCruxSurface } from '../src/surface';

describe('the NetCrux CXP surface', () => {
  it('contributes no capabilities — NetCrux is a sender, not a receiver', () => {
    const registry = new surface.SurfaceRegistry();
    registerNetCruxSurface(registry);
    expect(registry.capabilities()).toEqual(['request_open_artifact', 'request_open_source']);
  });

  it('does not claim `request_highlight`, because nothing here routes one', () => {
    const registry = new surface.SurfaceRegistry();
    registerNetCruxSurface(registry);
    expect(registry.capabilities()).not.toContain('request_highlight');
    expect(NETCRUX_SURFACE.highlight).toBeUndefined();
  });

  it('still marks NetCrux as installed, so the capabilities panel shows its row', () => {
    const registry = new surface.SurfaceRegistry();
    registerNetCruxSurface(registry);
    expect(registry.has('netcrux')).toBe(true);
  });

  it('names the extension id the marketplace listing uses', () => {
    expect(NETCRUX_SURFACE.id).toBe('netcrux');
    expect(NETCRUX_SURFACE.extensionId).toBe('ferrite-engineering.netcrux');
  });

  it('is removed again when its registration is disposed', () => {
    const registry = new surface.SurfaceRegistry();
    const registration = registerNetCruxSurface(registry);
    registration.dispose();
    expect(registry.has('netcrux')).toBe(false);
  });
});
