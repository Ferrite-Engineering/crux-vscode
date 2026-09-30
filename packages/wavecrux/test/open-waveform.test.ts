import { describe, expect, it } from 'vitest';
import { cxp } from '@crux-vscode/host-core';
import { BufferByteSource } from '../src/editor/byte-source';
import {
  CHUNK_BYTES,
  CXP_FRAME_TYPE,
  HOST_BRIDGE_PROTOCOL_VERSION,
  HOST_PEER_ID,
  MAX_CHUNKS_PER_TRANSFER,
  MAX_OPEN_BYTES,
  OPEN_WAVEFORM_CHUNK_KIND,
  OPEN_WAVEFORM_KIND,
  SINGLE_SHOT_MAX_BYTES,
  hostBridgeFrame,
  openWaveformChunkFrame,
  openWaveformFrame,
  planWaveformTransfer,
  streamWaveform,
  type HostBridgeFrame,
} from '../src/webview/open-waveform';

function bytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

describe('the constants mirroring host_bridge_messages.dart', () => {
  it('names the frame type, the kinds, and the protocol version', () => {
    // Each of these is one half of a contract whose other half is in
    // wavecrux/lib/services/host_bridge/host_bridge_messages.dart. A mismatch
    // is not a crash: the Dart decoder returns null and the frame vanishes.
    expect(CXP_FRAME_TYPE).toBe('crux.cxp');
    expect(OPEN_WAVEFORM_KIND).toBe('crux.open_waveform_bytes');
    expect(OPEN_WAVEFORM_CHUNK_KIND).toBe('crux.open_waveform_chunk');
    expect(HOST_BRIDGE_PROTOCOL_VERSION).toBe(1);
  });

  it('caps a transfer where kHostBridgeMaxOpenBytes caps it', () => {
    expect(MAX_OPEN_BYTES).toBe(256 * 1024 * 1024);
  });

  it('keeps the chunk count of a maximal transfer inside the receiver’s limit', () => {
    const plan = planWaveformTransfer(MAX_OPEN_BYTES);
    expect(plan.mode).toBe('chunked');
    if (plan.mode !== 'chunked') return;
    expect(plan.chunkCount).toBeLessThanOrEqual(MAX_CHUNKS_PER_TRANSFER);
    expect(plan.chunkCount).toBe(64);
  });
});

describe('planWaveformTransfer', () => {
  it('sends a small file in one frame', () => {
    expect(planWaveformTransfer(1024)).toEqual({ mode: 'single', totalBytes: 1024 });
  });

  it('keeps the single-frame path right up to the boundary', () => {
    expect(planWaveformTransfer(SINGLE_SHOT_MAX_BYTES).mode).toBe('single');
    expect(planWaveformTransfer(SINGLE_SHOT_MAX_BYTES + 1).mode).toBe('chunked');
  });

  it('slices a large file into whole chunks plus a remainder', () => {
    const plan = planWaveformTransfer(CHUNK_BYTES * 3 + 17);
    expect(plan).toEqual({
      mode: 'chunked',
      totalBytes: CHUNK_BYTES * 3 + 17,
      chunkBytes: CHUNK_BYTES,
      chunkCount: 4,
    });
  });

  it('refuses an oversized file before a byte is read', () => {
    expect(planWaveformTransfer(MAX_OPEN_BYTES + 1)).toEqual({
      mode: 'refused',
      totalBytes: MAX_OPEN_BYTES + 1,
      reason: 'too_large',
    });
  });

  it('refuses an empty file rather than showing an empty waveform', () => {
    expect(planWaveformTransfer(0).mode).toBe('refused');
    expect(planWaveformTransfer(0)).toMatchObject({ reason: 'empty' });
  });

  it('refuses a size that is not a number at all', () => {
    expect(planWaveformTransfer(Number.NaN).mode).toBe('refused');
    expect(planWaveformTransfer(-1).mode).toBe('refused');
  });

  it('refuses when a smaller chunk size would exceed the receiver’s chunk cap', () => {
    // Unreachable with today's constants, and the reason the check exists: a
    // future chunk-size change must fail here rather than as a rejected
    // transfer at a user's desk.
    const plan = planWaveformTransfer(MAX_OPEN_BYTES, { chunkBytes: 1024 });
    expect(plan).toMatchObject({ mode: 'refused', reason: 'too_large' });
  });
});

describe('frame shapes', () => {
  it('wraps a payload in a CXP envelope with the version host-core speaks', () => {
    const frame = hostBridgeFrame({ kind: 'k', payload: { a: 1 } });
    expect(frame.type).toBe(CXP_FRAME_TYPE);
    expect(frame.protocol).toBe(HOST_BRIDGE_PROTOCOL_VERSION);
    expect(frame.envelope.cxp_version).toBe(cxp.CXP_PROTOCOL_VERSION);
    expect(frame.envelope.from).toBe(HOST_PEER_ID);
    expect(frame.envelope.message_id).not.toBe('');
  });

  it('mints a distinct message id per frame so acks correlate', () => {
    const a = hostBridgeFrame({ kind: 'k', payload: {} });
    const b = hostBridgeFrame({ kind: 'k', payload: {} });
    expect(a.envelope.message_id).not.toBe(b.envelope.message_id);
  });

  it('carries the display name and the bytes on a single-frame open', () => {
    const payload = openWaveformFrame({ displayName: 'top.vcd', bytes: bytes(4) }).envelope
      .payload;
    expect(payload['display_name']).toBe('top.vcd');
    expect(payload['bytes']).toBeInstanceOf(Uint8Array);
  });

  it('repeats count, total and name on every chunk', () => {
    // The receiver validates a chunk on its own terms before buffering it, and
    // detects a chunk that disagrees with the transfer it claims to join.
    const payload = openWaveformChunkFrame({
      transferId: 't',
      index: 2,
      count: 5,
      displayName: 'top.fst',
      totalBytes: 999,
      bytes: bytes(4),
    }).envelope.payload;
    expect(payload).toMatchObject({
      transfer_id: 't',
      index: 2,
      count: 5,
      display_name: 'top.fst',
      total_bytes: 999,
    });
  });
});

describe('streamWaveform', () => {
  async function capture(
    source: BufferByteSource,
    plan: ReturnType<typeof planWaveformTransfer>,
    options: { isCancelled?: () => boolean } = {},
  ): Promise<{ frames: HostBridgeFrame[]; posted: number }> {
    const frames: HostBridgeFrame[] = [];
    const posted = await streamWaveform(source, {
      displayName: 'top.vcd',
      plan,
      transferId: 'transfer-1',
      post: (frame) => {
        frames.push(frame);
        return true;
      },
      ...(options.isCancelled !== undefined ? { isCancelled: options.isCancelled } : {}),
    });
    return { frames, posted };
  }

  it('hands over every byte of a small file in one frame', async () => {
    const data = bytes(1000);
    const { frames, posted } = await capture(
      new BufferByteSource(data),
      planWaveformTransfer(data.byteLength),
    );
    expect(posted).toBe(1);
    expect(frames[0]?.envelope.kind).toBe(OPEN_WAVEFORM_KIND);
    expect(frames[0]?.envelope.payload['bytes']).toEqual(data);
  });

  it('hands over every byte of a large file, in order, and nothing else', async () => {
    const data = bytes(10_000);
    const plan = planWaveformTransfer(data.byteLength, {
      singleShotMaxBytes: 1000,
      chunkBytes: 4096,
    });
    const { frames, posted } = await capture(new BufferByteSource(data), plan);
    expect(posted).toBe(3);

    const reassembled = new Uint8Array(data.byteLength);
    let offset = 0;
    frames.forEach((frame, index) => {
      expect(frame.envelope.kind).toBe(OPEN_WAVEFORM_CHUNK_KIND);
      const payload = frame.envelope.payload;
      expect(payload['index']).toBe(index);
      expect(payload['count']).toBe(3);
      expect(payload['total_bytes']).toBe(data.byteLength);
      expect(payload['transfer_id']).toBe('transfer-1');
      const chunk = payload['bytes'] as Uint8Array;
      reassembled.set(chunk, offset);
      offset += chunk.byteLength;
    });
    expect(offset).toBe(data.byteLength);
    expect(reassembled).toEqual(data);
  });

  it('never posts a chunk larger than the plan’s chunk size', async () => {
    const data = bytes(10_000);
    const plan = planWaveformTransfer(data.byteLength, {
      singleShotMaxBytes: 1000,
      chunkBytes: 4096,
    });
    const { frames } = await capture(new BufferByteSource(data), plan);
    for (const frame of frames) {
      expect((frame.envelope.payload['bytes'] as Uint8Array).byteLength).toBeLessThanOrEqual(4096);
    }
  });

  it('posts nothing for a refused plan — the refusal is the caller’s to explain', async () => {
    const { frames, posted } = await capture(
      new BufferByteSource(new Uint8Array(0)),
      planWaveformTransfer(0),
    );
    expect(posted).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('stops mid-transfer when the panel goes away', async () => {
    const data = bytes(10_000);
    const plan = planWaveformTransfer(data.byteLength, {
      singleShotMaxBytes: 1000,
      chunkBytes: 4096,
    });
    let sent = 0;
    const posted = await streamWaveform(new BufferByteSource(data), {
      displayName: 'top.vcd',
      plan,
      transferId: 't',
      post: () => {
        sent += 1;
        return true;
      },
      isCancelled: () => sent >= 2,
    });
    expect(posted).toBe(2);
    expect(sent).toBe(2);
  });
});
