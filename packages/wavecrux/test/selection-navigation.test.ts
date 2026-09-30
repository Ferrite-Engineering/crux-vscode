import { describe, expect, it } from 'vitest';
import {
  DESIGN_PATH_ELEMENT_KINDS,
  designPathOf,
  parseWebviewSelection,
} from '../src/webview/selection-navigation';

/**
 * A `notify_selection` envelope exactly as `CxpSelectionEmitter` builds it
 * and `EditorHostBridge.postCxp` posts it — the shape this decoder actually
 * meets, not an invented one.
 */
function announcement(payload: Record<string, unknown>): unknown {
  return {
    cxp_version: '1.1',
    message_id: 'wc-3',
    from: 'wavecrux.webview',
    kind: 'notify_selection',
    payload,
  };
}

describe('decoding the webview’s selection announcements', () => {
  it('decodes the emitter’s own frame shape', () => {
    const selection = parseWebviewSelection(
      announcement({
        elements: [{ kind: 'signal', path: 'top.cpu.alu.result' }],
        display_name: 'top.cpu.alu.result',
        metadata: { 'wavecrux.cursor_time_fs': 1200, 'crux.design_id': 'designs/cdc' },
      }),
    );
    expect(selection).toEqual({
      elements: [{ kind: 'signal', path: 'top.cpu.alu.result' }],
      displayName: 'top.cpu.alu.result',
      metadata: { 'wavecrux.cursor_time_fs': 1200, 'crux.design_id': 'designs/cdc' },
    });
  });

  it('accepts a cleared selection rather than dropping the frame (§9.3)', () => {
    const selection = parseWebviewSelection(announcement({ elements: [] }));
    expect(selection).toEqual({ elements: [], metadata: {} });
    // …and it names nothing to navigate to, which is the point: the user
    // deselecting is not a request to move the editor somewhere else.
    expect(designPathOf(selection!)).toBeUndefined();
  });

  it('ignores an envelope that is not a selection', () => {
    expect(parseWebviewSelection({ kind: 'crux.value_response', payload: {} })).toBeUndefined();
    expect(parseWebviewSelection(undefined)).toBeUndefined();
    expect(parseWebviewSelection('nope')).toBeUndefined();
    expect(parseWebviewSelection({ kind: 'notify_selection' })).toBeUndefined();
  });

  it('drops a malformed selection instead of throwing', () => {
    // The app is mid-drag and another announcement is 100 ms away; a throw
    // here would escape into the panel's one message listener.
    expect(parseWebviewSelection(announcement({}))).toBeUndefined();
    expect(parseWebviewSelection(announcement({ elements: 'top.a' }))).toBeUndefined();
  });
});

describe('which element of a selection names a design path', () => {
  it('takes the first element of a resolvable kind — the app’s primary', () => {
    expect(
      designPathOf({
        elements: [
          { kind: 'signal', path: 'top.a' },
          { kind: 'signal', path: 'top.b' },
        ],
        metadata: {},
      }),
    ).toBe('top.a');
  });

  it('resolves every design-path kind the emitter can send', () => {
    for (const kind of DESIGN_PATH_ELEMENT_KINDS) {
      expect(designPathOf({ elements: [{ kind, path: 'top.a' }], metadata: {} })).toBe('top.a');
    }
  });

  it('never treats a marker letter as a design path', () => {
    // A marker's path is `A`, `B`, … — a position on the timeline. Looking
    // one up would miss, or hit a one-letter signal and navigate to it.
    expect(designPathOf({ elements: [{ kind: 'marker', path: 'A' }], metadata: {} })).toBeUndefined();
  });

  it('skips a marker to reach the signal behind it', () => {
    expect(
      designPathOf({
        elements: [
          { kind: 'marker', path: 'B' },
          { kind: 'signal', path: 'top.cpu.pc' },
        ],
        metadata: {},
      }),
    ).toBe('top.cpu.pc');
  });

  it('leaves a source element to the reveal path that owns files', () => {
    expect(
      designPathOf({ elements: [{ kind: 'source', path: '/w/top.v' }], metadata: {} }),
    ).toBeUndefined();
  });

  it('ignores a blank path', () => {
    expect(designPathOf({ elements: [{ kind: 'signal', path: '   ' }], metadata: {} })).toBeUndefined();
  });
});
