import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_ACK_TIMEOUT_MS,
  REQUEST_HIGHLIGHT_ACK_KIND,
  REQUEST_HIGHLIGHT_KIND,
  WebviewHighlightTarget,
} from '../src/webview/highlight-bridge';
import { CXP_FRAME_TYPE, HOST_BRIDGE_PROTOCOL_VERSION, type HostBridgeFrame } from '../src/webview/open-waveform';

/** A target whose timer is under the test's control. */
function target(): {
  readonly it: WebviewHighlightTarget;
  readonly posted: HostBridgeFrame[];
  fire(): void;
} {
  const posted: HostBridgeFrame[] = [];
  let expire: (() => void) | undefined;
  const built = new WebviewHighlightTarget({
    post: (frame) => {
      posted.push(frame);
      return true;
    },
    schedule: (run) => {
      expire = run;
      return () => {
        expire = undefined;
      };
    },
  });
  built.open();
  return {
    it: built,
    posted,
    fire: () => expire?.(),
  };
}

/** The ack the Dart `EditorHostBridge` posts back. */
function ack(inReplyTo: string, honored: boolean, reason?: string): unknown {
  return {
    cxp_version: '1.1',
    message_id: 'wc-7',
    from: 'wavecrux.webview',
    kind: REQUEST_HIGHLIGHT_ACK_KIND,
    payload: { in_reply_to: inReplyTo, honored, ...(reason !== undefined ? { reason } : {}) },
  };
}

const SIGNAL = { kind: 'signal', path: 'top.cpu.alu.result' };

describe('posting a request_highlight into the webview', () => {
  it('posts a bridge frame carrying the CXP request, keyed by its message id', async () => {
    const t = target();
    const pending = t.it.request({ element: SIGNAL, metadata: {} });
    expect(t.posted).toHaveLength(1);
    const frame = t.posted[0];
    expect(frame?.type).toBe(CXP_FRAME_TYPE);
    expect(frame?.protocol).toBe(HOST_BRIDGE_PROTOCOL_VERSION);
    expect(frame?.envelope.kind).toBe(REQUEST_HIGHLIGHT_KIND);
    expect(frame?.envelope.payload).toEqual({ element: SIGNAL });
    // The Dart side answers `in_reply_to: <this envelope's message_id>`.
    t.it.accept(ack(frame?.envelope.message_id ?? '', true));
    await expect(pending).resolves.toEqual({ outcome: 'honored' });
  });

  it('carries a coordinate and metadata when the peer sent them', async () => {
    const t = target();
    const pending = t.it.request({
      element: SIGNAL,
      coordinate: { streamId: 'riscv.rvfi.retire', sequenceIndex: 12, attributes: { a: 'b' } },
      metadata: { 'crux.design_id': 'designs/cdc' },
    });
    expect(t.posted[0]?.envelope.payload).toEqual({
      element: SIGNAL,
      coordinate: { stream_id: 'riscv.rvfi.retire', sequence_index: 12, attributes: { a: 'b' } },
      metadata: { 'crux.design_id': 'designs/cdc' },
    });
    t.it.accept(ack(t.posted[0]?.envelope.message_id ?? '', true));
    await pending;
  });

  it('relays an element kind this build has never heard of, intact (§6.1)', async () => {
    const t = target();
    const pending = t.it.request({ element: { kind: 'quantum_flux', path: 'top.q' }, metadata: {} });
    expect(t.posted[0]?.envelope.payload).toEqual({
      element: { kind: 'quantum_flux', path: 'top.q' },
    });
    t.it.accept(ack(t.posted[0]?.envelope.message_id ?? '', false));
    await pending;
  });

  it('answers unavailable without posting when no waveform has been delivered', async () => {
    const posted: HostBridgeFrame[] = [];
    const cold = new WebviewHighlightTarget({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
    });
    await expect(cold.request({ element: SIGNAL, metadata: {} })).resolves.toEqual({
      outcome: 'unavailable',
    });
    expect(posted).toEqual([]);
  });
});

describe('the answer that comes back', () => {
  it('honored:false is refused and carries the app’s own words as detail', async () => {
    const t = target();
    const pending = t.it.request({ element: SIGNAL, metadata: {} });
    t.it.accept(ack(t.posted[0]?.envelope.message_id ?? '', false, 'no signal matching top.x'));
    await expect(pending).resolves.toEqual({
      outcome: 'refused',
      detail: 'no signal matching top.x',
    });
  });

  it('an error_response settles as an error, not as a refusal', async () => {
    const t = target();
    const pending = t.it.request({ element: SIGNAL, metadata: {} });
    const claimed = t.it.accept({
      kind: 'error_response',
      payload: {
        code: 'internal_error',
        message: 'boom',
        in_reply_to: t.posted[0]?.envelope.message_id,
      },
    });
    expect(claimed).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: 'error', detail: 'boom' });
  });

  it('treats an ack with no honored field as an app failure, never as a refusal', async () => {
    // Reading a missing `honored` as `false` would report "the element is
    // not in the loaded waveform" about a malformed frame.
    const t = target();
    const pending = t.it.request({ element: SIGNAL, metadata: {} });
    t.it.accept({
      kind: REQUEST_HIGHLIGHT_ACK_KIND,
      payload: { in_reply_to: t.posted[0]?.envelope.message_id },
    });
    await expect(pending).resolves.toEqual({ outcome: 'error' });
  });

  it('times out rather than hanging when the webview never answers', async () => {
    const t = target();
    const pending = t.it.request({ element: SIGNAL, metadata: {} });
    expect(t.it.pendingCount).toBe(1);
    t.fire();
    await expect(pending).resolves.toEqual({ outcome: 'timeout' });
    expect(t.it.pendingCount).toBe(0);
  });

  it('settles every in-flight request when the panel is disposed', async () => {
    const t = target();
    const first = t.it.request({ element: SIGNAL, metadata: {} });
    const second = t.it.request({ element: { kind: 'net', path: 'top.n' }, metadata: {} });
    t.it.close();
    await expect(first).resolves.toEqual({ outcome: 'unavailable' });
    await expect(second).resolves.toEqual({ outcome: 'unavailable' });
    expect(t.it.isReady()).toBe(false);
  });

  it('ignores an envelope that is not ours, so other claimants still see it', () => {
    const t = target();
    expect(t.it.accept({ kind: 'crux.value_response', payload: { query_id: 'wsh-1' } })).toBe(false);
    expect(t.it.accept({ kind: REQUEST_HIGHLIGHT_ACK_KIND, payload: { in_reply_to: 'other' } })).toBe(
      false,
    );
    expect(t.it.accept(undefined)).toBe(false);
    expect(t.it.accept('nope')).toBe(false);
  });

  it('claims a late ack but does not settle twice', async () => {
    const t = target();
    const pending = t.it.request({ element: SIGNAL, metadata: {} });
    t.fire();
    await expect(pending).resolves.toEqual({ outcome: 'timeout' });
    // Already answered the peer; the late ack is dropped rather than
    // reaching the output channel as an unexplained highlight.
    expect(t.it.accept(ack(t.posted[0]?.envelope.message_id ?? '', true))).toBe(false);
  });

  it('correlates two concurrent requests independently', async () => {
    const t = target();
    const first = t.it.request({ element: SIGNAL, metadata: {} });
    const second = t.it.request({ element: { kind: 'net', path: 'top.n' }, metadata: {} });
    const [a, b] = t.posted.map((frame) => frame.envelope.message_id);
    expect(a).not.toBe(b);
    t.it.accept(ack(b ?? '', false, 'not here'));
    t.it.accept(ack(a ?? '', true));
    await expect(first).resolves.toEqual({ outcome: 'honored' });
    await expect(second).resolves.toEqual({ outcome: 'refused', detail: 'not here' });
  });
});

describe('the timeout budget', () => {
  it('is bounded, because a peer’s socket is waiting on the answer', () => {
    // The number itself is a judgement; that it is finite is the contract.
    expect(HIGHLIGHT_ACK_TIMEOUT_MS).toBe(5_000);
    expect(Number.isFinite(HIGHLIGHT_ACK_TIMEOUT_MS)).toBe(true);
  });
});
