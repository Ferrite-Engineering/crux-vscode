/**
 * The consent gate: `vscode.env.isTelemetryEnabled`, read live, never
 * cached.
 *
 * Constraint A is absolute: the Marketplace requires an extension to
 * respect the editor's own telemetry setting, and it must do so **at send
 * time, every time** — not once at activation. A value read once at
 * activation and reused for the rest of the session is exactly the bug
 * this interface exists to make structurally impossible: every caller
 * that wants to know "is telemetry on" calls [TelemetryGateHost.isEnabled]
 * fresh, and nothing in this module stores the answer anywhere.
 *
 * In the opt-in regions (`region.ts`) the gate is closed whatever the
 * setting says: the extensions have no disclosure of their own to ask for
 * consent with.
 */
import * as vscode from 'vscode';
import type { Disposable } from '../cxp/emitter';
import { hostTelemetryRegionSignals, telemetryRequiresOptIn } from './region';

/** The live consent signal, behind an interface so host-core stays testable without a real `vscode`. */
export interface TelemetryGateHost {
  /** `vscode.env.isTelemetryEnabled`, read fresh on every call. */
  isEnabled(): boolean;
  /** `vscode.env.onDidChangeTelemetryEnabled`. */
  onDidChange(listener: (enabled: boolean) => void): Disposable;
}

let optInRegion: boolean | undefined;

/**
 * Whether this machine is in an opt-in region (see `region.ts`). Decided
 * once per extension host from signals that are read, used for this and
 * discarded.
 */
function inOptInRegion(): boolean {
  optInRegion ??= telemetryRequiresOptIn(hostTelemetryRegionSignals(vscode.env.language));
  return optInRegion;
}

/**
 * The real [TelemetryGateHost], backed by `vscode.env`, and closed for good
 * in the opt-in regions, where the extensions have no disclosure to ask
 * with and so send nothing.
 */
export const vscodeTelemetryGateHost: TelemetryGateHost = {
  isEnabled(): boolean {
    return vscode.env.isTelemetryEnabled && !inOptInRegion();
  },
  onDidChange(listener: (enabled: boolean) => void): Disposable {
    const subscription = vscode.env.onDidChangeTelemetryEnabled((enabled) => {
      listener(enabled && !inOptInRegion());
    });
    // Block body, not an expression arrow: `vscode.Disposable.dispose()` is
    // typed `any` in the real API, and returning that value (even
    // discarded) trips `@typescript-eslint/no-unsafe-return`.
    return {
      dispose: () => {
        subscription.dispose();
      },
    };
  },
};

/**
 * An in-memory [TelemetryGateHost] for tests: a mutable `enabled` flag and
 * a `set()` that fires [onDidChange] the same way `vscode.env` would.
 */
export class FakeTelemetryGateHost implements TelemetryGateHost {
  private listeners: ((enabled: boolean) => void)[] = [];

  constructor(private enabled: boolean = true) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Flip consent and notify subscribers, exactly as `vscode.env` would on a live setting change. */
  set(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const listener of [...this.listeners]) listener(enabled);
  }

  onDidChange(listener: (enabled: boolean) => void): Disposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }
}
