/**
 * Handing a waveform's bytes to the webview.
 *
 * A webview has no filesystem. CXP's `request_open_artifact` resolves a
 * *path*, which is exactly the thing the app on the other side cannot use, so
 * the bridge carries a product-defined kind whose payload is the bytes
 * themselves — `crux.open_waveform_bytes`, defined in WaveCrux's
 * `lib/services/host_bridge/host_bridge_messages.dart`. This module
 * is the host's half of that contract and nothing else: no `vscode` import, so
 * every bound below is testable without an extension host.
 *
 * ### Why there are two shapes and not one
 *
 * `postMessage` copies. A single frame carrying 200 MB means one allocation
 * that size in the extension host, another in the webview, and a stall in both
 * while the structured clone runs; a multi-gigabyte one simply fails. So a
 * transfer above [SINGLE_SHOT_MAX_BYTES] is sliced into
 * `crux.open_waveform_chunk` frames and reassembled by the Dart side's
 * `HostBridgeTransferAssembler`, which is bounded in every dimension this
 * module can grow (see [MAX_OPEN_BYTES], [MAX_CHUNKS_PER_TRANSFER], and that
 * class's own docs for the receiving half).
 *
 * Small files keep the single-frame path they already had. It is one message
 * instead of two, it is the original single-frame shape, and the overwhelming
 * majority of waveforms a person double-clicks in an editor are under a few
 * megabytes.
 */
import { cxp } from '@crux-vscode/host-core';

/** Frame `type` for anything carrying a CXP envelope. Mirrors `kHostBridgeCxpFrameType`. */
export const CXP_FRAME_TYPE = 'crux.cxp';

/** Bridge framing version. Mirrors `kHostBridgeProtocolVersion`. */
export const HOST_BRIDGE_PROTOCOL_VERSION = 1;

/**
 * The `from` this host stamps on envelopes it posts into the webview.
 *
 * Not a discovered peer id: the webview does not route on it, and the window's
 * real CXP identity belongs to host-core's peer host. This is a label that
 * says which side of the bridge spoke.
 */
export const HOST_PEER_ID = 'vscode.host';

/** Mirrors `kHostBridgeOpenWaveformKind`. */
export const OPEN_WAVEFORM_KIND = 'crux.open_waveform_bytes';

/** Mirrors `kHostBridgeOpenWaveformChunkKind`. */
export const OPEN_WAVEFORM_CHUNK_KIND = 'crux.open_waveform_chunk';

/**
 * The largest waveform the bridge will carry, mirroring
 * `kHostBridgeMaxOpenBytes`. **Both sides enforce it**: the Dart decoder
 * refuses a transfer above this whatever the host does, and refusing here as
 * well is what turns "the panel silently never opens" into a sentence the user
 * can act on.
 */
export const MAX_OPEN_BYTES = 256 * 1024 * 1024;

/** Slice size for a chunked transfer. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/** At or below this, the whole file crosses in one `crux.open_waveform_bytes` frame. */
export const SINGLE_SHOT_MAX_BYTES = CHUNK_BYTES;

/** Mirrors `kHostBridgeMaxChunksPerTransfer`; asserted against [MAX_OPEN_BYTES] by a test. */
export const MAX_CHUNKS_PER_TRANSFER = 4096;

/** Why [planWaveformTransfer] refused. */
export type WaveformTransferRefusal = 'empty' | 'too_large';

/** How a given byte count will be delivered. */
export type WaveformTransferPlan =
  | { readonly mode: 'single'; readonly totalBytes: number }
  | {
      readonly mode: 'chunked';
      readonly totalBytes: number;
      readonly chunkBytes: number;
      readonly chunkCount: number;
    }
  | {
      readonly mode: 'refused';
      readonly totalBytes: number;
      readonly reason: WaveformTransferRefusal;
    };

/**
 * Decide how (or whether) to deliver [totalBytes].
 *
 * Refuses before reading a single byte, which is the point: a 4 GB FST must
 * cost a `stat` and a message, not four gigabytes of host memory followed by a
 * receiver that rejects it anyway.
 *
 * A zero-byte file is refused too. It is a real thing to double-click — a
 * simulation that crashed on its first write leaves one — and "the panel shows
 * an empty waveform" is a worse answer than saying so.
 */
export function planWaveformTransfer(
  totalBytes: number,
  options: {
    readonly maxBytes?: number;
    readonly singleShotMaxBytes?: number;
    readonly chunkBytes?: number;
  } = {},
): WaveformTransferPlan {
  const maxBytes = options.maxBytes ?? MAX_OPEN_BYTES;
  const singleShotMaxBytes = options.singleShotMaxBytes ?? SINGLE_SHOT_MAX_BYTES;
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return { mode: 'refused', totalBytes, reason: 'empty' };
  }
  if (totalBytes > maxBytes) {
    return { mode: 'refused', totalBytes, reason: 'too_large' };
  }
  if (totalBytes <= singleShotMaxBytes) return { mode: 'single', totalBytes };
  const chunkCount = Math.ceil(totalBytes / chunkBytes);
  if (chunkCount > MAX_CHUNKS_PER_TRANSFER) {
    // Unreachable with the constants above (256 MiB / 4 MiB = 64), and kept
    // because the receiver enforces it: a future smaller chunk size must fail
    // here, in a test, rather than as a rejected transfer at a user's desk.
    return { mode: 'refused', totalBytes, reason: 'too_large' };
  }
  return { mode: 'chunked', totalBytes, chunkBytes, chunkCount };
}

/** A frame as it goes over `webview.postMessage`. */
export interface HostBridgeFrame {
  readonly type: string;
  readonly protocol: number;
  readonly envelope: {
    readonly cxp_version: string;
    readonly message_id: string;
    readonly from: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  };
}

/**
 * Wrap a payload in the envelope + frame the Dart side decodes.
 *
 * The version and the id come from host-core's CXP module rather than being
 * spelled again here — the bridge is a CXP relay, and a second definition of
 * "which protocol version do we speak" is the kind of drift that only shows up
 * as a silently dropped frame.
 *
 * Typed with `Record<string, unknown>` and not host-core's `JsonObject`: a
 * chunk's `bytes` is a `Uint8Array`, which crosses `postMessage` as a
 * structured clone and is not JSON at all. That is the one place this frame
 * shape departs from a socket frame, and it is why these frames never reach
 * `encodeEnvelopeLine`.
 */
export function hostBridgeFrame(options: {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly messageId?: string | undefined;
}): HostBridgeFrame {
  return {
    type: CXP_FRAME_TYPE,
    protocol: HOST_BRIDGE_PROTOCOL_VERSION,
    envelope: {
      cxp_version: cxp.CXP_PROTOCOL_VERSION,
      message_id: options.messageId ?? cxp.newCxpMessageId(),
      from: HOST_PEER_ID,
      kind: options.kind,
      payload: options.payload,
    },
  };
}

/** The whole waveform in one frame. */
export function openWaveformFrame(options: {
  readonly displayName: string;
  readonly bytes: Uint8Array;
  readonly messageId?: string | undefined;
}): HostBridgeFrame {
  return hostBridgeFrame({
    kind: OPEN_WAVEFORM_KIND,
    messageId: options.messageId,
    payload: { display_name: options.displayName, bytes: options.bytes },
  });
}

/**
 * One slice of a chunked transfer.
 *
 * `count`, `total_bytes` and `display_name` ride on every chunk. The receiver
 * needs them to validate a chunk on its own terms before buffering it, and to
 * notice a chunk that disagrees with the transfer it claims to belong to.
 */
export function openWaveformChunkFrame(options: {
  readonly transferId: string;
  readonly index: number;
  readonly count: number;
  readonly displayName: string;
  readonly totalBytes: number;
  readonly bytes: Uint8Array;
  readonly messageId?: string | undefined;
}): HostBridgeFrame {
  return hostBridgeFrame({
    kind: OPEN_WAVEFORM_CHUNK_KIND,
    messageId: options.messageId,
    payload: {
      transfer_id: options.transferId,
      index: options.index,
      count: options.count,
      display_name: options.displayName,
      total_bytes: options.totalBytes,
      bytes: options.bytes,
    },
  });
}

/**
 * Reads a byte range out of whatever is backing a waveform.
 *
 * An interface rather than a `Uint8Array` so the host never has to hold the
 * whole file: the `file:`-scheme implementation is a positional read on an
 * open descriptor, so a 200 MB transfer costs one 4 MB buffer at a time in the
 * extension host. See `src/editor/byte-source.ts`.
 */
export interface WaveformByteSource {
  readonly totalBytes: number;
  /** Exactly [length] bytes at [offset], or fewer only at end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
  dispose(): Promise<void> | void;
}

/**
 * Post [source]'s bytes to a webview according to [plan].
 *
 * `await`s each `post` so a slow receiver is not handed 64 frames at once —
 * `Webview.postMessage` resolves once the message has been handed to the
 * webview, which is the only backpressure signal the API offers.
 *
 * Returns the number of frames posted. A `refused` plan posts nothing and
 * returns 0: refusal is the caller's to explain, because only the caller knows
 * what to show instead.
 */
export async function streamWaveform(
  source: WaveformByteSource,
  options: {
    readonly displayName: string;
    readonly plan: WaveformTransferPlan;
    readonly transferId: string;
    /**
     * `PromiseLike` rather than `Promise`: `Webview.postMessage` returns
     * VSCode's own `Thenable`, and this module does not import `vscode`.
     */
    readonly post: (frame: HostBridgeFrame) => PromiseLike<boolean> | boolean;
    /** Aborts the stream between frames — a panel disposed mid-transfer. */
    readonly isCancelled?: () => boolean;
  },
): Promise<number> {
  const { displayName, plan, transferId, post } = options;
  const cancelled = options.isCancelled ?? ((): boolean => false);
  if (plan.mode === 'refused') return 0;

  if (plan.mode === 'single') {
    const bytes = await source.read(0, plan.totalBytes);
    if (cancelled()) return 0;
    await post(openWaveformFrame({ displayName, bytes }));
    return 1;
  }

  let posted = 0;
  for (let index = 0; index < plan.chunkCount; index += 1) {
    if (cancelled()) return posted;
    const offset = index * plan.chunkBytes;
    const length = Math.min(plan.chunkBytes, plan.totalBytes - offset);
    const bytes = await source.read(offset, length);
    if (cancelled()) return posted;
    await post(
      openWaveformChunkFrame({
        transferId,
        index,
        count: plan.chunkCount,
        displayName,
        totalBytes: plan.totalBytes,
        bytes,
      }),
    );
    posted += 1;
  }
  return posted;
}
