import { describe, expect, it } from 'vitest';
import { activate, deactivate, revealColumnBeside } from '../src/extension';

describe('wavecrux extension entry points', () => {
  it('exports activate and deactivate', () => {
    expect(typeof activate).toBe('function');
    expect(typeof deactivate).toBe('function');
  });
});

describe('where a waveform selection reveals its RTL', () => {
  it('never reveals into the group the waveform panel is in', () => {
    // The defect this exists for: `showTextDocument` with no column uses the
    // active group, and a waveform panel *is* an editor tab, so the source
    // opened on top of the panel the user had just clicked in — leaving the
    // second click of the gesture with nothing to click on. Live-verified,
    // not caught by any unit test before this one.
    for (const panelColumn of [1, 2, 3, undefined]) {
      expect(revealColumnBeside(panelColumn), String(panelColumn)).not.toBe(panelColumn);
    }
  });

  it('prefers the group to the right of a first-column panel', () => {
    expect(revealColumnBeside(1)).toBe(2);
  });

  it('sends everything else to the first group, where RTL usually already is', () => {
    // The waveform is opened `Beside` the source, so the source is in group
    // one; and an unassigned column must not fall back to the active group,
    // because the active group is exactly the one to avoid.
    expect(revealColumnBeside(2)).toBe(1);
    expect(revealColumnBeside(3)).toBe(1);
    expect(revealColumnBeside(undefined)).toBe(1);
  });
});
