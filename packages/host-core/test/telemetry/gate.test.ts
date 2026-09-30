import { describe, expect, it } from 'vitest';
import { FakeTelemetryGateHost } from '../../src/telemetry/gate';

describe('FakeTelemetryGateHost', () => {
  it('reflects the current value, not a value cached at construction', () => {
    const gate = new FakeTelemetryGateHost(true);
    expect(gate.isEnabled()).toBe(true);
    gate.set(false);
    expect(gate.isEnabled()).toBe(false);
    gate.set(true);
    expect(gate.isEnabled()).toBe(true);
  });

  it('notifies listeners only on an actual change', () => {
    const gate = new FakeTelemetryGateHost(true);
    const seen: boolean[] = [];
    gate.onDidChange((enabled) => seen.push(enabled));
    gate.set(true); // no-op: already true
    gate.set(false);
    gate.set(false); // no-op: already false
    gate.set(true);
    expect(seen).toEqual([false, true]);
  });

  it('a disposed listener stops receiving changes', () => {
    const gate = new FakeTelemetryGateHost(true);
    const seen: boolean[] = [];
    const subscription = gate.onDidChange((enabled) => seen.push(enabled));
    gate.set(false);
    subscription.dispose();
    gate.set(true);
    expect(seen).toEqual([false]);
  });
});
