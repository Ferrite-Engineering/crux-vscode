/**
 * The host half of the not-on-the-first-file nudge rule.
 *
 * The durable fact — has this *installation* ever opened a waveform — lives
 * in `ExtensionContext.globalState`, which only the host has. The webview
 * builds the policy on top of it. What matters here is that the fact is
 * sampled at the right moment and stated in the shape the Dart decoder
 * accepts.
 */
import { describe, expect, it } from 'vitest';
import { HOST_SESSION_KIND, hostSessionFrame } from '../src/webview/host-session';
import { CXP_FRAME_TYPE, HOST_BRIDGE_PROTOCOL_VERSION, HOST_PEER_ID } from '../src/webview/open-waveform';

describe('hostSessionFrame', () => {
  it('mirrors the Dart side’s kind literal', () => {
    // `kHostBridgeHostSessionKind` in
    // wavecrux/lib/services/host_bridge/host_bridge_messages.dart. A rename
    // on one side only fails silently — the app answers `unknown_kind`, the
    // session provider keeps its default, and the nudge never fires. Both
    // sides pin the literal; this is the host's half of that pin.
    expect(HOST_SESSION_KIND).toBe('crux.host_session');
  });

  it('is an ordinary CXP bridge frame', () => {
    const frame = hostSessionFrame({ openedFileBefore: true });
    expect(frame.type).toBe(CXP_FRAME_TYPE);
    expect(frame.protocol).toBe(HOST_BRIDGE_PROTOCOL_VERSION);
    expect(frame.envelope.from).toBe(HOST_PEER_ID);
    expect(frame.envelope.kind).toBe(HOST_SESSION_KIND);
  });

  it('states the fact with the snake_case key the decoder reads', () => {
    expect(hostSessionFrame({ openedFileBefore: true }).envelope.payload).toEqual({
      opened_file_before: true,
    });
    expect(hostSessionFrame({ openedFileBefore: false }).envelope.payload).toEqual({
      opened_file_before: false,
    });
  });

  it('carries a boolean, never a truthy stand-in', () => {
    // The Dart decoder refuses anything but a `bool` rather than coercing,
    // because coercion would invent the one value that *enables* a nudge.
    const value = hostSessionFrame({ openedFileBefore: false }).envelope.payload[
      'opened_file_before'
    ];
    expect(typeof value).toBe('boolean');
  });

  it('carries facts, not policy', () => {
    // "Do not nudge" would be shorter and wrong: the other two inputs to that
    // decision (has a nudge fired this session, did the user dismiss one) are
    // only visible on the Dart side.
    const payload = hostSessionFrame({ openedFileBefore: true }).envelope.payload;
    expect(Object.keys(payload)).toEqual(['opened_file_before']);
  });

  it('mints a distinct message id per frame', () => {
    const first = hostSessionFrame({ openedFileBefore: true });
    const second = hostSessionFrame({ openedFileBefore: true });
    expect(first.envelope.message_id).not.toBe(second.envelope.message_id);
  });
});
