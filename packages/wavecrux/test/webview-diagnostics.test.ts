import { describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_MESSAGE_TYPE } from '../src/webview/html';
import {
  coldStartMs,
  formatDiagnostic,
  isFailure,
  parseDiagnostic,
} from '../src/webview/diagnostics';
import {
  CXP_MESSAGE_TYPE,
  TELEMETRY_MESSAGE_TYPE,
  handleWebviewMessage,
  webviewResourceBase,
} from '../src/webview/panel';

describe('webviewResourceBase', () => {
  it('decodes the %2B in the webview authority that Dart would re-encode', () => {
    expect(
      webviewResourceBase('https://file%2B.vscode-resource.vscode-cdn.net/Users/x/media'),
    ).toBe('https://file+.vscode-resource.vscode-cdn.net/Users/x/media');
  });

  it('leaves the path encoded, so a directory with a space still resolves', () => {
    expect(
      webviewResourceBase('https://file%2B.vscode-resource.vscode-cdn.net/Users/a%20b/media'),
    ).toBe('https://file+.vscode-resource.vscode-cdn.net/Users/a%20b/media');
  });

  it('is a no-op on an authority that needs no decoding', () => {
    expect(webviewResourceBase('https://example.test/a/b')).toBe('https://example.test/a/b');
  });

  it('leaves a malformed escape alone rather than throwing', () => {
    expect(webviewResourceBase('https://bad%ZZ.host/a')).toBe('https://bad%ZZ.host/a');
  });
});

function message(kind: string, detail: unknown = {}, atMs = 12): unknown {
  return { type: DIAGNOSTIC_MESSAGE_TYPE, kind, atMs, detail };
}

describe('parseDiagnostic', () => {
  it('accepts a well-formed diagnostic', () => {
    expect(parseDiagnostic(message('first-frame', { coldStartMs: 900 }, 900))).toEqual({
      kind: 'first-frame',
      atMs: 900,
      detail: { coldStartMs: 900 },
    });
  });

  it('rejects anything that is not a diagnostic', () => {
    for (const raw of [
      undefined,
      null,
      'first-frame',
      42,
      [],
      {},
      { type: 'something.else', kind: 'error' },
      { type: DIAGNOSTIC_MESSAGE_TYPE },
      { type: DIAGNOSTIC_MESSAGE_TYPE, kind: 42 },
      { type: DIAGNOSTIC_MESSAGE_TYPE, kind: '' },
    ]) {
      expect(parseDiagnostic(raw)).toBeUndefined();
    }
  });

  it('keeps an unknown kind — dropping it would hide the failure it reports', () => {
    expect(parseDiagnostic(message('some-future-kind'))?.kind).toBe('some-future-kind');
  });

  it('defaults a missing or non-finite timestamp rather than rejecting', () => {
    expect(parseDiagnostic({ type: DIAGNOSTIC_MESSAGE_TYPE, kind: 'boot' })?.atMs).toBe(0);
    expect(parseDiagnostic(message('boot', {}, Number.NaN))?.atMs).toBe(0);
  });

  it('normalises a non-object detail to an empty object', () => {
    expect(parseDiagnostic(message('boot', 'nope'))?.detail).toEqual({});
  });
});

describe('isFailure', () => {
  it.each(['error', 'unhandledrejection', 'csp-violation', 'resource-failed', 'first-frame-timeout'])(
    'treats %s as a failure',
    (kind) => {
      expect(isFailure(parseDiagnostic(message(kind))!)).toBe(true);
    },
  );

  it.each(['boot', 'first-frame', 'resource', 'pointerdown'])('treats %s as informational', (kind) => {
    expect(isFailure(parseDiagnostic(message(kind))!)).toBe(false);
  });
});

describe('formatDiagnostic', () => {
  it('flags failures with a marker a terminal can grep for', () => {
    expect(formatDiagnostic(parseDiagnostic(message('csp-violation', { directive: 'script-src' }))!)).toBe(
      '!! [+12ms] csp-violation directive=script-src',
    );
  });

  it('renders an informational line without the marker', () => {
    expect(formatDiagnostic(parseDiagnostic(message('boot', {}, 0))!)).toBe('   [+0ms] boot');
  });
});

describe('coldStartMs', () => {
  it('reads the measurement off a first-frame diagnostic', () => {
    expect(coldStartMs(parseDiagnostic(message('first-frame', { coldStartMs: 1234 }))!)).toBe(1234);
  });

  it('is undefined for every other kind', () => {
    expect(coldStartMs(parseDiagnostic(message('boot', { coldStartMs: 1234 }))!)).toBeUndefined();
  });

  it('is undefined when the payload lies about the type', () => {
    expect(coldStartMs(parseDiagnostic(message('first-frame', { coldStartMs: 'fast' }))!)).toBeUndefined();
  });
});

describe('handleWebviewMessage', () => {
  function sink() {
    const lines: string[] = [];
    return { lines, append: (line: string) => lines.push(line) };
  }

  const extensionUri = { fsPath: '/ext' } as never;

  it('writes a diagnostic to the sink', () => {
    const s = sink();
    handleWebviewMessage(message('boot', { baseUri: 'x' }), { extensionUri, sink: s });
    expect(s.lines).toEqual(['   [+12ms] boot baseUri=x']);
  });

  it('calls out the cold-start measurement on its own line', () => {
    const s = sink();
    handleWebviewMessage(message('first-frame', { coldStartMs: 812 }, 812), { extensionUri, sink: s });
    expect(s.lines[1]).toContain('cold start: 812 ms');
  });

  it('relays a telemetry message to host-core rather than sending anything itself', () => {
    const record = vi.fn();
    handleWebviewMessage(
      { type: TELEMETRY_MESSAGE_TYPE, event: { name: 'waveform_opened' } },
      { extensionUri, sink: sink(), recordTelemetryFromWebview: record },
    );
    expect(record).toHaveBeenCalledWith({ name: 'waveform_opened' });
  });

  it('offers a CXP envelope to the router before logging it', () => {
    // RTL annotation's value responses reach `WebviewValueSource` through this hook
    // rather than a second `onDidReceiveMessage` listener — a webview
    // delivers to every listener, so a second one would relay each telemetry
    // event twice and split CXP routing across two places.
    const s = sink();
    const onCxpEnvelope = vi.fn(() => true);
    handleWebviewMessage(
      { type: CXP_MESSAGE_TYPE, envelope: { kind: 'crux.value_response', payload: {} } },
      { extensionUri, sink: s, onCxpEnvelope },
    );
    expect(onCxpEnvelope).toHaveBeenCalledWith({ kind: 'crux.value_response', payload: {} });
    // A claimed envelope is NOT logged: the standing value query answers on
    // every cursor move, and one line per answer would bury the channel the
    // moment a user drags the cursor.
    expect(s.lines).toEqual([]);
  });

  it('still logs an envelope the router declined', () => {
    const s = sink();
    handleWebviewMessage(
      {
        type: CXP_MESSAGE_TYPE,
        envelope: { kind: 'request_open_artifact_ack', payload: { honored: false } },
      },
      { extensionUri, sink: s, onCxpEnvelope: () => false },
    );
    expect(s.lines[0]).toContain('request_open_artifact_ack');
  });

  it('ignores a message that is neither a diagnostic nor telemetry', () => {
    const s = sink();
    const record = vi.fn();
    handleWebviewMessage({ type: 'crux.unknown' }, {
      extensionUri,
      sink: s,
      recordTelemetryFromWebview: record,
    });
    expect(s.lines).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });
});
