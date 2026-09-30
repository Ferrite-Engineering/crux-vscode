/**
 * WaveCrux's content for host-core's status surface.
 *
 * The claim under test is not "a capabilities panel renders" — host-core's
 * own `status/panel-content.test.ts` and `status/panel-html.test.ts` own
 * that. It is that WaveCrux's copy reaches it *through the documented
 * extension point*, that it states the four capability boundaries, and that it
 * does not put WaveCrux's sentences under another product's name.
 */
import { describe, expect, it } from 'vitest';
import { status } from '@crux-vscode/host-core';
import {
  WAVECRUX_PRODUCT,
  waveCruxCapabilityCopy,
  waveCruxCapabilityNotes,
  waveCruxDesktopPitch,
  waveCruxHandoffLabel,
} from '../src/status/copy';

const NO_PEERS: readonly { product: 'wavecrux'; present: boolean }[] = [
  { product: 'wavecrux', present: false },
];
const PEER_PRESENT: readonly { product: 'wavecrux'; present: boolean }[] = [
  { product: 'wavecrux', present: true },
];

function build(presence: readonly { product: 'wavecrux'; present: boolean }[]) {
  return status.buildCapabilitiesPanelContent({
    tier: 'openCore',
    installedProducts: [WAVECRUX_PRODUCT],
    desktopPresence: presence,
    copy: waveCruxCapabilityCopy,
  });
}

describe('waveCruxCapabilityCopy', () => {
  it('replaces host-core’s generic pitch for the WaveCrux row', () => {
    const row = build(NO_PEERS).productRows[0];
    expect(row?.headline).toBe(waveCruxDesktopPitch());
    // Not the generic default — that is the whole point of the seam.
    expect(row?.headline).not.toBe(status.defaultDesktopPitch('wavecrux'));
  });

  it('leaves the other three products on host-core’s defaults', () => {
    // `ProductCapabilityCopy` is one hook shared by every row, so a guard on
    // the product is the only thing keeping WaveCrux's sentences off
    // LintCrux's name.
    for (const product of ['lintcrux', 'simcrux', 'netcrux'] as const) {
      expect(waveCruxCapabilityCopy.desktopPitch?.(product)).toBe(
        status.defaultDesktopPitch(product),
      );
      expect(waveCruxCapabilityCopy.handoffLabel?.(product)).toBe(
        status.defaultHandoffLabel(product),
      );
      expect(waveCruxCapabilityCopy.capabilityNotes?.(product)).toEqual([]);
    }
  });

  it('switches to a handoff once a desktop peer is present', () => {
    const row = build(PEER_PRESENT).productRows[0];
    expect(row?.desktopPresent).toBe(true);
    expect(row?.action.kind).toBe('handoff-command');
    if (row?.action.kind === 'handoff-command') {
      expect(row.action.label).toBe(waveCruxHandoffLabel());
      expect(row.action.commandId).toBe('edacrux.openInDesktop.wavecrux');
    }
    // "Nothing makes a funnel feel more mechanical than being sold something
    // already installed."
    expect(row?.headline).not.toBe(waveCruxDesktopPitch());
  });

  it('pitches the install when no peer is running', () => {
    const row = build(NO_PEERS).productRows[0];
    expect(row?.action.kind).toBe('install-link');
    if (row?.action.kind === 'install-link') {
      expect(row.action.url).toBe('https://wavecrux.app');
    }
  });
});

describe('the capability boundaries', () => {
  const notes = waveCruxCapabilityNotes();

  it('covers all four boundaries', () => {
    expect(notes).toHaveLength(4);
    const joined = notes.join('\n');
    // Large-file parse time, and *why*: single-threaded WASM, no
    // SharedArrayBuffer, versus a multi-threaded desktop parse.
    expect(joined).toMatch(/SharedArrayBuffer/);
    expect(joined).toMatch(/single-threaded/);
    // The Stage panel.
    expect(joined).toMatch(/Stage panel/);
    // Interactive VCD.
    expect(joined).toMatch(/Interactive VCD/);
    expect(joined).toMatch(/stdin|named pipe/);
    // RTL source annotation.
    expect(joined).toMatch(/RTL source annotation/);
    expect(joined).toMatch(/stems file/);
  });

  it('says what to do, not merely what is missing', () => {
    // The fsdbWebUnsupportedMessage shape: what, why, and what to do. A note
    // that never names the desktop app has stopped at "why".
    for (const note of notes) {
      expect(note.length).toBeGreaterThan(80);
      expect(note).toMatch(/desktop app|WaveCrux Desktop|this panel/);
    }
  });

  it('does not wheedle', () => {
    // Stated plainly, with no wheedling: no countdowns, no urgency, no trial framing.
    for (const note of [...notes, waveCruxDesktopPitch()]) {
      expect(note).not.toMatch(/upgrade now|free trial|limited time|hurry|!/i);
    }
  });

  it('reaches the panel rows whether or not the desktop peer is present', () => {
    // A boundary is a fact about the editor panel, not advertising. Someone
    // who already has the desktop app is exactly the reader for whom "this is
    // why that tab is empty in here" is useful.
    expect(build(NO_PEERS).productRows[0]?.notes).toEqual(notes);
    expect(build(PEER_PRESENT).productRows[0]?.notes).toEqual(notes);
  });

  it('renders into the panel HTML, escaped', () => {
    const html = status.renderCapabilitiesPanelHtml(build(NO_PEERS));
    for (const note of notes) {
      // The notes use typographic punctuation the escaper leaves alone, and
      // no `<`/`&`, so each should appear verbatim.
      expect(html).toContain(note.replace(/'/g, '&#39;'));
    }
    expect(html).toContain('crux-notes');
  });
});
