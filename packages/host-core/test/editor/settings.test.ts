import { describe, expect, it } from 'vitest';
import {
  CROSS_PROBE_SETTING_KEYS,
  DEFAULT_CROSS_PROBE_SETTINGS,
  EDACRUX_CONFIGURATION_SECTION,
  readCrossProbeSettings,
} from '../../src/editor/settings';

describe('cross-probe settings', () => {
  it('lives under edacrux, not a product namespace', () => {
    // host-core is shared by all four extensions and a window is one peer
    // regardless of which are installed, so a window-level setting cannot
    // sit under one product's name.
    expect(EDACRUX_CONFIGURATION_SECTION).toBe('edacrux');
    expect(CROSS_PROBE_SETTING_KEYS.revealSelection).toBe('edacrux.crossProbe.revealSelection');
    expect(CROSS_PROBE_SETTING_KEYS.openSourceFocusesEditor).toBe(
      'edacrux.crossProbe.openSourceFocusesEditor',
    );
    expect(CROSS_PROBE_SETTING_KEYS.followWaveformSelection).toBe(
      'edacrux.crossProbe.followWaveformSelection',
    );
  });

  it('defaults the two inbound toggles on and the waveform follow off', () => {
    // The first two are *responses to an act in another application* — the
    // user did something in the desktop app and the point of it was to land
    // here. The third fires on every selection change in a panel the user is
    // already looking at, most of which are reading rather than a request to
    // navigate, so it is opt-in for the same reason
    // `edacrux.rtlAnnotation.enabled` is.
    expect(DEFAULT_CROSS_PROBE_SETTINGS).toEqual({
      revealSelection: true,
      openSourceFocusesEditor: true,
      followWaveformSelection: false,
    });
  });

  it('falls back to the documented defaults when the config API gives a non-boolean', () => {
    // Under the unit-test `vscode` stand-in, `getConfiguration()` is an
    // auto-mock whose `get()` returns a truthy proxy. Type-checking the
    // value is what keeps that from reading as "the user set it".
    expect(readCrossProbeSettings()).toEqual(DEFAULT_CROSS_PROBE_SETTINGS);
  });
});
