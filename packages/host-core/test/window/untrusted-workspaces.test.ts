/**
 * `capabilities.untrustedWorkspaces`, across all five manifests, and what a
 * restricted workspace does to the window-host election.
 *
 * ### Why this is one test file and not five
 *
 * The declarations are deliberately *different* per product, so the
 * byte-identity trick `manifest-contributions.test.ts` uses for the shared
 * `edacrux.*` blocks cannot work here. What can be checked is that each
 * manifest matches a stated intention, and `src/window/trust.ts` is that
 * intention — written down once, next to the election it affects, rather
 * than five times in five packages where four could drift unnoticed.
 *
 * ### The failure this exists to prevent
 *
 * Measured before any of these declarations existed (VSCode 1.130.0, four
 * real VSIXes in a clean profile, untrusted folder): all four extensions
 * disabled, `vscode.extensions.all` carrying none of them, zero CXP peer
 * manifests published, and no message anywhere explaining it. The second
 * failure — the one these tests actually guard — is the opposite mistake:
 * declaring SimCrux `false` and thereby removing the third entry of
 * [CRUX_WINDOW_HOST_ORDER] from a restricted window, which would be a
 * regression if the election could not survive a missing candidate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CRUX_DESKTOP_PRODUCTS, type CruxDesktopProduct } from '../../src/desktop-detect';
import { CRUX_WINDOW_API_VERSION, type CruxWindowApi } from '../../src/window/api';
import {
  CRUX_WINDOW_HOST_ORDER,
  electCruxWindowRole,
  type ExtensionHandle,
  type ExtensionRegistryView,
} from '../../src/window/election';
import {
  CRUX_RESTRICTED_CONFIGURATIONS,
  CRUX_RESTRICTED_MODE_HOST_ORDER,
  CRUX_RESTRICTED_MODE_PRODUCTS,
  CRUX_UNTRUSTED_WORKSPACE_SUPPORT,
} from '../../src/window/trust';

/** The four locales the suite ships. '' is the English default. */
const LOCALES = ['', 'zh-hans', 'ja', 'ko'] as const;

interface UntrustedWorkspacesDeclaration {
  readonly supported?: unknown;
  readonly description?: unknown;
  readonly restrictedConfigurations?: readonly string[];
}

interface ExtensionManifest {
  readonly main?: string;
  readonly extensionPack?: readonly string[];
  readonly capabilities?: {
    readonly untrustedWorkspaces?: UntrustedWorkspacesDeclaration;
  };
  readonly contributes?: {
    readonly configuration?: { readonly properties?: Readonly<Record<string, unknown>> };
  };
}

function packageDir(pkg: string): string {
  return fileURLToPath(new URL(`../../../${pkg}/`, import.meta.url));
}

function manifest(pkg: string): ExtensionManifest {
  return JSON.parse(readFileSync(`${packageDir(pkg)}package.json`, 'utf8')) as ExtensionManifest;
}

function nls(pkg: string, locale: string): Readonly<Record<string, string>> {
  const name = locale === '' ? 'package.nls.json' : `package.nls.${locale}.json`;
  return JSON.parse(readFileSync(`${packageDir(pkg)}${name}`, 'utf8')) as Record<string, string>;
}

function declaration(pkg: string): UntrustedWorkspacesDeclaration {
  const found = manifest(pkg).capabilities?.untrustedWorkspaces;
  // Not `toBeDefined()` in a helper: an absent declaration is the exact
  // defect this file exists for, so it fails as a named assertion below.
  return found ?? {};
}

describe('every extension declares capabilities.untrustedWorkspaces', () => {
  it('is present in all five manifests', () => {
    // VSCode's default for an *undeclared* extension is to disable it in a
    // restricted workspace. Silence here is not neutrality, it is the
    // worst of the three answers.
    for (const pkg of [...CRUX_DESKTOP_PRODUCTS, 'pack']) {
      expect(manifest(pkg).capabilities?.untrustedWorkspaces, pkg).toBeDefined();
    }
  });

  it('declares each product the value trust.ts states', () => {
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      expect(declaration(product).supported, product).toBe(
        CRUX_UNTRUSTED_WORKSPACE_SUPPORT[product],
      );
    }
  });

  it('makes SimCrux the only product disabled outright', () => {
    // It is the only one that executes anything: `tasks.ts` builds a
    // ShellExecution from `edacrux.sim.executable` and a workspace config
    // path. The other three read and render.
    expect(CRUX_UNTRUSTED_WORKSPACE_SUPPORT.simcrux).toBe(false);
    // Sorted: this constant is a *set* of survivors and keeps
    // `CRUX_DESKTOP_PRODUCTS`' order, which is not the election's.
    expect([...CRUX_RESTRICTED_MODE_PRODUCTS].sort()).toEqual([
      'lintcrux',
      'netcrux',
      'wavecrux',
    ]);
  });
});

describe('the extension pack', () => {
  it('supports untrusted workspaces, because it does nothing', () => {
    // No `main`, no activation, no code: its whole effect is to make
    // VSCode install the other four, each of which then answers for
    // itself. Reporting the pack as disabled in restricted mode would read
    // as though its members were disabled too, which is false for three of
    // the four.
    const pack = manifest('pack');
    expect(pack.main).toBeUndefined();
    expect(pack.extensionPack?.length).toBe(4);
    expect(pack.capabilities?.untrustedWorkspaces?.supported).toBe(true);
  });

  it('carries no description, which VSCode only shows for limited/false', () => {
    expect(declaration('pack').description).toBeUndefined();
  });
});

describe('the user-facing description', () => {
  it('is an NLS placeholder on every limited/false extension', () => {
    // Shown to the user in the restricted-mode UI, so it is a manifest
    // string like any other and goes through package.nls*.json.
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      expect(declaration(product).description, product).toBe(
        '%crux.untrustedWorkspaces.description%',
      );
    }
  });

  it('is translated in all four locales, not copied from English', () => {
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      const english = nls(product, '')['crux.untrustedWorkspaces.description'];
      expect(english, product).toBeTruthy();
      for (const locale of LOCALES) {
        if (locale === '') continue;
        const translated = nls(product, locale)['crux.untrustedWorkspaces.description'];
        expect(translated, `${product} ${locale}`).toBeTruthy();
        expect(translated, `${product} ${locale}`).not.toBe(english);
      }
    }
  });

  it('differs per product, because what is reduced differs per product', () => {
    const english = CRUX_DESKTOP_PRODUCTS.map(
      (product) => nls(product, '')['crux.untrustedWorkspaces.description'],
    );
    expect(new Set(english).size).toBe(CRUX_DESKTOP_PRODUCTS.length);
  });
});

describe('restrictedConfigurations', () => {
  it('matches trust.ts for every product', () => {
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      const declared = declaration(product).restrictedConfigurations ?? [];
      expect([...declared], product).toEqual([...CRUX_RESTRICTED_CONFIGURATIONS[product]]);
    }
  });

  it('only ever names a setting that extension actually contributes', () => {
    // A typo, or a setting id that moved, costs nothing at package time
    // and silently protects nothing at run time.
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      const contributed = Object.keys(
        manifest(product).contributes?.configuration?.properties ?? {},
      );
      for (const key of CRUX_RESTRICTED_CONFIGURATIONS[product]) {
        expect(contributed, `${product} ${key}`).toContain(key);
      }
    }
  });

  it('restricts what redirects a read, and leaves the display toggles alone', () => {
    // `lint.resultsPath` takes an absolute path, so an untrusted folder
    // could otherwise choose any file on the machine and have it parsed
    // into the Problems panel.
    expect([...CRUX_RESTRICTED_CONFIGURATIONS.lintcrux]).toContain('edacrux.lint.resultsPath');
    // `rtlAnnotation.enabled` is the one boolean that earns a place: it
    // puts text into the user's own source, and `toggleRtlAnnotationEnabled`
    // writes it globally precisely because it is a reading preference
    // rather than a property of a repository.
    expect([...CRUX_RESTRICTED_CONFIGURATIONS.wavecrux]).toContain(
      'edacrux.rtlAnnotation.enabled',
    );
    // Omitted on purpose: a workspace can only make cross-probing *less*
    // eager with these, and the author name redirects nothing.
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      expect([...CRUX_RESTRICTED_CONFIGURATIONS[product]], product).not.toContain(
        'edacrux.crossProbe.revealSelection',
      );
      expect([...CRUX_RESTRICTED_CONFIGURATIONS[product]], product).not.toContain(
        'edacrux.crossProbe.openSourceFocusesEditor',
      );
      expect([...CRUX_RESTRICTED_CONFIGURATIONS[product]], product).not.toContain(
        'edacrux.lint.waiverAuthor',
      );
      // The one cross-probe toggle a workspace could make *more* eager
      // (it defaults off) — and still omitted, deliberately. Turning it on
      // can at most reveal a file that is already inside that workspace,
      // because `resolveWorkspacePath` sits between the stems entry and
      // the editor. That is precisely what the default-ON
      // `crossProbe.revealSelection` already does for a `source` element,
      // and unlike `rtlAnnotation.enabled` it puts no text into the user's
      // source. Nothing is executed and no read is redirected.
      expect([...CRUX_RESTRICTED_CONFIGURATIONS[product]], product).not.toContain(
        'edacrux.crossProbe.followWaveformSelection',
      );
    }
  });

  it('leaves the SimCrux settings alone, since SimCrux is not running', () => {
    expect([...CRUX_RESTRICTED_CONFIGURATIONS.simcrux]).toEqual([]);
  });
});

/** A sibling that is already hosting, or already a guest. */
function fakeHandle(product: CruxDesktopProduct, exported: CruxWindowApi): ExtensionHandle {
  return {
    id: `ferrite-engineering.${product}`,
    isActive: true,
    exports: exported,
    activate: () => Promise.resolve(exported),
  };
}

function fakeApi(host: boolean, hostProduct: CruxDesktopProduct): CruxWindowApi {
  return {
    cruxWindowApiVersion: CRUX_WINDOW_API_VERSION,
    isWindowHost: () => host,
    hostExtensionId: () => `ferrite-engineering.${hostProduct}`,
    join: () => ({ dispose: () => undefined }),
    peers: () => [],
    capabilities: () => [],
  };
}

/** Every non-empty subset of the four products. */
function subsets(): (readonly CruxDesktopProduct[])[] {
  const out: (readonly CruxDesktopProduct[])[] = [];
  for (let mask = 1; mask < 1 << CRUX_WINDOW_HOST_ORDER.length; mask++) {
    out.push(CRUX_WINDOW_HOST_ORDER.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out;
}

describe('the election in a restricted workspace', () => {
  it('excludes a trust-disabled extension exactly as it excludes an uninstalled one', async () => {
    // The measured fact the whole design rests on: VSCode returns
    // `undefined` from `getExtension` for an extension it disabled for
    // trust — not a handle with `isActive === false`. So the registry a
    // restricted window presents to the election is simply the installed
    // set minus SimCrux, and no code path in `election.ts` is special.
    const extensions: ExtensionRegistryView = { getExtension: () => undefined };
    const role = await electCruxWindowRole({ self: 'lintcrux', extensions });
    expect(role.kind).toBe('host');
  });

  it('still produces exactly one host, for every subset of the four', async () => {
    for (const installed of subsets()) {
      // Restricted mode: the disabled products are absent from the
      // registry, and are not running to ask in the first place.
      const surviving = installed.filter((product) =>
        CRUX_RESTRICTED_MODE_PRODUCTS.includes(product),
      );
      if (surviving.length === 0) continue;

      const expectedHost = CRUX_RESTRICTED_MODE_HOST_ORDER.find((product) =>
        surviving.includes(product),
      );
      expect(expectedHost, installed.join('+')).toBeDefined();
      if (expectedHost === undefined) continue;

      const hostApi = fakeApi(true, expectedHost);
      const handles = new Map<string, ExtensionHandle>();
      for (const product of surviving) {
        handles.set(
          `ferrite-engineering.${product}`,
          fakeHandle(product, product === expectedHost ? hostApi : fakeApi(false, expectedHost)),
        );
      }
      const extensions: ExtensionRegistryView = {
        getExtension: (id) => handles.get(id),
      };

      const hosts: CruxDesktopProduct[] = [];
      for (const self of surviving) {
        // The host itself is asked with its own entry absent, which is the
        // cold-start state: nothing has exported an api yet.
        const cold: ExtensionRegistryView =
          self === expectedHost
            ? { getExtension: (id) => (id.endsWith(self) ? undefined : handles.get(id)) }
            : extensions;
        const role = await electCruxWindowRole({ self, extensions: cold });
        if (role.kind === 'host') hosts.push(self);
        else expect(role.api.hostExtensionId(), `${installed.join('+')} / ${self}`).toBe(
          `ferrite-engineering.${expectedHost}`,
        );
      }
      expect(hosts, installed.join('+')).toEqual([expectedHost]);
    }
  });

  it('never looks the extension pack up, whose activate() never settles', async () => {
    // Measured on VSCode 1.130.0: `ferrite-engineering.edacrux` is an
    // `extensionPack` manifest with no `main`. `getExtension` returns a
    // handle for it, `isActive` stays false, and `activate()` had not
    // settled after 30 s — in a trusted *and* an untrusted workspace. The
    // election `await`s `activate()` with no timeout, so the only thing
    // keeping that hang unreachable is that the pack's id is never asked
    // for. This is that invariant, held as behaviour rather than as a
    // comment.
    const asked: string[] = [];
    const extensions: ExtensionRegistryView = {
      getExtension: (id) => {
        asked.push(id);
        return undefined;
      },
    };
    for (const self of CRUX_WINDOW_HOST_ORDER) {
      await electCruxWindowRole({ self, extensions });
    }
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain('ferrite-engineering.edacrux');
    const allowed = new Set(
      CRUX_WINDOW_HOST_ORDER.map((product) => `ferrite-engineering.${product}`),
    );
    for (const id of asked) expect(allowed, id).toContain(id);
  });

  it('never elects SimCrux, even when SimCrux is installed', () => {
    expect([...CRUX_RESTRICTED_MODE_HOST_ORDER]).not.toContain('simcrux');
    expect([...CRUX_RESTRICTED_MODE_HOST_ORDER]).toEqual(['lintcrux', 'netcrux', 'wavecrux']);
  });

  it('hands SimCrux-only windows no host, which is correct rather than broken', () => {
    // Nothing is left to host one: SimCrux is disabled, and a window with
    // no EDACrux extension running should publish no CXP peer.
    const surviving = CRUX_RESTRICTED_MODE_HOST_ORDER.filter((product) => product === 'simcrux');
    expect(surviving).toEqual([]);
  });

  it('changes who hosts only where SimCrux would have won', () => {
    // The pair that proves the declaration is doing something: trusted,
    // SimCrux+WaveCrux is hosted by SimCrux; restricted, by WaveCrux.
    const pair: readonly CruxDesktopProduct[] = ['simcrux', 'wavecrux'];
    expect(CRUX_WINDOW_HOST_ORDER.find((product) => pair.includes(product))).toBe('simcrux');
    expect(CRUX_RESTRICTED_MODE_HOST_ORDER.find((product) => pair.includes(product))).toBe(
      'wavecrux',
    );
    // And nothing else moves: LintCrux still wins wherever it is installed.
    expect(CRUX_RESTRICTED_MODE_HOST_ORDER[0]).toBe(CRUX_WINDOW_HOST_ORDER[0]);
  });
});
