/**
 * The network seam. Every test in this package runs under plain Node with
 * no real `vscode` and no real network access either:
 * anything that flushes a batch does so through a [TelemetrySender] a test
 * can fake, never through a bare `fetch` call a test would have to
 * intercept or, worse, let through.
 */

/** Posts one batch. Never throws into a UI path — see `client.ts`'s `flush()`. */
export interface TelemetrySender {
  send(url: string, payload: unknown): Promise<void>;
}

/**
 * The real [TelemetrySender], backed by the platform `fetch` (global in
 * Node 22, the minimum this workspace targets — see `package.json`
 * `engines`). Not exercised by any test; the seam above is what makes that
 * acceptable, the same convention as `vscodeEditorHost` in `editor-host.ts`.
 */
export const fetchTelemetrySender: TelemetrySender = {
  async send(url: string, payload: unknown): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`telemetry: ingestion endpoint responded ${String(response.status)}`);
    }
  },
};

/** A [TelemetrySender] that records what it was asked to send and never touches the network. */
export class RecordingTelemetrySender implements TelemetrySender {
  readonly sent: { readonly url: string; readonly payload: unknown }[] = [];
  /** When set, `send()` rejects with this instead of recording — for retry/failure tests. */
  failWith: Error | undefined;

  async send(url: string, payload: unknown): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.sent.push({ url, payload });
    await Promise.resolve();
  }
}
