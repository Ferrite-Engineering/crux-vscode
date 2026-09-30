import { describe, expect, it } from 'vitest';
import { buildCapabilitiesPanelContent } from '../../src/status/panel-content';

describe('buildCapabilitiesPanelContent', () => {
  it('shows only the installed products, each with its own row', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux', 'lintcrux'],
      desktopPresence: [],
    });
    expect(content.productRows.map((row) => row.product)).toEqual(['wavecrux', 'lintcrux']);
  });

  it('pitches install when no desktop peer is present, and hands off when one is', () => {
    // Constraint E, modelled per product: WaveCrux desktop present,
    // LintCrux desktop absent, in the same window.
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux', 'lintcrux'],
      desktopPresence: [
        { product: 'wavecrux', present: true },
        { product: 'lintcrux', present: false },
      ],
    });
    const wavecrux = content.productRows.find((row) => row.product === 'wavecrux');
    const lintcrux = content.productRows.find((row) => row.product === 'lintcrux');
    expect(wavecrux?.desktopPresent).toBe(true);
    expect(wavecrux?.action.kind).toBe('handoff-command');
    expect(lintcrux?.desktopPresent).toBe(false);
    expect(lintcrux?.action.kind).toBe('install-link');
  });

  it('carries the requested tier through unchanged', () => {
    for (const tier of ['openCore', 'edu', 'pro', 'enterprise'] as const) {
      expect(
        buildCapabilitiesPanelContent({ tier, installedProducts: [], desktopPresence: [] }).tier,
      ).toBe(tier);
    }
  });

  it('always includes a Pro pitch and link, regardless of the current tier', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'pro',
      installedProducts: [],
      desktopPresence: [],
    });
    expect(content.proPitch.length).toBeGreaterThan(0);
    expect(content.proLink.url).toMatch(/^https:\/\//);
  });

  it('defaults to the suite site and documentation links when none are supplied', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: [],
      desktopPresence: [],
    });
    expect(content.links.length).toBeGreaterThanOrEqual(2);
    expect(content.links.every((link) => link.url.startsWith('https://'))).toBe(true);
  });

  it('a per-product copy override replaces only the fields it supplies', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux'],
      desktopPresence: [],
      copy: { desktopPitch: (product) => `custom pitch for ${product}` },
    });
    expect(content.productRows[0]?.headline).toBe('custom pitch for wavecrux');
  });

  it('the install-link action uses the product install URL override when supplied', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux'],
      desktopPresence: [],
      copy: { installUrl: () => 'https://example.test/install' },
    });
    const action = content.productRows[0]?.action;
    expect(action?.kind).toBe('install-link');
    if (action?.kind === 'install-link') expect(action.url).toBe('https://example.test/install');
  });

  // The capability boundaries, surfaced on demand in the one status
  // surface rather than only at the moment a user hits one.
  describe('capability notes', () => {
    it('defaults to none — a product that declares no boundaries shows none', () => {
      const content = buildCapabilitiesPanelContent({
        tier: 'openCore',
        installedProducts: ['wavecrux', 'lintcrux'],
        desktopPresence: [],
      });
      expect(content.productRows.map((row) => row.notes)).toEqual([[], []]);
    });

    it('come from the product’s own copy, per product', () => {
      const content = buildCapabilitiesPanelContent({
        tier: 'openCore',
        installedProducts: ['wavecrux', 'lintcrux'],
        desktopPresence: [],
        copy: {
          capabilityNotes: (product) =>
            product === 'wavecrux' ? ['a boundary', 'another'] : [],
        },
      });
      expect(content.productRows[0]?.notes).toEqual(['a boundary', 'another']);
      expect(content.productRows[1]?.notes).toEqual([]);
    });

    it('are shown whether or not the desktop peer is present', () => {
      // A boundary is a fact about the editor panel, not advertising. Only
      // the headline and the action switch on presence.
      for (const present of [false, true]) {
        const content = buildCapabilitiesPanelContent({
          tier: 'openCore',
          installedProducts: ['wavecrux'],
          desktopPresence: [{ product: 'wavecrux', present }],
          copy: { capabilityNotes: () => ['still true either way'] },
        });
        expect(content.productRows[0]?.notes).toEqual(['still true either way']);
      }
    });
  });
});
