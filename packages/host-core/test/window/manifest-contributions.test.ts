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

interface ExtensionManifest {
  readonly name: string;
  readonly contributes?: {
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

describe('edacrux.crossProbe.* declarations', () => {
  it('are declared by every one of the four extensions', () => {
    // Before this, they lived only in wavecrux's manifest, so a user who
    // installed LintCrux alone got the behaviour with no way to find or
    // change the setting that governs it.
    for (const { product, json } of manifests) {
      const properties = json.contributes?.configuration?.properties ?? {};
      expect(Object.keys(properties), product).toContain(CROSS_PROBE_SETTING_KEYS.revealSelection);
      expect(Object.keys(properties), product).toContain(
        CROSS_PROBE_SETTING_KEYS.openSourceFocusesEditor,
      );
    }
  });

  it('are byte-identical across the four, so scan order cannot matter', () => {
    for (const key of Object.values(CROSS_PROBE_SETTING_KEYS)) {
      const declarations = manifests.map(({ json }) =>
        JSON.stringify(json.contributes?.configuration?.properties?.[key]),
      );
      expect(new Set(declarations).size, key).toBe(1);
    }
  });

  it('declare the defaults host-core falls back to', () => {
    // A manifest default and `DEFAULT_CROSS_PROBE_SETTINGS` that disagree
    // is invisible until someone reads the setting through a path that
    // misses the manifest — which is exactly what the unit-test `vscode`
    // stand-in does, and what a `getConfiguration` call with no
    // contribution registered does at runtime.
    const properties = manifests[0]?.json.contributes?.configuration?.properties ?? {};
    expect(properties[CROSS_PROBE_SETTING_KEYS.revealSelection]).toMatchObject({
      type: 'boolean',
      default: DEFAULT_CROSS_PROBE_SETTINGS.revealSelection,
    });
    expect(properties[CROSS_PROBE_SETTING_KEYS.openSourceFocusesEditor]).toMatchObject({
      type: 'boolean',
      default: DEFAULT_CROSS_PROBE_SETTINGS.openSourceFocusesEditor,
    });
  });

  it('reference localized descriptions rather than literal English', () => {
    for (const { product, json } of manifests) {
      for (const key of Object.values(CROSS_PROBE_SETTING_KEYS)) {
        const declaration = json.contributes?.configuration?.properties?.[key] as {
          markdownDescription?: string;
        };
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
