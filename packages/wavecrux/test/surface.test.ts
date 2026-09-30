import { surface } from '@crux-vscode/host-core';
import { describe, expect, it, vi } from 'vitest';
import {
  WAVECRUX_HIGHLIGHT_CAPABILITY,
  WAVECRUX_HIGHLIGHT_ELEMENT_KINDS,
  createWaveCruxSurface,
  highlightResultFor,
  registerWaveCruxSurface,
} from '../src/surface';
import type {
  WebviewHighlightAnswer,
  WebviewHighlightTarget,
} from '../src/webview/highlight-bridge';

/** A target that answers whatever the test says, without a webview. */
function fakeTarget(answer: WebviewHighlightAnswer, ready = true): WebviewHighlightTarget {
  return {
    isReady: () => ready,
    request: () => Promise.resolve(answer),
  } as unknown as WebviewHighlightTarget;
}

const FROM = {
  peerId: 'lintcrux-1-2',
  productName: 'LintCrux',
  productVersion: '0.6.0',
  capabilities: [],
};

function highlightRequest(kind: string, path = 'top.cpu.alu.result'): surface.SurfaceHighlightRequest {
  return { element: { kind, path }, metadata: {}, from: FROM };
}

describe('the WaveCrux CXP surface', () => {
  it('advertises request_highlight, because a handler now routes it', () => {
    const registry = new surface.SurfaceRegistry();
    registerWaveCruxSurface(registry);
    expect(registry.capabilities()).toEqual([
      'request_highlight',
      'request_open_artifact',
      'request_open_source',
    ]);
  });

  it('does not claim the WCP capabilities nothing routes to the webview', () => {
    // `wavecrux.signal_value` and `wavecrux.cursor_time_fs` describe what a
    // peer answers over WCP. The webview genuinely can answer both, which
    // is what makes claiming them tempting and still wrong on this wire.
    const registry = new surface.SurfaceRegistry();
    registerWaveCruxSurface(registry);
    const capabilities = registry.capabilities();
    expect(capabilities).not.toContain(surface.KNOWN_PEER_CAPABILITIES.wavecruxSignalValue);
    expect(capabilities).not.toContain(surface.KNOWN_PEER_CAPABILITIES.wavecruxCursorTimeFs);
    // `request_open_artifact` used to be on this list, on the grounds that
    // no handler answered it. One does now — host-core's, resolving through
    // the shared workspace — so it is a *base* window capability, not
    // this surface's, and a bare window advertises it too.
    expect(surface.BASE_VSCODE_CAPABILITIES).toContain('request_open_artifact');
    expect(registry.surfaces[0]?.capabilities).not.toContain('request_open_artifact');
  });

  it('a window without WaveCrux advertises no request_highlight', () => {
    // The composition property the capability list exists for: a window is
    // one peer, and what it claims must follow what is installed in it.
    const bare = new surface.SurfaceRegistry();
    expect(bare.capabilities()).toEqual(['request_open_artifact', 'request_open_source']);
    bare.register({
      id: 'lintcrux',
      extensionId: 'ferrite-engineering.lintcrux',
      capabilities: ['lintcrux.diagnostics'],
    });
    expect(bare.capabilities()).not.toContain(WAVECRUX_HIGHLIGHT_CAPABILITY);
  });

  it('stops advertising it again when the registration is disposed', () => {
    const registry = new surface.SurfaceRegistry();
    const registration = registerWaveCruxSurface(registry);
    expect(registry.capabilities()).toContain(WAVECRUX_HIGHLIGHT_CAPABILITY);
    registration.dispose();
    expect(registry.has('wavecrux')).toBe(false);
    expect(registry.capabilities()).not.toContain(WAVECRUX_HIGHLIGHT_CAPABILITY);
  });

  it('names the extension id the marketplace listing uses', () => {
    const registered = createWaveCruxSurface({ target: () => undefined });
    expect(registered.id).toBe('wavecrux');
    expect(registered.extensionId).toBe('ferrite-engineering.wavecrux');
  });
});

describe('the highlight handler — which elements it claims', () => {
  it('declines a kind it does not own, so routing continues', async () => {
    // A `rule` element is LintCrux's. Refusing it would stop routing and
    // let this surface answer for another product's elements.
    const target = fakeTarget({ outcome: 'honored' });
    const registered = createWaveCruxSurface({ target: () => target });
    for (const kind of ['rule', 'test', 'breakpoint', 'source', 'quantum_flux']) {
      expect(await registered.highlight?.(highlightRequest(kind))).toEqual({
        outcome: 'declined',
      });
    }
  });

  it('claims every waveform element kind the app resolves', async () => {
    const target = fakeTarget({ outcome: 'honored' });
    const registered = createWaveCruxSurface({ target: () => target });
    for (const kind of WAVECRUX_HIGHLIGHT_ELEMENT_KINDS) {
      expect(await registered.highlight?.(highlightRequest(kind))).toEqual({
        outcome: 'honored',
      });
    }
  });

  it('relays the element and coordinate untouched (§6.1)', async () => {
    const request = vi.fn(() => Promise.resolve<WebviewHighlightAnswer>({ outcome: 'honored' }));
    const target = { isReady: () => true, request } as unknown as WebviewHighlightTarget;
    const registered = createWaveCruxSurface({ target: () => target });
    await registered.highlight?.({
      element: { kind: 'signal', path: 'top.cpu.alu.result' },
      coordinate: { streamId: 'riscv.rvfi.retire', sequenceIndex: 12, attributes: {} },
      metadata: { 'crux.design_id': 'designs/cdc' },
      from: FROM,
    });
    expect(request).toHaveBeenCalledWith({
      element: { kind: 'signal', path: 'top.cpu.alu.result' },
      coordinate: { streamId: 'riscv.rvfi.retire', sequenceIndex: 12, attributes: {} },
      metadata: { 'crux.design_id': 'designs/cdc' },
    });
  });
});

describe('the highlight handler — mapping the app’s answer onto the ack', () => {
  it('honored:true is honored, and routing stops there', () => {
    expect(highlightResultFor({ outcome: 'honored' })).toEqual({ outcome: 'honored' });
  });

  it('honored:false is refused with a reason — a normal §9.5 outcome', () => {
    const result = highlightResultFor({ outcome: 'refused' });
    expect(result.outcome).toBe('refused');
    expect(result).toHaveProperty('reason', 'the element is not in the loaded waveform');
  });

  it('a silent webview is refused, never declined', () => {
    // `declined` would fall through and the peer would be told "no
    // installed Crux surface handles this element" — which is false, and
    // unactionable, when a surface took the request and went quiet.
    const result = highlightResultFor({ outcome: 'timeout' });
    expect(result.outcome).toBe('refused');
    expect(result).toHaveProperty('reason', 'the waveform panel did not answer');
  });

  it('no waveform open is refused with the actionable reason', () => {
    const result = highlightResultFor({ outcome: 'unavailable' });
    expect(result.outcome).toBe('refused');
    expect(result).toHaveProperty('reason', 'no waveform is open in this window');
  });

  it('an error_response from the app is refused, not thrown', () => {
    const result = highlightResultFor({ outcome: 'error', detail: 'boom' });
    expect(result.outcome).toBe('refused');
    expect(result).toHaveProperty('reason', 'the waveform panel could not highlight it');
  });

  it('never echoes the app’s own words back to the peer (§11)', () => {
    // The Dart reasons interpolate the element path and kind the *peer*
    // sent, and this ack is rendered in the peer's UI.
    const result = highlightResultFor({
      outcome: 'refused',
      detail: 'no signal matching top.cpu.<script>alert(1)</script>',
    });
    expect(JSON.stringify(result)).not.toContain('script');
  });

  it('refuses when there is no panel at all, without posting anything', async () => {
    const registered = createWaveCruxSurface({ target: () => undefined });
    const result = await registered.highlight?.(highlightRequest('signal'));
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'no waveform is open in this window',
    });
  });

  it('refuses a panel that has not been handed a waveform yet', async () => {
    const registered = createWaveCruxSurface({
      target: () => fakeTarget({ outcome: 'honored' }, false),
    });
    const result = await registered.highlight?.(highlightRequest('signal'));
    expect(result).toMatchObject({ outcome: 'refused' });
  });
});
