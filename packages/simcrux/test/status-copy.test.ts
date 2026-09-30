import { describe, expect, it } from 'vitest';
import { status as hostStatus } from '@crux-vscode/host-core';
import {
  SIMCRUX_PRODUCT,
  simCruxCapabilityCopy,
  simCruxCapabilityNotes,
  simCruxDesktopPitch,
  simCruxHandoffLabel,
} from '../src/status/copy';

describe('simCruxCapabilityCopy', () => {
  it('supplies SimCrux’s words for SimCrux’s row', () => {
    expect(simCruxCapabilityCopy.desktopPitch?.(SIMCRUX_PRODUCT)).toBe(simCruxDesktopPitch());
    expect(simCruxCapabilityCopy.handoffLabel?.(SIMCRUX_PRODUCT)).toBe(simCruxHandoffLabel());
    expect(simCruxCapabilityCopy.capabilityNotes?.(SIMCRUX_PRODUCT)).toEqual(
      simCruxCapabilityNotes(),
    );
  });

  it('falls back to host-core’s defaults for every other product', () => {
    // The copy object is one hook for all four rows, so this guard is the
    // whole of what stops SimCrux's sentences appearing under another
    // product's name in a multi-extension window.
    for (const product of ['wavecrux', 'lintcrux', 'netcrux'] as const) {
      expect(simCruxCapabilityCopy.desktopPitch?.(product)).toBe(
        hostStatus.defaultDesktopPitch(product),
      );
      expect(simCruxCapabilityCopy.handoffLabel?.(product)).toBe(
        hostStatus.defaultHandoffLabel(product),
      );
      expect(simCruxCapabilityCopy.capabilityNotes?.(product)).toEqual([]);
    }
  });
});

describe('the capability notes state the local-loop boundary', () => {
  it('says outright that this is not a fleet view', () => {
    const notes = simCruxCapabilityNotes().join('\n');
    expect(notes).toContain('local-iteration surface');
    expect(notes).toContain('not a view of a CI fleet');
  });

  it('names each of the four things the app does and this does not', () => {
    const notes = simCruxCapabilityNotes();
    expect(notes).toHaveLength(4);
    const joined = notes.join('\n');
    for (const subject of ['run history', 'Flakiness', 'comparison', 'trend']) {
      expect(joined.toLowerCase()).toContain(subject.toLowerCase());
    }
  });

  it('is stated as a fact about the editor, never as an upsell', () => {
    for (const note of simCruxCapabilityNotes()) {
      expect(note).not.toMatch(/upgrade|buy|purchase|unlock|trial/i);
    }
  });
});
