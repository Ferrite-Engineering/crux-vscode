import { describe, expect, it } from 'vitest';
import { status as hostStatus } from '@crux-vscode/host-core';
import {
  NETCRUX_PRODUCT,
  netCruxCapabilityCopy,
  netCruxCapabilityNotes,
  netCruxDesktopPitch,
  netCruxHandoffLabel,
} from '../../src/status/copy';

describe('netCruxCapabilityCopy', () => {
  it('supplies NetCrux’s words for NetCrux’s row', () => {
    expect(netCruxCapabilityCopy.desktopPitch?.(NETCRUX_PRODUCT)).toBe(netCruxDesktopPitch());
    expect(netCruxCapabilityCopy.handoffLabel?.(NETCRUX_PRODUCT)).toBe(netCruxHandoffLabel());
    expect(netCruxCapabilityCopy.capabilityNotes?.(NETCRUX_PRODUCT)).toEqual(
      netCruxCapabilityNotes(),
    );
  });

  it('falls back to host-core’s defaults for every other product', () => {
    // One copy hook serves all four rows, so this guard is what stops
    // NetCrux's sentences appearing under another product's name in a
    // multi-extension window.
    for (const product of ['wavecrux', 'lintcrux', 'simcrux'] as const) {
      expect(netCruxCapabilityCopy.desktopPitch?.(product)).toBe(
        hostStatus.defaultDesktopPitch(product),
      );
      expect(netCruxCapabilityCopy.handoffLabel?.(product)).toBe(
        hostStatus.defaultHandoffLabel(product),
      );
      expect(netCruxCapabilityCopy.capabilityNotes?.(product)).toEqual([]);
    }
  });
});

describe('the capability note states NetCrux’s boundary honestly', () => {
  it('says there is no schematic view here, and why', () => {
    const notes = netCruxCapabilityNotes().join('\n');
    expect(notes).toContain('no schematic view here by design');
    expect(notes).toContain('NetCrux Desktop');
  });

  it('is stated as a fact about the editor, never as an upsell', () => {
    for (const note of netCruxCapabilityNotes()) {
      expect(note).not.toMatch(/upgrade|buy|purchase|unlock|trial|sorry|unfortunately/i);
    }
  });
});

describe('the desktop pitch does not apologise for having no canvas', () => {
  it('states what NetCrux Desktop does rather than what the editor lacks', () => {
    const pitch = netCruxDesktopPitch();
    expect(pitch).not.toMatch(/sorry|unfortunately|apologi/i);
    expect(pitch).toContain('cone of influence');
  });
});
