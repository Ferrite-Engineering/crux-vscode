import { describe, expect, it } from 'vitest';
import {
  InMemoryTelemetryInstallationIdStorage,
  TELEMETRY_INSTALLATION_ID_STORAGE_KEY,
  forgetTelemetryInstallationId,
  readOrMintTelemetryInstallationId,
} from '../../src/telemetry/installation-id';
import { isValidTelemetryInstallationId } from '../../src/telemetry/vocabulary';

describe('readOrMintTelemetryInstallationId', () => {
  it('mints and persists a fresh id when storage is empty', () => {
    const storage = new InMemoryTelemetryInstallationIdStorage();
    const id = readOrMintTelemetryInstallationId(storage, () => '11111111-1111-4111-8111-111111111111');
    expect(id).toBe('11111111-1111-4111-8111-111111111111');
    expect(storage.get(TELEMETRY_INSTALLATION_ID_STORAGE_KEY)).toBe(id);
  });

  it('reuses the persisted id across calls — the id must survive restarts', () => {
    const storage = new InMemoryTelemetryInstallationIdStorage();
    const first = readOrMintTelemetryInstallationId(storage, () => '11111111-1111-4111-8111-111111111111');
    const second = readOrMintTelemetryInstallationId(storage, () => '22222222-2222-4222-8222-222222222222');
    expect(second).toBe(first);
  });

  it('mints fresh over a malformed stored value rather than sending it', () => {
    const storage = new InMemoryTelemetryInstallationIdStorage();
    storage.update(TELEMETRY_INSTALLATION_ID_STORAGE_KEY, 'not-a-uuid');
    const id = readOrMintTelemetryInstallationId(storage, () => '33333333-3333-4333-8333-333333333333');
    expect(id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('the real mint function produces a valid lowercase UUID, never a machine fingerprint', () => {
    const storage = new InMemoryTelemetryInstallationIdStorage();
    const id = readOrMintTelemetryInstallationId(storage);
    expect(isValidTelemetryInstallationId(id)).toBe(true);
  });
});

describe('forgetTelemetryInstallationId', () => {
  it('deletes the persisted id, and the next read mints a new one', () => {
    const storage = new InMemoryTelemetryInstallationIdStorage();
    readOrMintTelemetryInstallationId(storage, () => '11111111-1111-4111-8111-111111111111');
    forgetTelemetryInstallationId(storage);
    expect(storage.get(TELEMETRY_INSTALLATION_ID_STORAGE_KEY)).toBeUndefined();
    const next = readOrMintTelemetryInstallationId(storage, () => '22222222-2222-4222-8222-222222222222');
    expect(next).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('writes nothing when there is no id', () => {
    let writes = 0;
    forgetTelemetryInstallationId({
      get: () => undefined,
      update: () => {
        writes++;
      },
    });
    expect(writes).toBe(0);
  });
});
