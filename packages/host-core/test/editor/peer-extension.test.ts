import { describe, expect, it, vi } from 'vitest';
import {
  CRUX_EXTENSION_PUBLISHER,
  WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE,
  cruxExtensionId,
  cruxExtensionMarketplaceUri,
  openInPeerExtensionEditor,
} from '../../src/editor/peer-extension';
import { CRUX_DESKTOP_PRODUCTS } from '../../src/desktop-detect';

describe('cruxExtensionId', () => {
  it('composes publisher and product', () => {
    expect(cruxExtensionId('wavecrux')).toBe('ferrite-engineering.wavecrux');
    expect(cruxExtensionId('simcrux')).toBe('ferrite-engineering.simcrux');
  });

  it('is defined for all four products, with one publisher', () => {
    for (const product of CRUX_DESKTOP_PRODUCTS) {
      expect(cruxExtensionId(product)).toBe(`${CRUX_EXTENSION_PUBLISHER}.${product}`);
    }
  });
});

describe('cruxExtensionMarketplaceUri', () => {
  it('uses VSCode’s own scheme, which resolves inside the window', () => {
    // Deliberately not https://<product>.app: when the missing thing is an
    // extension, sending the user to a desktop download answers a question
    // they did not ask.
    expect(cruxExtensionMarketplaceUri('wavecrux')).toBe(
      'vscode:extension/ferrite-engineering.wavecrux',
    );
  });
});

describe('WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE', () => {
  it('is the viewType WaveCrux’s manifest contributes', () => {
    // One definition. SimCrux may not import the WaveCrux package, so the
    // alternative was a second spelling that a rename would break
    // silently.
    expect(WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE).toBe('wavecrux.waveform');
  });
});

describe('openInPeerExtensionEditor', () => {
  it('opens when the sibling extension is installed', async () => {
    const openWith = vi.fn(() => Promise.resolve());
    const outcome = await openInPeerExtensionEditor('wavecrux', 'wavecrux.waveform', {
      isExtensionInstalled: () => true,
      openWith,
    });
    expect(outcome).toEqual({ kind: 'opened', viewType: 'wavecrux.waveform' });
    expect(openWith).toHaveBeenCalledWith('wavecrux.waveform');
  });

  it('reports not-installed as a value, without attempting the open', async () => {
    // `vscode.openWith` against an unregistered viewType rejects rather
    // than falling back, and a rejected executeCommand surfaces as an
    // unexplained failure. Every product ships standalone, so this is an
    // ordinary state and the caller owns the words.
    const openWith = vi.fn(() => Promise.resolve());
    const outcome = await openInPeerExtensionEditor('wavecrux', 'wavecrux.waveform', {
      isExtensionInstalled: () => false,
      openWith,
    });
    expect(outcome).toEqual({ kind: 'not-installed', product: 'wavecrux' });
    expect(openWith).not.toHaveBeenCalled();
  });

  it('asks about the composed extension id', async () => {
    const isExtensionInstalled = vi.fn(() => true);
    await openInPeerExtensionEditor('lintcrux', 'x.y', {
      isExtensionInstalled,
      openWith: () => Promise.resolve(),
    });
    expect(isExtensionInstalled).toHaveBeenCalledWith('ferrite-engineering.lintcrux');
  });

  it('never throws — a rejected open becomes a failed outcome', async () => {
    const outcome = await openInPeerExtensionEditor('wavecrux', 'wavecrux.waveform', {
      isExtensionInstalled: () => true,
      openWith: () => Promise.reject(new Error('no provider')),
    });
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(outcome).toMatchObject({ reason: expect.stringContaining('no provider') as unknown });
  });
});
