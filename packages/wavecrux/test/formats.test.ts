import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { telemetry } from '@crux-vscode/host-core';
import {
  FSDB_FORMAT,
  SUPPORTED_WAVEFORM_FORMATS,
  WAVEFORM_FORMATS,
  WAVEFORM_VIEW_TYPE,
  baseName,
  waveformFormatFor,
} from '../src/formats';

interface CustomEditorContribution {
  readonly viewType: string;
  readonly displayName: string;
  readonly priority?: string;
  readonly selector: readonly { readonly filenamePattern: string }[];
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  contributes: { customEditors: readonly CustomEditorContribution[] };
};

const contribution = manifest.contributes.customEditors[0];

describe('custom editor registration', () => {
  it('contributes exactly one custom editor', () => {
    expect(manifest.contributes.customEditors).toHaveLength(1);
  });

  it('registers the view type the code registers', () => {
    // The manifest tells VSCode which viewType to look for and the code tells
    // VSCode which viewType it is providing. A mismatch produces an editor tab
    // that never resolves, with no error anywhere.
    expect(contribution?.viewType).toBe(WAVEFORM_VIEW_TYPE);
  });

  it('claims exactly the formats the code knows about, and no others', () => {
    const declared = (contribution?.selector ?? []).map((s) => s.filenamePattern).sort();
    const known = WAVEFORM_FORMATS.map((format) => format.selector).sort();
    expect(declared).toEqual(known);
  });

  it('claims the five open formats the WASM engines read', () => {
    expect(SUPPORTED_WAVEFORM_FORMATS.map((f) => f.selector)).toEqual([
      '*.vcd',
      '*.fst',
      '*.ghw',
      '*.lxt',
      '*.lxt2',
    ]);
  });

  it('claims FSDB too, so the refusal can be explained rather than implied', () => {
    // Unclaimed, VSCode hands the user its binary-file editor, which says
    // nothing about why WaveCrux is not showing the waveform.
    expect(WAVEFORM_FORMATS).toContain(FSDB_FORMAT);
    expect(FSDB_FORMAT.supported).toBe(false);
  });

  it('takes priority over the default binary editor', () => {
    // 'option' would mean the user has to pick WaveCrux from "Reopen Editor
    // With…" every time, which is the opposite of the discoverability this
    // whole surface exists for.
    expect(contribution?.priority).toBe('default');
  });

  it('localizes its display name through package.nls', () => {
    expect(contribution?.displayName).toMatch(/^%.+%$/);
  });
});

describe('waveformFormatFor', () => {
  it('recognises each claimed extension', () => {
    for (const format of WAVEFORM_FORMATS) {
      expect(waveformFormatFor(`/w/top.${format.token}`)?.token).toBe(format.token);
    }
  });

  it('does not mistake .lxt2 for .lxt', () => {
    expect(waveformFormatFor('/w/sim.lxt2')?.token).toBe('lxt2');
    expect(waveformFormatFor('/w/sim.lxt')?.token).toBe('lxt');
  });

  it('is case-insensitive — Windows and macOS both hand us TOP.VCD', () => {
    expect(waveformFormatFor('C:\\work\\TOP.VCD')?.token).toBe('vcd');
  });

  it('returns undefined for anything it does not claim', () => {
    expect(waveformFormatFor('/w/top.sv')).toBeUndefined();
    expect(waveformFormatFor('/w/README')).toBeUndefined();
    expect(waveformFormatFor('')).toBeUndefined();
  });

  it('does not match a bare extension with no dot', () => {
    expect(waveformFormatFor('vcd')).toBeUndefined();
  });
});

describe('format tokens as telemetry values', () => {
  it('survives host-core’s property-value vocabulary', () => {
    // A token that fails the pattern is dropped by
    // sanitizeTelemetryProperties, silently, and `file.opened` loses the one
    // dimension it exists to carry.
    for (const format of WAVEFORM_FORMATS) {
      expect(telemetry.isValidTelemetryPropertyStringValue(format.token)).toBe(true);
    }
    expect(telemetry.isValidTelemetryPropertyStringValue('unknown')).toBe(true);
  });
});

describe('baseName', () => {
  it('takes the last segment of a posix or windows path', () => {
    expect(baseName('/w/sim/top.vcd')).toBe('top.vcd');
    expect(baseName('C:\\work\\top.vcd')).toBe('top.vcd');
    expect(baseName('top.vcd')).toBe('top.vcd');
  });
});
