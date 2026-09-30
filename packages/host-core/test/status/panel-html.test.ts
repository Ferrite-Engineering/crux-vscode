import { describe, expect, it } from 'vitest';
import { buildCapabilitiesPanelContent } from '../../src/status/panel-content';
import { renderCapabilitiesPanelHtml } from '../../src/status/panel-html';

describe('renderCapabilitiesPanelHtml', () => {
  it('renders every product row with its action, and the tier, Pro, and links sections', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux', 'lintcrux'],
      desktopPresence: [{ product: 'wavecrux', present: true }],
    });
    const html = renderCapabilitiesPanelHtml(content);

    expect(html).toContain('<!doctype html>');
    // WaveCrux (desktop present) renders a handoff button; LintCrux (absent)
    // renders an install link — never both for the same product.
    expect(html).toContain('data-command="edacrux.openInDesktop.wavecrux"');
    expect(html).toContain('href="https://lintcrux.app"');
    expect(html).not.toContain('data-command="edacrux.openInDesktop.lintcrux"');
    expect(html).toContain(content.proPitch);
    expect(html).toContain(content.proLink.url);
    for (const link of content.links) {
      expect(html).toContain(link.url);
    }
  });

  it('escapes HTML-significant characters in dynamic content', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux'],
      desktopPresence: [],
      copy: { desktopPitch: () => '<script>alert(1)</script> & "quotes" \'here\'' },
    });
    const html = renderCapabilitiesPanelHtml(content);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('wires the inline script to post a command message on a handoff button click', () => {
    const content = buildCapabilitiesPanelContent({
      tier: 'openCore',
      installedProducts: ['wavecrux'],
      desktopPresence: [{ product: 'wavecrux', present: true }],
    });
    const html = renderCapabilitiesPanelHtml(content);
    expect(html).toContain('acquireVsCodeApi');
    expect(html).toContain("kind: 'command'");
  });

  describe('capability notes', () => {
    it('renders nothing at all when a product declares none', () => {
      const html = renderCapabilitiesPanelHtml(
        buildCapabilitiesPanelContent({
          tier: 'openCore',
          installedProducts: ['wavecrux'],
          desktopPresence: [],
        }),
      );
      // The `<style>` block always names the class; what must be absent is
      // the element itself.
      expect(html).not.toContain('<li class="crux-notes">');
    });

    it('renders each note as its own list item under the product row', () => {
      const html = renderCapabilitiesPanelHtml(
        buildCapabilitiesPanelContent({
          tier: 'openCore',
          installedProducts: ['wavecrux'],
          desktopPresence: [],
          copy: { capabilityNotes: () => ['first boundary', 'second boundary'] },
        }),
      );
      expect(html).toContain('<li class="crux-notes">');
      expect(html).toContain('<li>first boundary</li>');
      expect(html).toContain('<li>second boundary</li>');
    });

    it('escapes notes like every other dynamic value', () => {
      const html = renderCapabilitiesPanelHtml(
        buildCapabilitiesPanelContent({
          tier: 'openCore',
          installedProducts: ['wavecrux'],
          desktopPresence: [],
          copy: { capabilityNotes: () => ['<img src=x onerror=alert(1)>'] },
        }),
      );
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x');
    });
  });
});
