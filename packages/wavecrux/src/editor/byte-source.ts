/**
 * Getting a waveform's bytes without holding the whole file.
 *
 * `vscode.workspace.fs.readFile` returns the entire file as one `Uint8Array`.
 * For a 200 MB FST that is 200 MB resident in the extension host *before* the
 * structured clone into the webview doubles it, and the peak is what gets a
 * user's window killed. So the `file:` case — which is every case a person
 * reaches by double-clicking in the Explorer — uses positional reads on an
 * open descriptor and never buffers more than one chunk.
 *
 * Non-`file:` URIs (a virtual filesystem, a remote workspace's provider) have
 * no positional-read API at all, so they fall back to `readFile`. That is a
 * real limit, stated rather than hidden: the fallback is chosen only when
 * there is no alternative, and it is still bounded by
 * [MAX_OPEN_BYTES] because the size check happens first.
 */
import { open, type FileHandle } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { WaveformByteSource } from '../webview/open-waveform';

/**
 * A source backed by an open file descriptor. One buffer per read, allocated
 * at the requested length, so the peak is the chunk size and not the file.
 */
class FileHandleByteSource implements WaveformByteSource {
  constructor(
    private readonly handle: FileHandle,
    readonly totalBytes: number,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(length);
    let filled = 0;
    // `read` may return short of the request for reasons that have nothing to
    // do with end of file (a signal, a network filesystem). Looping is what
    // makes "exactly `length` bytes unless the file ended" true.
    while (filled < length) {
      const { bytesRead } = await this.handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  }

  async dispose(): Promise<void> {
    await this.handle.close();
  }
}

/** A source over bytes already in memory. Used for non-`file:` URIs and by tests. */
export class BufferByteSource implements WaveformByteSource {
  constructor(private readonly bytes: Uint8Array) {}

  get totalBytes(): number {
    return this.bytes.byteLength;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(this.bytes.subarray(offset, offset + length));
  }

  dispose(): void {}
}

/**
 * Size of the waveform at [uri], via `vscode.workspace.fs.stat` — which works
 * for every scheme, unlike `node:fs`.
 *
 * Separate from [openWaveformByteSource] because the size decides whether the
 * file is opened at all: [planWaveformTransfer] refuses an oversized one
 * before a descriptor exists.
 */
export async function waveformSizeBytes(uri: vscode.Uri): Promise<number> {
  const stat = await vscode.workspace.fs.stat(uri);
  return stat.size;
}

/** Open a [WaveformByteSource] for [uri]. See the module docs for the two cases. */
export async function openWaveformByteSource(
  uri: vscode.Uri,
  totalBytes: number,
): Promise<WaveformByteSource> {
  if (uri.scheme === 'file') {
    const handle = await open(uri.fsPath, 'r');
    return new FileHandleByteSource(handle, totalBytes);
  }
  return new BufferByteSource(await vscode.workspace.fs.readFile(uri));
}
