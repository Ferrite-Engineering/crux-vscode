import { describe, expect, it } from 'vitest';
import { telemetry } from '@crux-vscode/host-core';
import { BufferByteSource } from '../src/editor/byte-source';
import { FSDB_FORMAT, SUPPORTED_WAVEFORM_FORMATS, waveformFormatFor } from '../src/formats';
import { MAX_OPEN_BYTES, planWaveformTransfer } from '../src/webview/open-waveform';
import { releaseContextWhenHidden, RELEASE_CONTEXT_ABOVE_BYTES } from '../src/editor/retention';
import {
  WaveformDocument,
  noticeFor,
  openTelemetryEvents,
  refusalReason,
} from '../src/editor/waveform-editor';

/** A document as `openCustomDocument` would have built it. */
function documentFor(
  name: string,
  sizeBytes: number,
  options: { delivered?: boolean } = {},
): WaveformDocument {
  const format = waveformFormatFor(name);
  const plan =
    format?.supported === true
      ? planWaveformTransfer(sizeBytes)
      : ({ mode: 'refused', totalBytes: sizeBytes, reason: 'too_large' } as const);
  const delivered = options.delivered ?? (format?.supported === true && plan.mode !== 'refused');
  return new WaveformDocument(
    { path: `/w/${name}`, toString: () => `file:///w/${name}` } as never,
    format,
    sizeBytes,
    plan,
    delivered ? new BufferByteSource(new Uint8Array(Math.min(sizeBytes, 16))) : undefined,
  );
}

describe('the unsupported-format path', () => {
  const fsdb = documentFor('chip.fsdb', 5_000_000);

  it('refuses FSDB with the app’s own explanation, not a new one', () => {
    // Voice matched to fsdbWebUnsupportedTitle / fsdbWebUnsupportedMessage in
    // wavecrux/lib/l10n/app_en.arb: what the limitation is, why it exists, and
    // what to do instead. One clause differs, because the thing that cannot
    // run fsdb2vcd here is an editor panel rather than a browser tab.
    const notice = noticeFor(fsdb);
    expect(notice?.title).toBe('FSDB needs the desktop app');
    expect(notice?.message).toContain('proprietary Synopsys format');
    expect(notice?.message).toContain('fsdb2vcd');
    expect(notice?.message).toContain('WaveCrux desktop app');
    expect(notice?.message).toContain('convert it to VCD or FST');
  });

  it('neither apologises nor wheedles', () => {
    const message = `${noticeFor(fsdb)?.title ?? ''} ${noticeFor(fsdb)?.message ?? ''}`;
    for (const word of ['sorry', 'unfortunately', 'please note', 'oops', 'upgrade now']) {
      expect(message.toLowerCase()).not.toContain(word);
    }
  });

  it('opens no byte source for a format it cannot read', () => {
    expect(fsdb.byteSource).toBeUndefined();
    expect(refusalReason(fsdb)).toBe('format_unsupported');
  });

  it('renders the app for every format it can read', () => {
    for (const format of SUPPORTED_WAVEFORM_FORMATS) {
      expect(noticeFor(documentFor(`top.${format.token}`, 1024))).toBeUndefined();
    }
    expect(FSDB_FORMAT.supported).toBe(false);
  });
});

describe('the large-file path', () => {
  it('explains the cap and names the alternative', () => {
    const notice = noticeFor(documentFor('top.fst', MAX_OPEN_BYTES + 1));
    expect(notice?.title).toContain('too large');
    // The cap is interpolated, not spelled out, so the sentence stays true if
    // the cap moves — and the assertion is on the *rendered* number, since
    // the `vscode` stand-in's `l10n.t` substitutes `{0}` exactly as VSCode
    // does. A source string that forgot its placeholder would fail here.
    expect(MAX_OPEN_BYTES / (1024 * 1024)).toBe(256);
    expect(notice?.message).toContain('256 MB');
    expect(notice?.message).toContain('WaveCrux desktop app');
  });

  it('says so for an empty file instead of showing an empty waveform', () => {
    const notice = noticeFor(documentFor('top.vcd', 0));
    expect(notice?.title).toBe('This waveform is empty');
    expect(refusalReason(documentFor('top.vcd', 0))).toBe('empty');
  });

  it('streams rather than refusing everything between the two bounds', () => {
    const document = documentFor('top.fst', 100 * 1024 * 1024);
    expect(noticeFor(document)).toBeUndefined();
    expect(document.plan.mode).toBe('chunked');
  });
});

describe('retainContextWhenHidden policy', () => {
  it('retains the context of an ordinary waveform', () => {
    expect(releaseContextWhenHidden(8 * 1024 * 1024)).toBe(false);
    expect(releaseContextWhenHidden(RELEASE_CONTEXT_ABOVE_BYTES)).toBe(false);
  });

  it('releases the context of one large enough to be worth reloading', () => {
    expect(releaseContextWhenHidden(RELEASE_CONTEXT_ABOVE_BYTES + 1)).toBe(true);
  });

  it('keeps the threshold inside the transfer cap — above it, nothing opens at all', () => {
    expect(RELEASE_CONTEXT_ABOVE_BYTES).toBeLessThan(MAX_OPEN_BYTES);
  });

  it('never releases on a size it cannot read', () => {
    expect(releaseContextWhenHidden(Number.NaN)).toBe(false);
  });
});

describe('the funnel events', () => {
  it('records format and a coarse bucket, never a byte count', () => {
    const events = openTelemetryEvents(documentFor('top.vcd', 12_345_678), { first: false });
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('file.opened');
    expect(events[0]?.properties).toEqual({
      format: 'vcd',
      size_bucket: 'medium',
      delivered: true,
    });
    // The one thing telemetry must never carry: the byte count itself.
    expect(JSON.stringify(events)).not.toContain('12345678');
  });

  it('records the first-open conversion exactly once', () => {
    const first = openTelemetryEvents(documentFor('top.vcd', 1024), { first: true });
    expect(first.map((event) => event.name)).toEqual(['file.opened', 'file.first_opened']);
    const later = openTelemetryEvents(documentFor('top.vcd', 1024), { first: false });
    expect(later.map((event) => event.name)).toEqual(['file.opened']);
  });

  it('does not count a refusal as a conversion', () => {
    const events = openTelemetryEvents(documentFor('chip.fsdb', 4096), { first: true });
    expect(events.map((event) => event.name)).toEqual(['file.opened']);
    expect(events[0]?.properties).toMatchObject({
      format: 'fsdb',
      delivered: false,
      reason: 'format_unsupported',
    });
  });

  it('distinguishes a refusal’s reasons — they point at opposite roadmaps', () => {
    expect(
      openTelemetryEvents(documentFor('top.fst', MAX_OPEN_BYTES + 1), { first: false })[0]
        ?.properties,
    ).toMatchObject({ delivered: false, reason: 'too_large' });
  });

  it('emits events host-core will actually keep', () => {
    // sanitizeTelemetryEvent drops an unrecognised name outright and an
    // invalid property silently. Either failure is invisible in production.
    const cases = [
      openTelemetryEvents(documentFor('top.vcd', 1024), { first: true }),
      openTelemetryEvents(documentFor('chip.fsdb', 1024), { first: true }),
      openTelemetryEvents(documentFor('top.fst', MAX_OPEN_BYTES + 1), { first: true }),
    ].flat();
    for (const event of cases) {
      const sanitized = telemetry.sanitizeTelemetryEvent(event);
      expect(sanitized).toBeDefined();
      expect(sanitized?.properties ?? {}).toEqual(event.properties ?? {});
    }
  });
});
