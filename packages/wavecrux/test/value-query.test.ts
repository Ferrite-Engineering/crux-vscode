import { describe, expect, it, vi } from 'vitest';
import type { annotate } from '@crux-vscode/host-core';
import {
  MAX_VALUE_QUERY_PATHS,
  VALUE_QUERY_KIND,
  VALUE_RESPONSE_KIND,
  WebviewValueSource,
  parseValueResponse,
  valueQueryFrame,
} from '../src/webview/value-query';
import { CXP_FRAME_TYPE, HOST_BRIDGE_PROTOCOL_VERSION } from '../src/webview/open-waveform';

const NEVER_CANCELLED: annotate.AnnotationCancellation = { isCancelled: () => false };

/** An envelope shaped like the one the Dart side posts back. */
function responseEnvelope(options: {
  queryId: string;
  values: Record<string, unknown>;
  cursorLabel?: string;
}): unknown {
  return {
    kind: VALUE_RESPONSE_KIND,
    payload: {
      query_id: options.queryId,
      values: options.values,
      ...(options.cursorLabel !== undefined ? { cursor_label: options.cursorLabel } : {}),
    },
  };
}

describe('the wire literals', () => {
  it('match the Dart side', () => {
    // `host_bridge_messages.dart` pins the same two from the other
    // direction. A rename on one side only is silent: the app answers
    // `unknown_kind` and the decorations simply never appear.
    expect(VALUE_QUERY_KIND).toBe('crux.value_query');
    expect(VALUE_RESPONSE_KIND).toBe('crux.value_response');
    expect(MAX_VALUE_QUERY_PATHS).toBe(256);
  });
});

describe('valueQueryFrame', () => {
  it('is an ordinary CXP bridge frame', () => {
    const frame = valueQueryFrame({ queryId: 'q1', paths: ['top.clk'] });
    expect(frame.type).toBe(CXP_FRAME_TYPE);
    expect(frame.protocol).toBe(HOST_BRIDGE_PROTOCOL_VERSION);
    expect(frame.envelope.kind).toBe(VALUE_QUERY_KIND);
    expect(frame.envelope.payload).toEqual({ query_id: 'q1', paths: ['top.clk'] });
  });
});

describe('parseValueResponse', () => {
  it('decodes a well-formed response', () => {
    const response = parseValueResponse(
      responseEnvelope({ queryId: 'q1', values: { 'top.clk': '1' }, cursorLabel: '15 ns' }),
    );
    expect(response?.queryId).toBe('q1');
    expect(response?.values.get('top.clk')).toBe('1');
    expect(response?.cursorLabel).toBe('15 ns');
  });

  it('drops a non-string value rather than failing the whole viewport', () => {
    const response = parseValueResponse(
      responseEnvelope({ queryId: 'q1', values: { 'top.clk': 1, 'top.rst': '0', 'top.x': '' } }),
    );
    expect([...(response?.values.keys() ?? [])]).toEqual(['top.rst']);
  });

  it('refuses anything that is not a value response', () => {
    for (const raw of [
      undefined,
      null,
      'nope',
      {},
      { kind: 'crux.other', payload: {} },
      { kind: VALUE_RESPONSE_KIND },
      { kind: VALUE_RESPONSE_KIND, payload: { values: {} } },
      { kind: VALUE_RESPONSE_KIND, payload: { query_id: '', values: {} } },
      { kind: VALUE_RESPONSE_KIND, payload: { query_id: 'q1', values: 'nope' } },
    ]) {
      expect(parseValueResponse(raw)).toBeUndefined();
    }
  });
});

interface Harness {
  readonly source: WebviewValueSource;
  readonly posted: { kind: string; queryId: string; paths: readonly string[] }[];
  readonly cursorMoves: () => number;
  readonly fireTimeout: () => void;
}

function harness(): Harness {
  const posted: { kind: string; queryId: string; paths: readonly string[] }[] = [];
  let cursorMoves = 0;
  let timeout: (() => void) | undefined;
  const source = new WebviewValueSource({
    post: (frame) => {
      const payload = frame.envelope.payload as { query_id: string; paths: string[] };
      posted.push({ kind: frame.envelope.kind, queryId: payload.query_id, paths: payload.paths });
      return true;
    },
    onCursorMoved: () => {
      cursorMoves += 1;
    },
    schedule: (run) => {
      timeout = run;
      return () => {
        timeout = undefined;
      };
    },
  });
  source.open();
  return {
    source,
    posted,
    cursorMoves: () => cursorMoves,
    fireTimeout: () => timeout?.(),
  };
}

describe('WebviewValueSource', () => {
  it('is not ready until a waveform is on its way', async () => {
    const source = new WebviewValueSource({ post: () => true });
    expect(source.isReady()).toBe(false);
    expect(await source.valuesAt(['top.clk'], NEVER_CANCELLED)).toEqual({ values: new Map() });
    source.open();
    expect(source.isReady()).toBe(true);
  });

  it('posts a standing query and resolves on the matching response', async () => {
    const { source, posted } = harness();
    const answered = source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.paths).toEqual(['top.clk']);

    source.accept(responseEnvelope({ queryId: posted[0]!.queryId, values: { 'top.clk': '1' } }));
    expect((await answered).values.get('top.clk')).toBe('1');
  });

  it('answers a repeat of the standing query from cache, posting nothing', async () => {
    // THE loop-break. An unsolicited response makes the host re-render,
    // which re-resolves the same viewport, which asks again — and a fresh
    // query here would post a frame per cursor tick, forever.
    const { source, posted } = harness();
    const first = source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    source.accept(responseEnvelope({ queryId: posted[0]!.queryId, values: { 'top.clk': '1' } }));
    await first;

    const again = await source.valuesAt(['top.clk'], NEVER_CANCELLED);
    expect(again.values.get('top.clk')).toBe('1');
    expect(posted).toHaveLength(1);
  });

  it('replaces the standing query when the viewport actually changed', async () => {
    const { source, posted } = harness();
    const first = source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    source.accept(responseEnvelope({ queryId: posted[0]!.queryId, values: { 'top.clk': '1' } }));
    await first;

    void source.valuesAt(['top.clk', 'top.rst'], NEVER_CANCELLED);
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    expect(posted[1]?.paths).toEqual(['top.clk', 'top.rst']);
  });

  it('reports an unsolicited response as a cursor move', async () => {
    const { source, posted, cursorMoves } = harness();
    const first = source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    const queryId = posted[0]!.queryId;
    source.accept(responseEnvelope({ queryId, values: { 'top.clk': '1' } }));
    await first;
    expect(cursorMoves()).toBe(0);

    // The app answered the same standing query again: the cursor moved.
    source.accept(responseEnvelope({ queryId, values: { 'top.clk': '0' } }));
    expect(cursorMoves()).toBe(1);
    expect((await source.valuesAt(['top.clk'], NEVER_CANCELLED)).values.get('top.clk')).toBe('0');
  });

  it('ignores a response to a superseded query', async () => {
    const { source, posted } = harness();
    void source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    const stale = posted[0]!.queryId;

    const second = source.valuesAt(['top.rst'], NEVER_CANCELLED);
    await Promise.resolve();
    // Claimed as a value response (so it is not logged as an unknown frame)
    // but not acted on: the host has moved on, and rendering it would paint
    // the previous viewport's values.
    expect(source.accept(responseEnvelope({ queryId: stale, values: { 'top.clk': 'x' } }))).toBe(
      true,
    );
    source.accept(responseEnvelope({ queryId: posted[1]!.queryId, values: { 'top.rst': '0' } }));
    const snapshot = await second;
    expect(snapshot.values.has('top.clk')).toBe(false);
    expect(snapshot.values.get('top.rst')).toBe('0');
  });

  it('resolves empty when the app never answers', async () => {
    const { source, fireTimeout } = harness();
    const answered = source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    fireTimeout();
    expect((await answered).values.size).toBe(0);
  });

  it('resolves a pending query empty when the panel closes', async () => {
    const { source } = harness();
    const answered = source.valuesAt(['top.clk'], NEVER_CANCELLED);
    await Promise.resolve();
    source.close();
    expect((await answered).values.size).toBe(0);
    expect(source.isReady()).toBe(false);
  });

  it('does not claim a frame that is not a value response', () => {
    const { source } = harness();
    expect(source.accept({ kind: 'request_highlight_ack', payload: {} })).toBe(false);
  });

  it('asks about nothing when the viewport resolved nothing', async () => {
    const { source, posted } = harness();
    expect(await source.valuesAt([], NEVER_CANCELLED)).toEqual({ values: new Map() });
    expect(posted).toHaveLength(0);
  });

  it('never posts more paths than both sides enforce', async () => {
    const { source, posted } = harness();
    const paths = Array.from({ length: MAX_VALUE_QUERY_PATHS + 50 }, (_, i) => `top.s${i}`);
    void source.valuesAt(paths, NEVER_CANCELLED);
    await Promise.resolve();
    expect(posted[0]?.paths).toHaveLength(MAX_VALUE_QUERY_PATHS);
  });

  it('does not render into a generation the caller already abandoned', async () => {
    const cancelled = { isCancelled: vi.fn(() => true) };
    const { source } = harness();
    expect((await source.valuesAt(['top.clk'], cancelled)).values.size).toBe(0);
  });
});
