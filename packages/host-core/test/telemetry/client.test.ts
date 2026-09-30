import { describe, expect, it } from 'vitest';
import { TelemetryClient, type TelemetryClientOptions } from '../../src/telemetry/client';
import { TELEMETRY_EVENTS } from '../../src/telemetry/events';
import { FakeTelemetryGateHost } from '../../src/telemetry/gate';
import { RecordingTelemetrySender } from '../../src/telemetry/sender';

function makeClient(
  overrides: Partial<TelemetryClientOptions> = {},
): { client: TelemetryClient; sender: RecordingTelemetrySender; gate: FakeTelemetryGateHost } {
  const sender = new RecordingTelemetrySender();
  const gate = new FakeTelemetryGateHost(true);
  const client = new TelemetryClient({
    product: 'wavecrux',
    appVersion: () => '0.6.0',
    installationId: () => '6f1b0d3e-1234-4abc-8def-0123456789ab',
    locale: () => 'en',
    endpoint: 'https://telemetry.edacrux.app/dev/v1/events',
    gate,
    sender,
    now: () => Date.parse('2026-08-10T09:15:00Z'),
    ...overrides,
  });
  return { client, sender, gate };
}

describe('TelemetryClient — the consent gate', () => {
  it('no event is sent when isTelemetryEnabled is false', async () => {
    const { client, sender, gate } = makeClient();
    gate.set(false);
    client.record({ name: TELEMETRY_EVENTS.activated });
    await client.flush();
    expect(sender.sent).toEqual([]);
  });

  it('record() does not even queue while consent is off — nothing to leak later', () => {
    const { client, gate } = makeClient();
    gate.set(false);
    client.record({ name: TELEMETRY_EVENTS.activated });
    expect(client.queueLength).toBe(0);
  });

  it('checks consent live, not a value cached at construction', async () => {
    const { client, sender, gate } = makeClient();
    // Constructed while enabled; nothing has read `isEnabled` yet at this point.
    gate.set(false);
    client.record({ name: TELEMETRY_EVENTS.activated });
    gate.set(true);
    client.record({ name: TELEMETRY_EVENTS.fileOpened });
    await client.flush();
    expect(sender.sent).toHaveLength(1);
    const payload = sender.sent[0]?.payload as { events: { name: string }[] };
    // Only the event recorded after consent was restored — the one
    // recorded while off was never queued at all.
    expect(payload.events.map((event) => event.name)).toEqual([TELEMETRY_EVENTS.fileOpened]);
  });

  it('withdrawing consent mid-session drops an already-queued batch, not merely skips sending it', async () => {
    const { client, sender, gate } = makeClient();
    client.start();
    client.record({ name: TELEMETRY_EVENTS.activated });
    expect(client.queueLength).toBe(1);

    // The onDidChange(false) subscription armed by start() must clear the
    // queue immediately — not wait for the next flush tick.
    gate.set(false);
    expect(client.queueLength).toBe(0);

    await client.flush();
    expect(sender.sent).toEqual([]);
    client.dispose();
  });

  it('flush() re-checks consent and drops the queue even without start()', async () => {
    const { client, sender, gate } = makeClient();
    client.record({ name: TELEMETRY_EVENTS.activated });
    gate.set(false);
    // No start() was called, so there is no onDidChange subscription — the
    // second gate check inside flush() is what still has to catch this.
    await client.flush();
    expect(sender.sent).toEqual([]);
    expect(client.queueLength).toBe(0);
  });
});

describe('TelemetryClient — sending', () => {
  it('builds the envelope from the injected providers and sends the coalesced batch', async () => {
    const { client, sender } = makeClient();
    client.record({ name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'spi' } });
    client.record({ name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'spi' } });
    await client.flush();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.url).toBe('https://telemetry.edacrux.app/dev/v1/events');
    expect(sender.sent[0]?.payload).toEqual({
      installation_id: '6f1b0d3e-1234-4abc-8def-0123456789ab',
      app_version: '0.6.0',
      product: 'wavecrux',
      os: expect.any(String) as string,
      form_factor: 'vscode',
      locale: 'en',
      license_tier: 'openCore',
      session_start: '2026-08-10T09:15:00Z',
      events: [
        { name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'spi' }, count: 2 },
      ],
    });
  });

  it('clears the queue after a successful flush', async () => {
    const { client } = makeClient();
    client.record({ name: TELEMETRY_EVENTS.activated });
    await client.flush();
    expect(client.queueLength).toBe(0);
  });

  it('defers when app_version is not yet known, keeping the queue intact', async () => {
    const { client, sender } = makeClient({ appVersion: () => undefined });
    client.record({ name: TELEMETRY_EVENTS.activated });
    await client.flush();
    expect(sender.sent).toEqual([]);
    expect(client.queueLength).toBe(1);
  });

  it('drops the batch on a sender failure rather than throwing or retrying', async () => {
    const { client, sender } = makeClient();
    sender.failWith = new Error('network down');
    client.record({ name: TELEMETRY_EVENTS.activated });
    await expect(client.flush()).resolves.toBeUndefined();
    expect(client.queueLength).toBe(0);
  });

  it('flushing an empty queue does nothing', async () => {
    const { client, sender } = makeClient();
    await client.flush();
    expect(sender.sent).toEqual([]);
  });
});

describe('TelemetryClient.recordFromWebview — untrusted input', () => {
  it('a well-formed descriptor is recorded exactly like a host-native event', async () => {
    const { client, sender } = makeClient();
    client.recordFromWebview({ name: TELEMETRY_EVENTS.fileOpened, properties: { format: 'vcd' } });
    await client.flush();
    const payload = sender.sent[0]?.payload as { events: { name: string; properties?: unknown }[] };
    expect(payload.events).toEqual([
      { name: TELEMETRY_EVENTS.fileOpened, properties: { format: 'vcd' }, count: 1 },
    ]);
  });

  it('cannot smuggle a property value the host would not accept from itself', async () => {
    const { client, sender } = makeClient();
    // A path and a signal name — exactly what must never be sent, and the same
    // validation `record()` applies to its own call sites.
    client.recordFromWebview({
      name: TELEMETRY_EVENTS.fileOpened,
      properties: { format: 'vcd', path: '/Users/dev/secret.vcd', signal: 'top.cpu.pc' },
    });
    await client.flush();
    const payload = sender.sent[0]?.payload as { events: { properties?: Record<string, unknown> }[] };
    expect(payload.events[0]?.properties).toEqual({ format: 'vcd' });
  });

  it('is gated exactly like a host-native record — nothing queues while consent is off', () => {
    const { client, gate } = makeClient();
    gate.set(false);
    client.recordFromWebview({ name: TELEMETRY_EVENTS.fileOpened });
    expect(client.queueLength).toBe(0);
  });

  it('drops non-object payloads, a missing name, and a non-string name without throwing', () => {
    const { client } = makeClient();
    expect(() => {
      client.recordFromWebview(null);
      client.recordFromWebview('a string');
      client.recordFromWebview(42);
      client.recordFromWebview([]);
      client.recordFromWebview({});
      client.recordFromWebview({ name: 123 });
    }).not.toThrow();
    expect(client.queueLength).toBe(0);
  });

  it('an invalid event name in the descriptor is dropped, not sent as-is', () => {
    const { client } = makeClient();
    client.recordFromWebview({ name: 'top.cpu.alu.result' });
    expect(client.queueLength).toBe(0);
  });
});

describe('TelemetryClient.start / dispose', () => {
  it('start() is idempotent and dispose() tears down cleanly', () => {
    const { client } = makeClient();
    expect(() => {
      client.start();
      client.start();
      client.dispose();
      client.dispose();
    }).not.toThrow();
  });
});
