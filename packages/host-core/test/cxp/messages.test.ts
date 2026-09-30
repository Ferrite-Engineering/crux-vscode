import { describe, expect, it } from 'vitest';
import { CxpFormatError } from '../../src/cxp/errors';
import {
  CXP_DESIGN_ID_METADATA_KEY,
  CXP_SUBSCRIBE_TO_ALL,
  CxpErrorCode,
  CxpMessageKind,
  decodeCxpMessage,
  encodeCxpMessage,
  normaliseCxpErrorCode,
  referencedElements,
  subscriptionMatches,
  type CxpMessage,
  type CxpSubscription,
} from '../../src/cxp/messages';
import type { PeerIdentity } from '../../src/cxp/identity';
import type { ElementId } from '../../src/cxp/element-id';
import type { JsonValue } from '../../src/cxp/json';

const identity: PeerIdentity = {
  peerId: 'wavecrux-1234-1700000000000',
  productName: 'wavecrux',
  productVersion: '1.0.0',
  capabilities: [],
};

const signal: ElementId = { kind: 'signal', path: 'top.cpu.pc' };
const net: ElementId = { kind: 'net', path: 'top.mem.dq' };

/** Every kind this build models, one well-formed instance each. */
const everyKind: readonly CxpMessage[] = [
  { kind: CxpMessageKind.hello, identity },
  { kind: CxpMessageKind.hello, identity, token: 'ab'.repeat(16) },
  { kind: CxpMessageKind.helloAck, identity, inReplyTo: 'x' },
  { kind: CxpMessageKind.goodbye },
  { kind: CxpMessageKind.subscribe, subscriptions: [] },
  { kind: CxpMessageKind.unsubscribe },
  { kind: CxpMessageKind.notifySelection, elements: [signal], metadata: {} },
  { kind: CxpMessageKind.requestHighlight, element: signal, metadata: {} },
  { kind: CxpMessageKind.requestHighlightAck, inReplyTo: 'x', honored: true },
  { kind: CxpMessageKind.requestOpenSource, filePath: 'a.v', line: 1 },
  { kind: CxpMessageKind.requestOpenSourceAck, inReplyTo: 'x', honored: true },
  { kind: CxpMessageKind.requestOpenArtifact, designId: 'd', artifactKind: 'waveform' },
  { kind: CxpMessageKind.requestOpenArtifactAck, inReplyTo: 'x', honored: true },
  { kind: CxpMessageKind.errorResponse, code: 'x', message: 'x', inReplyTo: '' },
];

describe('the message vocabulary', () => {
  it('defines thirteen kinds — the spec eleven plus the two 1.1 added', () => {
    expect(Object.values(CxpMessageKind)).toHaveLength(13);
    expect(Object.values(CxpMessageKind)).toContain('request_open_artifact');
    expect(Object.values(CxpMessageKind)).toContain('request_open_artifact_ack');
  });

  it('defines the nine error codes — the spec eight plus the one 1.2 added', () => {
    expect(Object.values(CxpErrorCode).sort()).toEqual(
      [
        'malformed_envelope',
        'unknown_kind',
        'malformed_payload',
        'handshake_required',
        'unsupported_version',
        'unauthorized',
        'element_not_found',
        'unsupported',
        'internal_error',
      ].sort(),
    );
  });

  it('acts on unauthorized rather than normalising it to internal_error', () => {
    expect(normaliseCxpErrorCode('unauthorized')).toBe(CxpErrorCode.unauthorized);
  });

  it('round-trips every kind through encode/decode', () => {
    for (const original of everyKind) {
      const decoded = decodeCxpMessage(original.kind, encodeCxpMessage(original));
      expect(decoded, `decoder lost kind ${original.kind}`).toBeDefined();
      expect(decoded).toEqual(original);
    }
  });

  it('returns undefined for an unknown kind rather than throwing', () => {
    expect(decodeCxpMessage('not_a_real_kind', {})).toBeUndefined();
  });

  it('treats an unrecognised error code as internal_error (§6.1)', () => {
    expect(normaliseCxpErrorCode('unknown_kind')).toBe(CxpErrorCode.unknownKind);
    expect(normaliseCxpErrorCode('some_future_code')).toBe(CxpErrorCode.internalError);
    // The code as sent is still preserved on the decoded message.
    const decoded = decodeCxpMessage(CxpMessageKind.errorResponse, {
      code: 'some_future_code',
      message: 'm',
      in_reply_to: 'r',
    });
    expect(decoded).toMatchObject({ code: 'some_future_code' });
  });
});

describe('hello / hello_ack / goodbye', () => {
  it('requires an identity on hello', () => {
    expect(() => decodeCxpMessage(CxpMessageKind.hello, {})).toThrow('missing "identity"');
    expect(() =>
      decodeCxpMessage(CxpMessageKind.hello, { token: 'ab'.repeat(16) }),
    ).toThrow('missing "identity"');
  });

  it('encodes a hello with no token as identity alone — the pre-1.2 payload', () => {
    expect(Object.keys(encodeCxpMessage({ kind: CxpMessageKind.hello, identity }))).toEqual([
      'identity',
    ]);
  });

  it('requires identity and in_reply_to on hello_ack', () => {
    expect(() =>
      decodeCxpMessage(CxpMessageKind.helloAck, { identity: { peer_id: 'a' } }),
    ).toThrow(CxpFormatError);
    expect(() => decodeCxpMessage(CxpMessageKind.helloAck, { in_reply_to: 'x' })).toThrow(
      'missing "identity"',
    );
  });

  it('omits reason from goodbye when absent', () => {
    expect(encodeCxpMessage({ kind: CxpMessageKind.goodbye })).toEqual({});
    expect(decodeCxpMessage(CxpMessageKind.goodbye, {})).toEqual({
      kind: CxpMessageKind.goodbye,
    });
  });

  it('carries a goodbye reason when present', () => {
    expect(decodeCxpMessage(CxpMessageKind.goodbye, { reason: 'user quit' })).toEqual({
      kind: CxpMessageKind.goodbye,
      reason: 'user quit',
    });
  });
});

describe('notify_selection', () => {
  it('accepts an empty element list — a cleared selection (§9.3)', () => {
    // §9.3: `elements` is required, and MAY be empty to signal that the
    // sender's selection was cleared. Both implementations used to reject
    // it, which left "the user deselected everything" with no legal wire
    // representation; crux_cxp 0.4.4 fixed its decoder and this matches.
    const decoded = decodeCxpMessage(CxpMessageKind.notifySelection, { elements: [] });
    expect(decoded).toEqual({
      kind: CxpMessageKind.notifySelection,
      elements: [],
      metadata: {},
    });
  });

  it('round-trips a cleared selection back onto the wire', () => {
    expect(
      encodeCxpMessage({
        kind: CxpMessageKind.notifySelection,
        elements: [],
        metadata: {},
      }),
    ).toEqual({ elements: [] });
  });

  it('still rejects a missing "elements" key — absence is not emptiness', () => {
    expect(() => decodeCxpMessage(CxpMessageKind.notifySelection, {})).toThrow(CxpFormatError);
    expect(() => decodeCxpMessage(CxpMessageKind.notifySelection, {})).toThrow(
      'missing or non-array "elements"',
    );
  });

  it('still rejects a non-array "elements" value', () => {
    // A sender that put an object, a string or a null there has told us
    // nothing, and reading any of them as "cleared" would blank a peer's
    // view of the selection on a malformed frame.
    const values: JsonValue[] = [{}, 'top.a', 42, null];
    for (const value of values) {
      expect(() =>
        decodeCxpMessage(CxpMessageKind.notifySelection, { elements: value }),
      ).toThrow('missing or non-array "elements"');
    }
  });

  it('ignores unknown payload keys — forward compatibility', () => {
    const decoded = decodeCxpMessage(CxpMessageKind.notifySelection, {
      elements: [{ kind: 'signal', path: 'a' }],
      unknown_future_field: 'will be ignored',
    });
    expect(decoded).toMatchObject({ elements: [{ kind: 'signal', path: 'a' }] });
  });

  it('preserves an unrecognised element kind intact (§6.1)', () => {
    const decoded = decodeCxpMessage(CxpMessageKind.notifySelection, {
      elements: [{ kind: 'quantum_flux', path: 'top.q' }],
    });
    expect(decoded).toMatchObject({ elements: [{ kind: 'quantum_flux', path: 'top.q' }] });
    // And it round-trips back onto the wire unchanged rather than being
    // dropped or normalised.
    expect(encodeCxpMessage(decoded as CxpMessage)).toMatchObject({
      elements: [{ kind: 'quantum_flux', path: 'top.q' }],
    });
  });

  it('keeps metadata it does not understand, including crux.design_id', () => {
    const decoded = decodeCxpMessage(CxpMessageKind.notifySelection, {
      elements: [{ kind: 'signal', path: 'a' }],
      metadata: { [CXP_DESIGN_ID_METADATA_KEY]: 'designs/cdc_capture', 'future.key': 42 },
    });
    expect(decoded).toMatchObject({
      metadata: { [CXP_DESIGN_ID_METADATA_KEY]: 'designs/cdc_capture', 'future.key': 42 },
    });
  });

  it('omits empty metadata from the wire form', () => {
    expect(
      encodeCxpMessage({
        kind: CxpMessageKind.notifySelection,
        elements: [signal],
        metadata: {},
      }),
    ).not.toHaveProperty('metadata');
  });

  it('drops a malformed coordinate without failing the message (§9.9)', () => {
    const decoded = decodeCxpMessage(CxpMessageKind.notifySelection, {
      elements: [{ kind: 'signal', path: 'a' }],
      coordinate: { stream_id: '', sequence_index: -1 },
    });
    expect(decoded).toMatchObject({ elements: [{ path: 'a' }] });
    expect(decoded).not.toHaveProperty('coordinate');
  });

  it('carries a well-formed coordinate', () => {
    const decoded = decodeCxpMessage(CxpMessageKind.notifySelection, {
      elements: [{ kind: 'signal', path: 'a' }],
      coordinate: {
        stream_id: 'riscv.rvfi.retire',
        sequence_index: 4132,
        sub_id: '0',
        attributes: { 'riscv.pc': '0x80000010', ignored: 7 },
      },
    });
    expect(decoded).toMatchObject({
      coordinate: {
        streamId: 'riscv.rvfi.retire',
        sequenceIndex: 4132,
        subId: '0',
        attributes: { 'riscv.pc': '0x80000010' },
      },
    });
  });
});

describe('request_highlight / request_open_source / request_open_artifact', () => {
  it('requires an element on request_highlight', () => {
    expect(() => decodeCxpMessage(CxpMessageKind.requestHighlight, {})).toThrow(
      'missing "element"',
    );
  });

  it('requires in_reply_to and honored on every ack', () => {
    for (const kind of [
      CxpMessageKind.requestHighlightAck,
      CxpMessageKind.requestOpenSourceAck,
      CxpMessageKind.requestOpenArtifactAck,
    ]) {
      expect(() => decodeCxpMessage(kind, { honored: true })).toThrow('missing "in_reply_to"');
      expect(() => decodeCxpMessage(kind, { in_reply_to: 'x' })).toThrow('missing "honored"');
    }
  });

  it('requires file_path and an integer line on request_open_source', () => {
    expect(() => decodeCxpMessage(CxpMessageKind.requestOpenSource, { line: 1 })).toThrow(
      'missing "file_path"',
    );
    expect(() =>
      decodeCxpMessage(CxpMessageKind.requestOpenSource, { file_path: 'a.v' }),
    ).toThrow('missing "line"');
    expect(() =>
      decodeCxpMessage(CxpMessageKind.requestOpenSource, { file_path: 'a.v', line: 1.5 }),
    ).toThrow('missing "line"');
  });

  it('keeps the payload kind and the envelope kind distinct on open_artifact', () => {
    const message: CxpMessage = {
      kind: CxpMessageKind.requestOpenArtifact,
      designId: 'designs/cdc_capture',
      artifactKind: 'waveform',
      path: '/abs/cdc_capture.vcd',
    };
    expect(message.kind).toBe('request_open_artifact');
    expect(encodeCxpMessage(message)['kind']).toBe('waveform');
    expect(decodeCxpMessage(message.kind, encodeCxpMessage(message))).toEqual(message);
  });

  it('requires design_id and kind on open_artifact', () => {
    expect(() =>
      decodeCxpMessage(CxpMessageKind.requestOpenArtifact, { kind: 'waveform' }),
    ).toThrow('missing "design_id"');
    expect(() =>
      decodeCxpMessage(CxpMessageKind.requestOpenArtifact, { design_id: 'd' }),
    ).toThrow('missing "kind"');
  });
});

describe('error_response', () => {
  it('requires code and message, and tolerates a missing in_reply_to', () => {
    expect(() => decodeCxpMessage(CxpMessageKind.errorResponse, { message: 'm' })).toThrow(
      'missing "code"',
    );
    expect(() => decodeCxpMessage(CxpMessageKind.errorResponse, { code: 'c' })).toThrow(
      'missing "message"',
    );
    expect(decodeCxpMessage(CxpMessageKind.errorResponse, { code: 'c', message: 'm' })).toEqual({
      kind: CxpMessageKind.errorResponse,
      code: 'c',
      message: 'm',
      inReplyTo: '',
    });
  });
});

describe('subscriptions', () => {
  it('subscribe-to-all is the explicit eight-kind enumeration', () => {
    // There is no wildcard on the wire; this list must stay identical to
    // crux_cxp's cxpSubscribeToAll or the two implementations gossip
    // different subsets.
    expect(CXP_SUBSCRIBE_TO_ALL.map((s) => s.messageKind)).toEqual([
      'notify_selection',
      'request_highlight',
      'request_highlight_ack',
      'request_open_source',
      'request_open_source_ack',
      'request_open_artifact',
      'request_open_artifact_ack',
      'error_response',
    ]);
  });

  it('round-trips a filtered subscription', () => {
    const message: CxpMessage = {
      kind: CxpMessageKind.subscribe,
      subscriptions: [
        {
          messageKind: CxpMessageKind.notifySelection,
          elementKinds: ['signal', 'scope'],
          pathPrefix: 'top.cpu.',
        },
        { messageKind: CxpMessageKind.requestHighlight, elementKinds: [] },
      ],
    };
    expect(decodeCxpMessage(message.kind, encodeCxpMessage(message))).toEqual(message);
  });

  it('keeps an unrecognised element kind in a filter rather than widening it', () => {
    const decoded = decodeCxpMessage(CxpMessageKind.subscribe, {
      subscriptions: [{ message_kind: 'notify_selection', element_kinds: ['quantum_flux'] }],
    });
    expect(decoded).toMatchObject({
      subscriptions: [{ elementKinds: ['quantum_flux'] }],
    });
  });

  it('tolerates a missing subscriptions list', () => {
    expect(decodeCxpMessage(CxpMessageKind.subscribe, {})).toEqual({
      kind: CxpMessageKind.subscribe,
      subscriptions: [],
    });
  });

  it('matches on message kind', () => {
    const sub: CxpSubscription = {
      messageKind: CxpMessageKind.notifySelection,
      elementKinds: [],
    };
    expect(
      subscriptionMatches(sub, {
        kind: CxpMessageKind.notifySelection,
        elements: [signal],
        metadata: {},
      }),
    ).toBe(true);
    expect(
      subscriptionMatches(sub, {
        kind: CxpMessageKind.requestHighlight,
        element: signal,
        metadata: {},
      }),
    ).toBe(false);
  });

  it('elementKinds needs one referenced element of a listed kind', () => {
    const sub: CxpSubscription = {
      messageKind: CxpMessageKind.notifySelection,
      elementKinds: ['signal'],
    };
    const of = (elements: ElementId[]): CxpMessage => ({
      kind: CxpMessageKind.notifySelection,
      elements,
      metadata: {},
    });
    expect(subscriptionMatches(sub, of([signal]))).toBe(true);
    expect(subscriptionMatches(sub, of([net, signal]))).toBe(true);
    expect(subscriptionMatches(sub, of([net]))).toBe(false);
  });

  it('pathPrefix is existential over ALL referenced elements, not positional (§9.1.1)', () => {
    // The inversion of a test that used to assert the opposite. `elements`
    // is in the sender's own order — usually the order the user clicked —
    // so testing only `elements[0]` made routing depend on click order and
    // dropped a multi-select spanning two scopes whenever the user happened
    // to click the other scope first. CXP §9.1.1 rules that a conformance
    // failure.
    const sub: CxpSubscription = {
      messageKind: CxpMessageKind.notifySelection,
      elementKinds: [],
      pathPrefix: 'top.cpu.',
    };
    expect(
      subscriptionMatches(sub, {
        kind: CxpMessageKind.notifySelection,
        elements: [signal],
        metadata: {},
      }),
    ).toBe(true);
    // The matching element second: delivered, where the positional
    // predicate dropped it.
    expect(
      subscriptionMatches(sub, {
        kind: CxpMessageKind.notifySelection,
        elements: [net, signal],
        metadata: {},
      }),
    ).toBe(true);
    // Nothing matching at all: still not delivered. The predicate widened;
    // it did not evaporate.
    expect(
      subscriptionMatches(sub, {
        kind: CxpMessageKind.notifySelection,
        elements: [net],
        metadata: {},
      }),
    ).toBe(false);
  });

  it('the two element filters are independent — no element must satisfy both (§9.1.1)', () => {
    // §9.1.1's worked example: a `signal` outside `top.cpu` alongside a
    // `net` inside it satisfies a subscription filtered on both.
    const sub: CxpSubscription = {
      messageKind: CxpMessageKind.notifySelection,
      elementKinds: ['signal'],
      pathPrefix: 'top.mem.',
    };
    expect(
      subscriptionMatches(sub, {
        kind: CxpMessageKind.notifySelection,
        elements: [signal, net],
        metadata: {},
      }),
    ).toBe(true);
  });

  it('a retraction reaches every subscriber of the kind, whatever it filtered on (§9.1.2)', () => {
    // The hole this closes: a peer that had narrowed its subscription was
    // told about every selection *except* the one saying the previous one
    // was gone, and held a highlight the sender no longer stood behind for
    // as long as both processes ran. CXP §9.1.2.
    const cleared: CxpMessage = {
      kind: CxpMessageKind.notifySelection,
      elements: [],
      metadata: {},
    };
    expect(
      subscriptionMatches(
        { messageKind: CxpMessageKind.notifySelection, elementKinds: ['signal'] },
        cleared,
      ),
    ).toBe(true);
    expect(
      subscriptionMatches(
        { messageKind: CxpMessageKind.notifySelection, elementKinds: [], pathPrefix: 'top.' },
        cleared,
      ),
    ).toBe(true);
    expect(
      subscriptionMatches(
        { messageKind: CxpMessageKind.notifySelection, elementKinds: [] },
        cleared,
      ),
    ).toBe(true);
    // And it is still routed by kind: a `request_highlight` subscriber does
    // not receive a selection retraction.
    expect(
      subscriptionMatches(
        { messageKind: CxpMessageKind.requestHighlight, elementKinds: [] },
        cleared,
      ),
    ).toBe(false);
  });

  it('a message with no element references fails any element filter', () => {
    // §9.1.2's exemption is deliberately narrow: `notify_selection` with an
    // empty array, and nothing else. Every other elementless message stays
    // undeliverable to a filtered subscription.
    const message: CxpMessage = {
      kind: CxpMessageKind.requestOpenSource,
      filePath: 'a.v',
      line: 3,
    };
    expect(
      subscriptionMatches(
        { messageKind: CxpMessageKind.requestOpenSource, elementKinds: ['source'] },
        message,
      ),
    ).toBe(false);
    expect(
      subscriptionMatches(
        { messageKind: CxpMessageKind.requestOpenSource, elementKinds: [], pathPrefix: 'top.' },
        message,
      ),
    ).toBe(false);
  });
});

describe('referencedElements', () => {
  it('exposes the selection list, the single highlight element, or nothing', () => {
    expect(
      referencedElements({
        kind: CxpMessageKind.notifySelection,
        elements: [signal, net],
        metadata: {},
      }),
    ).toEqual([signal, net]);
    expect(
      referencedElements({
        kind: CxpMessageKind.requestHighlight,
        element: signal,
        metadata: {},
      }),
    ).toEqual([signal]);
    expect(referencedElements({ kind: CxpMessageKind.goodbye })).toEqual([]);
    expect(
      referencedElements({ kind: CxpMessageKind.requestOpenSource, filePath: 'a.v', line: 1 }),
    ).toEqual([]);
  });
});
