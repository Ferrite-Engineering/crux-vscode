/**
 * `installation_id`: a random v4 UUID, minted once per extension and
 * persisted so it survives restarts.
 *
 * **Never `vscode.env.machineId`.** That value is stable across every
 * extension on the machine and is exactly the "hardware fingerprint" the
 * suite's telemetry rules ban — a random UUID is what makes `installation_id` uncorrelatable
 * with anything else, on purpose (see `crux_telemetry`'s README: "the
 * point is not that a fingerprint would be unreadable; it is that a
 * fingerprint would be stable across reinstalls and correlatable with
 * other data").
 *
 * One id **per product extension**, not one per VSCode window and not one
 * shared across the pack: each extension has its own `globalState`, and
 * that mirrors how each product's desktop/mobile build already mints its
 * own installation id independently — WaveCrux's is not NetCrux's there
 * either.
 */
import { randomUUID } from 'node:crypto';
import { isValidTelemetryInstallationId } from './vocabulary';

/** Where the minted id is persisted. Shaped like `vscode.Memento`'s subset this needs. */
export interface TelemetryInstallationIdStorage {
  get(key: string): string | undefined;
  update(key: string, value: string): void | Thenable<void>;
}

/** The `globalState` key the installation id is stored under. */
export const TELEMETRY_INSTALLATION_ID_STORAGE_KEY = 'edacrux.telemetry.installationId';

/**
 * Read the persisted installation id from [storage], minting and
 * persisting a fresh one if absent or malformed.
 *
 * A malformed stored value (a future format this build predates, a value
 * some other tool wrote into the same key by mistake) is treated exactly
 * like "absent" — minting a fresh id is always safe, since the id carries
 * no meaning beyond "a stable random token for this installation" and a
 * new one costs nothing but continuity of that one dimension.
 */
export function readOrMintTelemetryInstallationId(
  storage: TelemetryInstallationIdStorage,
  mint: () => string = randomUUID,
): string {
  const existing = storage.get(TELEMETRY_INSTALLATION_ID_STORAGE_KEY);
  if (existing !== undefined && isValidTelemetryInstallationId(existing)) return existing;
  const minted = mint();
  void storage.update(TELEMETRY_INSTALLATION_ID_STORAGE_KEY, minted);
  return minted;
}

/** In-memory [TelemetryInstallationIdStorage], for tests. */
export class InMemoryTelemetryInstallationIdStorage implements TelemetryInstallationIdStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  update(key: string, value: string): void {
    this.values.set(key, value);
  }
}
