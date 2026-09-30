import { StringDecoder } from 'node:string_decoder';
import { CxpFrameTooLongError } from './errors';

/**
 * Default upper bound, in UTF-16 code units, on one newline-delimited CXP
 * frame (`defaultCxpMaxLineLength` in crux_cxp; CXP §4.2 RECOMMENDED).
 *
 * A legitimate envelope is a few hundred bytes; even a bulk multi-select
 * stays far below 1 MiB. The cap exists so a peer that streams bytes
 * without ever sending a newline cannot make the receiver buffer without
 * limit.
 */
export const DEFAULT_CXP_MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Default upper bound, in UTF-16 code units, on the outbound bytes one
 * peer connection may have queued but not yet flushed
 * (`defaultCxpMaxPendingWriteBytes` in crux_cxp; CXP §4.2 RECOMMENDED).
 *
 * The inbound direction has always been capped; this is its outbound
 * counterpart. A peer that handshakes and then stops draining its receive
 * window would otherwise grow the sender's heap without bound. 8 MiB is
 * ~8 000 worst-case v1 frames, so reaching it means the peer is not
 * reading at all.
 */
export const DEFAULT_CXP_MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;

/** Callbacks a [CappedLineSplitter] delivers its output through. */
export interface CappedLineSplitterHandlers {
  /** One complete frame, with its terminator (and one trailing `\r`) removed. */
  readonly onLine: (line: string) => void;
  /** The cap was breached. Terminal: no further line or end is delivered. */
  readonly onError: (error: CxpFrameTooLongError) => void;
  /** The stream ended cleanly. Not called after [onError]. */
  readonly onEnd?: () => void;
}

/**
 * Newline splitter with an upper bound on line length — the TypeScript
 * port of crux_cxp's `CappedLineSplitter`, with the same four behaviours
 * that class's doc comment pins:
 *
 * 1. **The cap is checked twice.** On the accumulated *unterminated*
 *    buffer, so a peer that never sends `\n` is cut off while it is still
 *    buffering rather than at some notional frame end; and on a
 *    *completed* line, after the `\r` strip.
 * 2. **A trailing chunk with no final newline is still emitted** at end of
 *    stream, for parity with Dart's `LineSplitter`. The cap already
 *    bounded it.
 * 3. **One trailing `\r` is stripped**, so `\r\n` and `\n` are both
 *    accepted (CXP §4.2 MUST).
 * 4. **A breach is terminal and synchronous.** Real sockets deliver data
 *    in flight after a reader has torn itself down — cancellation is
 *    asynchronous everywhere — so a `failed` flag, not the state of the
 *    downstream consumer, is what stops post-failure emission. Without it
 *    the chunk queued behind an over-long frame lands in a consumer that
 *    has already been told the connection is dead.
 *
 * Lengths are UTF-16 code units on both sides: Dart measures the decoded
 * `String`, and so does this. Feed bytes through [writeBytes] so a
 * multi-byte character split across two TCP segments is reassembled before
 * it is measured.
 */
export class CappedLineSplitter {
  private readonly maxLineLength: number;
  private readonly handlers: CappedLineSplitterHandlers;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private failedFlag = false;
  private ended = false;

  constructor(handlers: CappedLineSplitterHandlers, maxLineLength = DEFAULT_CXP_MAX_LINE_LENGTH) {
    this.handlers = handlers;
    this.maxLineLength = maxLineLength;
  }

  /** True once the cap has been breached. The splitter is then inert. */
  get failed(): boolean {
    return this.failedFlag;
  }

  /** Feed raw socket bytes, reassembling any split UTF-8 sequence. */
  writeBytes(chunk: Uint8Array): void {
    if (this.failedFlag || this.ended) return;
    this.write(this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  }

  /** Feed already-decoded text. */
  write(chunk: string): void {
    if (this.failedFlag || this.ended) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      if (newline < 0) {
        this.buffer += chunk.slice(start);
        if (this.buffer.length > this.maxLineLength) {
          this.fail(
            `Unterminated line of ${this.buffer.length} code units exceeds ` +
              `the ${this.maxLineLength}-code-unit cap.`,
          );
        }
        return;
      }
      let line = this.buffer + chunk.slice(start, newline);
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > this.maxLineLength) {
        this.fail(
          `Line of ${line.length} code units exceeds the ` +
            `${this.maxLineLength}-code-unit cap.`,
        );
        return;
      }
      this.handlers.onLine(line);
      // A consumer may tear the connection down from inside onLine (a
      // `goodbye`, an unsupported version). Stop feeding it the rest of
      // the segment rather than dispatching frames into a closed peer.
      if (this.failedFlag || this.ended) return;
      start = newline + 1;
    }
  }

  /**
   * Detach without emitting anything further — the counterpart of
   * cancelling the upstream subscription in the Dart implementation.
   *
   * A consumer that tears its connection down from inside `onLine` calls
   * this; the splitter then stops dispatching the remainder of the segment
   * it is part-way through, exactly as a cancelled `StreamSubscription`
   * stops delivering already-queued lines.
   */
  stop(): void {
    this.ended = true;
    this.buffer = '';
  }

  /**
   * End of stream. Emits a trailing unterminated frame, if any, then
   * reports the end. A no-op once the splitter has failed or ended.
   */
  end(): void {
    if (this.failedFlag || this.ended) return;
    this.ended = true;
    const trailing = this.buffer + this.decoder.end();
    this.buffer = '';
    if (trailing.length > 0) this.handlers.onLine(trailing);
    this.handlers.onEnd?.();
  }

  private fail(message: string): void {
    if (this.failedFlag) return;
    this.failedFlag = true;
    this.buffer = '';
    this.handlers.onError(new CxpFrameTooLongError(message));
  }
}

/**
 * Encode one already-serialised JSON object as a frame: the JSON text plus
 * a single line feed. `CxpEnvelope.encodeLine` in crux_cxp.
 */
export function encodeFrame(json: string): string {
  return `${json}\n`;
}
