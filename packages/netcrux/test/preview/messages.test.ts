import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_TYPE,
  EDITOR_HOST_MARKER_GLOBAL,
  FRAME_TYPE,
  HOST_BRIDGE_SEAM_GLOBAL,
  LAYOUT_WORKER_GLOBAL,
  NOTICE_ACTION_TYPE,
  OPEN_NETLIST_KIND,
  OPEN_SOURCE_KIND,
  READY_KIND,
  STATUS_KIND,
  THEME_TOKENS_KIND,
  formatDiagnostic,
  isFailure,
  openNetlistFrame,
  parseWebviewMessage,
} from '../../src/preview/messages';

const frame = (fields: Record<string, unknown>) => ({
  type: FRAME_TYPE,
  protocol: 1,
  ...fields,
});

describe('names shared with the NetCrux web viewer', () => {
  // The viewer's `host_bridge_messages.dart` holds the other half of each of
  // these. A rename on one side is silent: the viewer reports no editor host,
  // or drops every frame.
  it('are the strings the viewer reads', () => {
    expect(EDITOR_HOST_MARKER_GLOBAL).toBe('cruxEditorHost');
    expect(HOST_BRIDGE_SEAM_GLOBAL).toBe('cruxHostBridge');
    expect(LAYOUT_WORKER_GLOBAL).toBe('cruxLayoutWorkerUrl');
    expect(FRAME_TYPE).toBe('crux.netcrux');
    expect(OPEN_NETLIST_KIND).toBe('open_netlist');
    expect(THEME_TOKENS_KIND).toBe('theme_tokens');
    expect(READY_KIND).toBe('ready');
    expect(OPEN_SOURCE_KIND).toBe('open_source');
    expect(STATUS_KIND).toBe('status');
  });
});

describe('openNetlistFrame', () => {
  it('carries the name and the text under the viewer protocol', () => {
    expect(openNetlistFrame('top.json', '{}')).toEqual({
      type: 'crux.netcrux',
      protocol: 1,
      kind: 'open_netlist',
      name: 'top.json',
      text: '{}',
    });
  });
});

describe('parseWebviewMessage', () => {
  it('reads ready', () => {
    expect(parseWebviewMessage(frame({ kind: 'ready' }))).toEqual({ type: 'ready' });
  });

  it('reads a source request', () => {
    expect(
      parseWebviewMessage(frame({ kind: 'open_source', file: 'rtl/top.v', line: 14, column: 5 })),
    ).toEqual({ type: 'open-source', file: 'rtl/top.v', line: 14, column: 5 });
    expect(parseWebviewMessage(frame({ kind: 'open_source', file: 'a.v', line: 3 }))).toEqual({
      type: 'open-source',
      file: 'a.v',
      line: 3,
      column: undefined,
    });
  });

  it('refuses a source request with no usable file or line', () => {
    for (const fields of [
      { file: '', line: 1 },
      { file: '   ', line: 1 },
      { file: 'a.v', line: 0 },
      { file: 'a.v', line: -3 },
      { file: 'a.v', line: 1.5 },
      { file: 'a.v', line: '4' },
      { file: 7, line: 4 },
      { line: 4 },
    ]) {
      expect(parseWebviewMessage(frame({ kind: 'open_source', ...fields })), JSON.stringify(fields)).toBeUndefined();
    }
  });

  it('drops a column that is not a positive integer rather than the request', () => {
    expect(
      parseWebviewMessage(frame({ kind: 'open_source', file: 'a.v', line: 2, column: 0 })),
    ).toMatchObject({ type: 'open-source', column: undefined });
  });

  it('reads status in each phase', () => {
    expect(
      parseWebviewMessage(frame({ kind: 'status', phase: 'loaded', modules: 3, cells: 40 })),
    ).toEqual({ type: 'status', phase: 'loaded', message: undefined, modules: 3, cells: 40 });
    expect(parseWebviewMessage(frame({ kind: 'status', phase: 'failed', message: 'bad' }))).toMatchObject({
      phase: 'failed',
      message: 'bad',
    });
    expect(parseWebviewMessage(frame({ kind: 'status', phase: 'sideways' }))).toBeUndefined();
  });

  it('caps the text it keeps from the page', () => {
    const parsed = parseWebviewMessage(
      frame({ kind: 'status', phase: 'failed', message: 'x'.repeat(100_000) }),
    );
    expect(parsed?.type === 'status' && parsed.message?.length).toBe(4096);
  });

  it('reads a notice button, and only the buttons there are', () => {
    expect(parseWebviewMessage({ type: NOTICE_ACTION_TYPE, action: 'open-in-netcrux' })).toEqual({
      type: 'notice-action',
      action: 'open-in-netcrux',
    });
    expect(parseWebviewMessage({ type: NOTICE_ACTION_TYPE, action: 'rm -rf' })).toBeUndefined();
  });

  it('reads a diagnostic', () => {
    expect(
      parseWebviewMessage({ type: DIAGNOSTIC_TYPE, kind: 'boot', atMs: 3, detail: { a: 1 } }),
    ).toEqual({ type: 'diagnostic', diagnostic: { kind: 'boot', atMs: 3, detail: { a: 1 } } });
    expect(parseWebviewMessage({ type: DIAGNOSTIC_TYPE, kind: 'boot' })).toBeUndefined();
  });

  it('refuses anything that is not a frame of this protocol', () => {
    for (const raw of [
      null,
      undefined,
      'ready',
      42,
      [],
      {},
      { type: 'other', kind: 'ready', protocol: 1 },
      frame({ kind: 'nope' }),
      { type: FRAME_TYPE, kind: 'ready' },
      { type: FRAME_TYPE, kind: 'ready', protocol: 0 },
    ]) {
      expect(parseWebviewMessage(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });
});

describe('diagnostics', () => {
  it('formats one line with its detail', () => {
    expect(formatDiagnostic({ kind: 'resource', atMs: 12, detail: { url: 'a', status: 404 } })).toBe(
      '   [+12ms] resource url=a status=404',
    );
  });

  it('names the failures', () => {
    for (const kind of ['error', 'csp-violation', 'layout-worker-failed', 'loader-failed']) {
      expect(isFailure({ kind, atMs: 0, detail: {} }), kind).toBe(true);
    }
    for (const kind of ['boot', 'first-frame', 'theme', 'layout-worker-staged', 'probe']) {
      expect(isFailure({ kind, atMs: 0, detail: {} }), kind).toBe(false);
    }
  });
});
