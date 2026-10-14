/**
 * The window-level `contributes` blocks, asserted across all four
 * extension manifests at once.
 *
 * ### Why this test is here rather than in each product package
 *
 * The invariant is a *relationship between the four manifests*, and a
 * per-package test can only ever check its own. Four such tests would all
 * pass on the day one of them drifted. host-core owns the settings these
 * declare (`editor/settings.ts`) and the commands these name
 * (`editor/send.ts`), so this is the one place that can see the whole
 * picture; it reads the manifests as data and imports nothing from a
 * surface package, so the "host-core never imports a surface" rule holds.
 *
 * ### What VSCode actually does with a duplicated contribution — measured
 *
 * Two extensions declaring the same `configuration` property id, in a real
 * install into a clean profile (VSCode 1.130.0, macOS):
 *
 * ```
 * [warning] [ferrite-engineering.wavecrux]: Cannot register
 *   'edacrux.crossProbe.revealSelection'. This property is already registered.
 * ```
 *
 * The **first** registration wins and every later one is dropped whole —
 * its `type`, `default` and description all discarded. There is no error,
 * no failed activation, and exactly **one** row in the Settings UI. The
 * same rule applies to `contributes.commands`:
 *
 * ```
 * [info] [ferrite-engineering.netcrux]: Command `edacrux.openCapabilitiesPanel`
 *   already registered by LintCrux RTL Lint (ferrite-engineering.lintcrux)
 * ```
 *
 * So declaring a window-level id in all four is safe, and it is the only
 * arrangement in which **every standalone install is correct** — a user
 * who installs only LintCrux must still find `edacrux.crossProbe.*` in
 * Settings, since the LintCrux-hosted window is the one obeying it.
 *
 * Any one extension can host, so a setting the *host* obeys must be
 * declared by every extension that can host. A setting only one product
 * obeys is declared by that product alone: `followWaveformSelection` acts
 * inside WaveCrux's own bundle, so it is WaveCrux's and nobody else's, and
 * the other three no longer register a duplicate of it.
 *
 * The catch is that *which* extension's declaration survives depends on
 * scan order, which is not something to reason about at a user's desk. The
 * defence is this test: the four declarations must be **identical**, so
 * the winner cannot matter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CRUX_SEND_COMMAND_IDS } from '../../src/editor/send';
import {
  CROSS_PROBE_SETTING_KEYS,
  DEFAULT_CROSS_PROBE_SETTINGS,
} from '../../src/editor/settings';
import { STATUS_PANEL_COMMAND_ID } from '../../src/status/status-bar';
import { CRUX_WINDOW_HOST_ORDER } from '../../src/window/election';

interface LanguageContribution {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly extensions?: readonly string[];
  readonly configuration?: string;
  readonly filenames?: readonly string[];
}

interface ExtensionManifest {
  readonly name: string;
  readonly contributes?: {
    readonly languages?: readonly LanguageContribution[];
    readonly grammars?: readonly unknown[];
    readonly menus?: Readonly<
      Record<string, readonly { readonly command: string; readonly when?: string }[]>
    >;
    readonly commands?: readonly { readonly command: string; readonly title: string }[];
    readonly configuration?: {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
  };
}

function manifest(product: string): ExtensionManifest {
  const path = fileURLToPath(new URL(`../../../${product}/package.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ExtensionManifest;
}

const manifests = CRUX_WINDOW_HOST_ORDER.map((product) => ({
  product,
  json: manifest(product),
}));

/** The cross-probe settings whichever extension hosts the window obeys. */
const HOST_OBEYED_KEYS = [
  CROSS_PROBE_SETTING_KEYS.revealSelection,
  CROSS_PROBE_SETTING_KEYS.openSourceFocusesEditor,
] as const;

/** The one cross-probe setting only WaveCrux acts on. */
const WAVECRUX_ONLY_KEY = CROSS_PROBE_SETTING_KEYS.followWaveformSelection;

describe('edacrux.crossProbe.* declarations', () => {
  it('declares every host-obeyed setting in every one of the four extensions', () => {
    // Before this, they lived only in wavecrux's manifest, so a user who
    // installed LintCrux alone got the behaviour with no way to find or
    // change the setting that governs it.
    for (const { product, json } of manifests) {
      const properties = json.contributes?.configuration?.properties ?? {};
      for (const key of HOST_OBEYED_KEYS) expect(Object.keys(properties), product).toContain(key);
    }
  });

  it('declares the host-obeyed settings byte-identically, so scan order cannot matter', () => {
    for (const key of HOST_OBEYED_KEYS) {
      const declarations = manifests.map(({ json }) =>
        JSON.stringify(json.contributes?.configuration?.properties?.[key]),
      );
      expect(new Set(declarations).size, key).toBe(1);
    }
  });

  it('declares followWaveformSelection in WaveCrux alone', () => {
    // It acts only where a waveform panel exists, in WaveCrux's own bundle,
    // so there is no install in which another extension needs the row. A
    // second declaration would only produce the "already registered"
    // warning VSCode and its forks log for every duplicate.
    const declaring = manifests
      .filter(({ json }) =>
        Object.keys(json.contributes?.configuration?.properties ?? {}).includes(WAVECRUX_ONLY_KEY),
      )
      .map(({ product }) => product);
    expect(declaring).toEqual(['wavecrux']);
  });

  it('never declares the same configuration id with different bodies', () => {
    // The general form of the byte-identity rule above: whatever is shared
    // between extensions must agree, wherever it is declared.
    const seen = new Map<string, string>();
    for (const { product, json } of manifests) {
      for (const [key, body] of Object.entries(json.contributes?.configuration?.properties ?? {})) {
        const serialised = JSON.stringify(body);
        const previous = seen.get(key);
        if (previous !== undefined) expect(serialised, `${product} ${key}`).toBe(previous);
        seen.set(key, serialised);
      }
    }
  });

  it('declare the defaults host-core falls back to', () => {
    // A manifest default and `DEFAULT_CROSS_PROBE_SETTINGS` that disagree
    // is invisible until someone reads the setting through a path that
    // misses the manifest — which is exactly what the unit-test `vscode`
    // stand-in does, and what a `getConfiguration` call with no
    // contribution registered does at runtime.
    const wavecrux = manifests.find(({ product }) => product === 'wavecrux');
    const properties = wavecrux?.json.contributes?.configuration?.properties ?? {};
    expect(properties[CROSS_PROBE_SETTING_KEYS.revealSelection]).toMatchObject({
      type: 'boolean',
      default: DEFAULT_CROSS_PROBE_SETTINGS.revealSelection,
    });
    expect(properties[CROSS_PROBE_SETTING_KEYS.openSourceFocusesEditor]).toMatchObject({
      type: 'boolean',
      default: DEFAULT_CROSS_PROBE_SETTINGS.openSourceFocusesEditor,
    });
    expect(properties[CROSS_PROBE_SETTING_KEYS.followWaveformSelection]).toMatchObject({
      type: 'boolean',
      default: DEFAULT_CROSS_PROBE_SETTINGS.followWaveformSelection,
    });
  });

  it('reference localized descriptions rather than literal English', () => {
    for (const { product, json } of manifests) {
      for (const key of Object.values(CROSS_PROBE_SETTING_KEYS)) {
        const declaration = json.contributes?.configuration?.properties?.[key] as
          | { markdownDescription?: string }
          | undefined;
        if (declaration === undefined) continue;
        expect(declaration.markdownDescription, `${product} ${key}`).toMatch(/^%.+%$/);
      }
    }
  });
});

describe('window-level commands', () => {
  const windowCommandIds = [
    STATUS_PANEL_COMMAND_ID,
    CRUX_SEND_COMMAND_IDS.notifySelection,
    CRUX_SEND_COMMAND_IDS.requestHighlight,
  ];

  it('are contributed by every extension, so a standalone install has them', () => {
    // Their *handlers* are registered by the elected window host alone —
    // `registerCommand` throws on a duplicate id. The manifest entry is
    // what puts them in the palette, and VSCode drops the duplicates.
    for (const { product, json } of manifests) {
      const declared = (json.contributes?.commands ?? []).map((entry) => entry.command);
      for (const id of windowCommandIds) expect(declared, product).toContain(id);
    }
  });

  it('use identical localized titles across the four', () => {
    for (const id of windowCommandIds) {
      const titles = manifests.map(
        ({ json }) => json.contributes?.commands?.find((entry) => entry.command === id)?.title,
      );
      expect(new Set(titles).size, id).toBe(1);
      expect(titles[0]).toMatch(/^%.+%$/);
    }
  });
});

describe('language ids', () => {
  // NetCrux's context menu and WaveCrux's RTL annotation are both gated on
  // the editor's language id. A fresh install of a VSCode fork has no
  // Verilog extension, so `.v` / `.sv` / `.vhd` files are Plain Text and
  // both features are silently absent. The two extensions therefore
  // contribute the ids they gate on, and nothing more.
  const EXPECTED: Readonly<Record<string, readonly string[]>> = {
    verilog: ['.v', '.vh'],
    systemverilog: ['.sv', '.svh'],
    vhdl: ['.vhd', '.vhdl'],
  };
  const contributors = manifests.filter(({ product }) =>
    ['netcrux', 'wavecrux'].includes(product),
  );

  it('are contributed by NetCrux and WaveCrux with the file extensions HDL uses', () => {
    expect(contributors.map(({ product }) => product).sort()).toEqual(['netcrux', 'wavecrux']);
    for (const { product, json } of contributors) {
      const languages = json.contributes?.languages ?? [];
      expect(languages.map((language) => language.id).sort(), product).toEqual(
        Object.keys(EXPECTED).sort(),
      );
      for (const language of languages) {
        expect([...(language.extensions ?? [])], `${product} ${language.id}`).toEqual(
          EXPECTED[language.id],
        );
      }
    }
  });

  it('are identical in both, so a window with both installed merges to the same thing', () => {
    const [first, second] = contributors.map(({ json }) => JSON.stringify(json.contributes?.languages));
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it('stay minimal, so they cannot fight a Verilog extension the user installed', () => {
    // VSCode merges `languages` entries that share an id: extensions and
    // aliases are unioned. What would fight is a `configuration` (one
    // wins), `filenames`, `firstLine` or a grammar, none of which the
    // pack has any reason to supply. Highlighting is the user's Verilog
    // extension's job.
    for (const { product, json } of contributors) {
      expect(json.contributes?.grammars, product).toBeUndefined();
      for (const language of json.contributes?.languages ?? []) {
        expect(Object.keys(language).sort(), `${product} ${language.id}`).toEqual([
          'aliases',
          'extensions',
          'id',
        ]);
      }
    }
  });

  it('cover every id the NetCrux context-menu clause names', () => {
    const netcrux = manifests.find(({ product }) => product === 'netcrux');
    const clauses = (netcrux?.json.contributes?.menus?.['editor/context'] ?? [])
      .map((entry) => entry.when ?? '')
      .join(' ');
    const named = [...clauses.matchAll(/resourceLangId == (\w+)/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(0);
    const contributed = (netcrux?.json.contributes?.languages ?? []).map((language) => language.id);
    for (const id of named) expect(contributed, `${id}`).toContain(id);
  });
});

describe('manifest placeholders', () => {
  const LOCALES = ['', 'zh-hans', 'ja', 'ko'] as const;

  function placeholders(value: unknown, into: Set<string>): void {
    if (typeof value === 'string') {
      const match = /^%(.+)%$/.exec(value);
      if (match?.[1] !== undefined) into.add(match[1]);
    } else if (Array.isArray(value)) {
      for (const item of value) placeholders(item, into);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) placeholders(item, into);
    }
  }

  it('resolve in every locale of the package that uses them', () => {
    // A `%key%` with no entry renders literally in the UI. Nothing else in
    // CI notices, because the manifest is still valid JSON.
    for (const product of [...CRUX_WINDOW_HOST_ORDER, 'pack']) {
      const json: unknown = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../../../${product}/package.json`, import.meta.url)), 'utf8'),
      );
      const used = new Set<string>();
      placeholders(json, used);
      for (const locale of LOCALES) {
        const file = locale === '' ? 'package.nls.json' : `package.nls.${locale}.json`;
        const nls = JSON.parse(
          readFileSync(fileURLToPath(new URL(`../../../${product}/${file}`, import.meta.url)), 'utf8'),
        ) as Record<string, string>;
        for (const key of used) expect(nls[key], `${product} ${file} ${key}`).toBeTruthy();
      }
    }
  });
});
