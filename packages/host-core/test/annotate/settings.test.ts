import { describe, expect, it } from 'vitest';
import { EDACRUX_CONFIGURATION_SECTION } from '../../src/editor/settings';
import {
  DEFAULT_RTL_ANNOTATION_SETTINGS,
  RTL_ANNOTATION_SETTING_KEYS,
  readRtlAnnotationSettings,
} from '../../src/annotate/settings';
import { RTL_ANNOTATION_COMMAND_IDS } from '../../src/annotate/vscode-annotation';

describe('RTL annotation settings', () => {
  it('lives under edacrux, not a product namespace', () => {
    expect(EDACRUX_CONFIGURATION_SECTION).toBe('edacrux');
    expect(RTL_ANNOTATION_SETTING_KEYS.enabled).toBe('edacrux.rtlAnnotation.enabled');
  });

  it('is OFF by default', () => {
    // Not timidity. Every other setting here governs what happens when the
    // user asks for something; this one changes how their own source file
    // looks while they read it.
    expect(DEFAULT_RTL_ANNOTATION_SETTINGS).toEqual({ enabled: false });
  });

  it('falls back to off when the config API gives a non-boolean', () => {
    // Under the unit-test `vscode` stand-in, `getConfiguration().get()`
    // answers with a truthy auto-mock. Type-checking is what makes "off by
    // default" true rather than accidentally on.
    expect(readRtlAnnotationSettings().enabled).toBe(false);
  });
});

describe('RTL annotation commands', () => {
  it('are edacrux commands, because host-core owns the behaviour', () => {
    expect(RTL_ANNOTATION_COMMAND_IDS.toggle).toBe('edacrux.toggleRtlAnnotation');
    expect(RTL_ANNOTATION_COMMAND_IDS.pickSignal).toBe('edacrux.pickRtlAnnotationSignal');
  });
});
