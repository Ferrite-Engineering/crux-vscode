import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDACRUX_CONFIGURATION_SECTION } from '../../src/editor/settings';
import {
  DEFAULT_RTL_ANNOTATION_SETTINGS,
  RTL_ANNOTATION_SETTING_KEYS,
  readRtlAnnotationSettings,
} from '../../src/annotate/settings';
import {
  RTL_ANNOTATION_AMBIGUOUS_COLOR_ID,
  RTL_ANNOTATION_COLOR_ID,
  RTL_ANNOTATION_COMMAND_IDS,
} from '../../src/annotate/vscode-annotation';

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

describe('RTL annotation colours', () => {
  interface ColorContribution {
    readonly id: string;
    readonly description: string;
    readonly defaults: Readonly<Record<string, string>>;
  }

  function readJson<T>(relative: string): T {
    return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as T;
  }

  // WaveCrux is the one extension that registers the annotator, so its
  // manifest is the one that must contribute the ids the renderer paints with.
  const colors =
    readJson<{ contributes?: { colors?: readonly ColorContribution[] } }>(
      '../../../wavecrux/package.json',
    ).contributes?.colors ?? [];
  const nls = readJson<Record<string, string>>('../../package.nls.json');

  it('are contributed under edacrux ids, defaulting to the stock colours in every theme kind', () => {
    // Nothing changes unless a theme or the user asks: the default is the
    // colour used before the id existed.
    const expected: Record<string, string> = {
      [RTL_ANNOTATION_COLOR_ID]: 'editorCodeLens.foreground',
      [RTL_ANNOTATION_AMBIGUOUS_COLOR_ID]: 'editorWarning.foreground',
    };
    expect(colors.map((c) => c.id).sort()).toEqual(Object.keys(expected).sort());
    for (const color of colors) {
      expect(color.defaults, color.id).toEqual({
        dark: expected[color.id],
        light: expected[color.id],
        highContrast: expected[color.id],
        highContrastLight: expected[color.id],
      });
    }
  });

  it('are not CodeLens itself, so recolouring them leaves CodeLenses alone', () => {
    expect(RTL_ANNOTATION_COLOR_ID).not.toBe('editorCodeLens.foreground');
    expect(RTL_ANNOTATION_AMBIGUOUS_COLOR_ID).not.toBe('editorWarning.foreground');
  });

  it('have localized descriptions that host-core owns', () => {
    for (const color of colors) {
      const key = /^%(.+)%$/.exec(color.description)?.[1];
      expect(key, color.id).toBeDefined();
      expect(nls[key ?? ''], color.id).toBeTruthy();
    }
  });
});
