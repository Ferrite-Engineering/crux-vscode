import { describe, expect, it } from 'vitest';
import { CRUX_WINDOW_API_VERSION, isCruxWindowApi, type CruxWindowApi } from '../../src/window/api';
import {
  CRUX_WINDOW_HOST_ORDER,
  activeWindowHostApi,
  electCruxWindowRole,
  readWindowApi,
  type ExtensionHandle,
  type ExtensionRegistryView,
} from '../../src/window/election';
import type { CruxDesktopProduct } from '../../src/desktop-detect';

/**
 * A stand-in extension whose exports and activation behaviour are
 * scripted, and which **reproduces VSCode's throwing `exports` getter**.
 *
 * Measured in a real extension host (VSCode 1.130.0): reading `exports`
 * before activation raises `Extension '<id>' is not known or not
 * activated`. A fake that returned `undefined` instead would have let the
 * election ship with a crash in the one case it was written for — an
 * elected host whose activation events have not fired.
 */
class FakeExtension implements ExtensionHandle {
  isActive = false;
  activations = 0;

  private exported: unknown = undefined;

  constructor(
    readonly id: string,
    private readonly onActivate: () => unknown,
    private readonly failure?: Error,
  ) {}

  get exports(): unknown {
    if (!this.isActive) {
      throw new Error(`Extension '${this.id}' is not known or not activated`);
    }
    return this.exported;
  }

  activate(): Promise<unknown> {
    this.activations += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.isActive = true;
    this.exported = this.onActivate();
    return Promise.resolve(this.exported);
  }
}

function api(overrides: Partial<CruxWindowApi> = {}): CruxWindowApi {
  return {
    cruxWindowApiVersion: CRUX_WINDOW_API_VERSION,
    isWindowHost: () => true,
    hostExtensionId: () => 'ferrite-engineering.lintcrux',
    join: () => ({ dispose: () => undefined }),
    peers: () => [],
    capabilities: () => [],
    ...overrides,
  };
}

function registry(handles: readonly FakeExtension[]): ExtensionRegistryView {
  return {
    getExtension: (id) => handles.find((handle) => handle.id === id),
  };
}

const id = (product: CruxDesktopProduct): string => `ferrite-engineering.${product}`;

describe('CRUX_WINDOW_HOST_ORDER', () => {
  it('is every product exactly once, by extension id ascending', () => {
    expect([...CRUX_WINDOW_HOST_ORDER]).toEqual(['lintcrux', 'netcrux', 'simcrux', 'wavecrux']);
    expect(new Set(CRUX_WINDOW_HOST_ORDER).size).toBe(CRUX_WINDOW_HOST_ORDER.length);
    // WaveCrux last is not decorative: it is the only VSIX carrying a
    // Flutter payload, so it hosts only when nothing else is installed.
    expect(CRUX_WINDOW_HOST_ORDER[CRUX_WINDOW_HOST_ORDER.length - 1]).toBe('wavecrux');
  });
});

describe('isCruxWindowApi', () => {
  it('accepts a well-formed api and rejects everything else', () => {
    expect(isCruxWindowApi(api())).toBe(true);
    expect(isCruxWindowApi(undefined)).toBe(false);
    expect(isCruxWindowApi(null)).toBe(false);
    expect(isCruxWindowApi({})).toBe(false);
    expect(isCruxWindowApi({ ...api(), join: 'not a function' })).toBe(false);
    expect(isCruxWindowApi({ ...api(), cruxWindowApiVersion: 0 })).toBe(false);
  });

  it('accepts a NEWER api version', () => {
    // The negotiation rule, and the reason it is written that way: a guest
    // that refuses a newer host elects itself, and the window ends up with
    // two peer manifests — strictly worse than joining an api whose extra
    // fields it ignores.
    expect(isCruxWindowApi(api({ cruxWindowApiVersion: 99 }))).toBe(true);
  });
});

describe('readWindowApi', () => {
  it('is undefined for an extension whose activate() threw', () => {
    // Measured in a real extension host: VSCode reports `isActive: true`
    // for an extension whose activation failed, and `exports` is
    // undefined. The api shape is the only trustworthy evidence.
    const failed = new FakeExtension(id('lintcrux'), () => undefined);
    failed.isActive = true;
    expect(readWindowApi(failed)).toBeUndefined();
    expect(readWindowApi(undefined)).toBeUndefined();
  });

  it('does not throw for an installed extension that has never activated', () => {
    // The regression this guards: VSCode's `exports` getter raises for an
    // inactive extension, so a naive read during our own `activate()`
    // fails the activation outright. Observed exactly that way in a real
    // extension host before the guard existed.
    const sleeping = new FakeExtension(id('lintcrux'), () => api());
    expect(() => sleeping.exports).toThrow(/not known or not activated/);
    expect(readWindowApi(sleeping)).toBeUndefined();
  });
});

describe('electCruxWindowRole — a cold start', () => {
  it('makes the first installed product in the order the host', async () => {
    const extensions = registry([
      new FakeExtension(id('lintcrux'), () => undefined),
      new FakeExtension(id('simcrux'), () => undefined),
    ]);
    const role = await electCruxWindowRole({ self: 'lintcrux', extensions });
    expect(role.kind).toBe('host');
  });

  it('sends every other product to that host, whatever activates first', async () => {
    const host = api();
    const lintcrux = new FakeExtension(id('lintcrux'), () => host);
    const extensions = registry([
      lintcrux,
      new FakeExtension(id('simcrux'), () => undefined),
      new FakeExtension(id('wavecrux'), () => undefined),
    ]);
    for (const self of ['simcrux', 'wavecrux'] as const) {
      const role = await electCruxWindowRole({ self, extensions });
      expect(role.kind).toBe('guest');
      if (role.kind === 'guest') expect(role.api).toBe(host);
    }
    // Activated on demand exactly once: the first guest woke it, and by
    // the time the second asked it was an incumbent, which the election
    // recognises synchronously without touching `activate()` at all.
    expect(lintcrux.activations).toBe(1);
  });

  it('hosts when it is the only extension installed', async () => {
    for (const self of CRUX_WINDOW_HOST_ORDER) {
      const extensions = registry([new FakeExtension(id(self), () => undefined)]);
      const role = await electCruxWindowRole({ self, extensions });
      expect(role.kind).toBe('host');
    }
  });

  it('activates a host that no activation event has woken yet', async () => {
    // The awkward case: the elected host is installed, enabled, and
    // inactive because nothing triggered it. `activate()` is what makes it
    // exist; without the explicit call the window would have no peer.
    const lintcrux = new FakeExtension(id('lintcrux'), () => api());
    expect(lintcrux.isActive).toBe(false);
    const extensions = registry([lintcrux, new FakeExtension(id('netcrux'), () => undefined)]);
    const role = await electCruxWindowRole({ self: 'netcrux', extensions });
    expect(role.kind).toBe('guest');
    expect(lintcrux.isActive).toBe(true);
  });
});

describe('electCruxWindowRole — an incumbent', () => {
  it('joins a running host even when the order would prefer us', async () => {
    // Mid-session install: SimCrux is already hosting when LintCrux — the
    // static winner — is installed and activated. A second host would mean
    // a second manifest for one window.
    const incumbent = api({ hostExtensionId: () => id('simcrux') });
    const simcrux = new FakeExtension(id('simcrux'), () => incumbent);
    await simcrux.activate();
    const extensions = registry([new FakeExtension(id('lintcrux'), () => undefined), simcrux]);
    const role = await electCruxWindowRole({ self: 'lintcrux', extensions });
    expect(role.kind).toBe('guest');
    if (role.kind === 'guest') expect(role.api).toBe(incumbent);
    // Nothing extra was activated to find out: the incumbent check is
    // synchronous, so the count is still the one from the setup above.
    expect(simcrux.activations).toBe(1);
  });

  it('ignores a sibling that exports an api but is not hosting', async () => {
    const guestApi = api({ isWindowHost: () => false });
    const simcrux = new FakeExtension(id('simcrux'), () => guestApi);
    await simcrux.activate();
    const extensions = registry([new FakeExtension(id('lintcrux'), () => undefined), simcrux]);
    expect(activeWindowHostApi({ self: 'lintcrux', extensions })).toBeUndefined();
    const role = await electCruxWindowRole({ self: 'lintcrux', extensions });
    expect(role.kind).toBe('host');
  });
});

describe('electCruxWindowRole — a winner that cannot host', () => {
  it('skips an extension whose activation fails, deterministically', async () => {
    const lintcrux = new FakeExtension(id('lintcrux'), () => undefined, new Error('boom'));
    const netcruxApi = api({ hostExtensionId: () => id('netcrux') });
    const netcrux = new FakeExtension(id('netcrux'), () => netcruxApi);
    const extensions = registry([
      lintcrux,
      netcrux,
      new FakeExtension(id('simcrux'), () => undefined),
    ]);
    // NetCrux, next in the order, takes over.
    expect((await electCruxWindowRole({ self: 'netcrux', extensions })).kind).toBe('host');
    // And SimCrux reaches the same conclusion independently.
    const simRole = await electCruxWindowRole({ self: 'simcrux', extensions });
    expect(simRole.kind).toBe('guest');
    if (simRole.kind === 'guest') expect(simRole.api).toBe(netcruxApi);
  });

  it('skips an older build that exports nothing we recognise', async () => {
    // Version skew: LintCrux from before this module existed activates
    // fine and exports `undefined`. It will never host, so it must not be
    // allowed to prevent anyone else from hosting either.
    const lintcrux = new FakeExtension(id('lintcrux'), () => undefined);
    const extensions = registry([lintcrux, new FakeExtension(id('simcrux'), () => undefined)]);
    const role = await electCruxWindowRole({ self: 'simcrux', extensions });
    expect(role.kind).toBe('host');
    expect(lintcrux.activations).toBe(1);
  });

  it('hosts rather than giving up when nothing can host', async () => {
    const extensions = registry([
      new FakeExtension(id('lintcrux'), () => undefined, new Error('boom')),
      new FakeExtension(id('netcrux'), () => undefined, new Error('boom')),
    ]);
    // A window with no peer at all is a silent failure; a duplicate peer
    // is a loud, recoverable one.
    expect((await electCruxWindowRole({ self: 'netcrux', extensions })).kind).toBe('host');
  });
});

describe('electCruxWindowRole — a disabled extension', () => {
  it('is not electable: getExtension returns undefined for it', async () => {
    // VSCode omits disabled extensions from `extensions.all`, so "not
    // installed" and "installed but disabled" are one case here — and
    // electing an extension that will never activate would leave the
    // window without a peer.
    const extensions = registry([new FakeExtension(id('simcrux'), () => undefined)]);
    const role = await electCruxWindowRole({ self: 'simcrux', extensions });
    expect(role.kind).toBe('host');
  });
});
