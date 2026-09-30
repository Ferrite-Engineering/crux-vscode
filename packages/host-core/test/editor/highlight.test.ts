import { describe, expect, it } from 'vitest';
import { CxpMessageKind, type RequestHighlight } from '../../src/cxp/messages';
import { routeRequestHighlight } from '../../src/editor/highlight';
import {
  SurfaceRegistry,
  type CruxSurface,
  type SurfaceHighlightRequest,
  type SurfaceHighlightResult,
} from '../../src/surface/index';
import { peer } from './harness';

const FROM = peer('wavecrux-4242-1784742061000', 'wavecrux');

function highlightRequest(kind: string, path = 'top.cpu.alu.result'): RequestHighlight {
  return {
    kind: CxpMessageKind.requestHighlight,
    element: { kind, path },
    metadata: {},
  };
}

function surface(
  id: string,
  handler?: (request: SurfaceHighlightRequest) => SurfaceHighlightResult | undefined,
): CruxSurface {
  return {
    id,
    extensionId: `ferrite-engineering.${id}`,
    capabilities: [],
    ...(handler !== undefined ? { highlight: handler } : {}),
  };
}

describe('routeRequestHighlight — routing to a surface', () => {
  it('honours through the first surface that claims the element', async () => {
    const registry = new SurfaceRegistry();
    const seen: string[] = [];
    registry.register(
      surface('lintcrux', (request) => {
        seen.push('lintcrux');
        return request.element.kind === 'rule' ? { outcome: 'honored' } : { outcome: 'declined' };
      }),
    );
    registry.register(
      surface('wavecrux', (request) => {
        seen.push('wavecrux');
        return request.element.kind === 'signal'
          ? { outcome: 'honored' }
          : { outcome: 'declined' };
      }),
    );

    const ack = await routeRequestHighlight(highlightRequest('signal'), FROM, { registry });
    expect(ack).toEqual({ honored: true });
    // LintCrux was offered it first and declined, so WaveCrux got a turn.
    expect(seen).toEqual(['lintcrux', 'wavecrux']);
  });

  it('stops at the first surface that honours', async () => {
    const registry = new SurfaceRegistry();
    const seen: string[] = [];
    registry.register(
      surface('wavecrux', () => {
        seen.push('wavecrux');
        return { outcome: 'honored' };
      }),
    );
    registry.register(
      surface('netcrux', () => {
        seen.push('netcrux');
        return { outcome: 'honored' };
      }),
    );
    await routeRequestHighlight(highlightRequest('signal'), FROM, { registry });
    expect(seen).toEqual(['wavecrux']);
  });

  it('carries a partial-success reason through on an honored ack (§9.4)', async () => {
    const registry = new SurfaceRegistry();
    registry.register(
      surface('wavecrux', () => ({
        outcome: 'honored',
        reason: 'coordinate not resolvable; landed at the element',
      })),
    );
    expect(await routeRequestHighlight(highlightRequest('signal'), FROM, { registry })).toEqual({
      honored: true,
      reason: 'coordinate not resolvable; landed at the element',
    });
  });

  it('passes an unrecognised element kind through intact (§6.1)', async () => {
    const registry = new SurfaceRegistry();
    let received: SurfaceHighlightRequest | undefined;
    registry.register(
      surface('wavecrux', (request) => {
        received = request;
        return { outcome: 'honored' };
      }),
    );
    await routeRequestHighlight(highlightRequest('quantum_gate', 'top.q[3]'), FROM, {
      registry,
    });
    // Not normalised, not lowercased, not dropped — a surface built against
    // a later vocabulary can honour what host-core cannot classify.
    expect(received?.element).toEqual({ kind: 'quantum_gate', path: 'top.q[3]' });
  });

  it('forwards the coordinate and metadata, and names the sender', async () => {
    const registry = new SurfaceRegistry();
    let received: SurfaceHighlightRequest | undefined;
    registry.register(
      surface('wavecrux', (request) => {
        received = request;
        return { outcome: 'honored' };
      }),
    );
    await routeRequestHighlight(
      {
        kind: CxpMessageKind.requestHighlight,
        element: { kind: 'signal', path: 'top.a' },
        coordinate: { streamId: 'riscv.rvfi.retire', sequenceIndex: 12, attributes: {} },
        metadata: { 'crux.design_id': 'design-1' },
      },
      FROM,
      { registry },
    );
    expect(received?.coordinate).toEqual({ streamId: 'riscv.rvfi.retire', sequenceIndex: 12, attributes: {} });
    expect(received?.metadata).toEqual({ 'crux.design_id': 'design-1' });
    expect(received?.from.peerId).toBe(FROM.peerId);
  });
});

describe('routeRequestHighlight — honored:false', () => {
  it('acks false when no surface is installed at all', async () => {
    const ack = await routeRequestHighlight(highlightRequest('signal'), FROM, {
      registry: new SurfaceRegistry(),
    });
    expect(ack).toEqual({
      honored: false,
      reason: 'no Crux surface is installed in this window',
    });
  });

  it('acks false when surfaces exist but none offer a highlight handler', async () => {
    const registry = new SurfaceRegistry();
    registry.register(surface('simcrux'));
    expect(await routeRequestHighlight(highlightRequest('signal'), FROM, { registry })).toEqual({
      honored: false,
      reason: 'no Crux surface is installed in this window',
    });
  });

  it('acks false with the element reason when every handler declines', async () => {
    const registry = new SurfaceRegistry();
    registry.register(surface('lintcrux', () => ({ outcome: 'declined' })));
    registry.register(surface('wavecrux', () => undefined));
    expect(await routeRequestHighlight(highlightRequest('breakpoint'), FROM, { registry })).toEqual(
      { honored: false, reason: 'no installed Crux surface handles this element' },
    );
  });

  it('stops at a surface that claims the element and refuses it', async () => {
    // WaveCrux has the waveform loaded and the signal simply is not in it.
    // Letting a later surface answer would produce a misleading ack.
    const registry = new SurfaceRegistry();
    const seen: string[] = [];
    registry.register(
      surface('wavecrux', () => {
        seen.push('wavecrux');
        return { outcome: 'refused', reason: 'signal not present in the loaded waveform' };
      }),
    );
    registry.register(
      surface('netcrux', () => {
        seen.push('netcrux');
        return { outcome: 'honored' };
      }),
    );
    expect(await routeRequestHighlight(highlightRequest('signal'), FROM, { registry })).toEqual({
      honored: false,
      reason: 'signal not present in the loaded waveform',
    });
    expect(seen).toEqual(['wavecrux']);
  });

  it('treats a throwing surface as a decline so the next one still gets a turn', async () => {
    const registry = new SurfaceRegistry();
    const failures: string[] = [];
    registry.register(
      surface('lintcrux', () => {
        throw new Error('boom');
      }),
    );
    registry.register(surface('wavecrux', () => ({ outcome: 'honored' })));
    const ack = await routeRequestHighlight(highlightRequest('signal'), FROM, {
      registry,
      onSurfaceError: (id) => failures.push(id),
    });
    expect(ack).toEqual({ honored: true });
    expect(failures).toEqual(['lintcrux']);
  });

  it('acks false rather than throwing when the only surface throws', async () => {
    const registry = new SurfaceRegistry();
    registry.register(
      surface('lintcrux', () => {
        throw new Error('boom');
      }),
    );
    const ack = await routeRequestHighlight(highlightRequest('signal'), FROM, {
      registry,
      onSurfaceError: () => undefined,
    });
    expect(ack.honored).toBe(false);
  });

  it('never echoes the peer-supplied element path or kind in the reason', async () => {
    const registry = new SurfaceRegistry();
    registry.register(surface('lintcrux', () => ({ outcome: 'declined' })));
    const ack = await routeRequestHighlight(
      highlightRequest('<script>', '<img src=x onerror=alert(1)>'),
      FROM,
      { registry },
    );
    expect(ack.reason).not.toContain('<script>');
    expect(ack.reason).not.toContain('<img');
  });
});

describe('routeRequestHighlight — an async surface', () => {
  it('awaits a promise-returning handler', async () => {
    const registry = new SurfaceRegistry();
    registry.register({
      id: 'wavecrux',
      extensionId: 'ferrite-engineering.wavecrux',
      capabilities: [],
      highlight: () =>
        new Promise<SurfaceHighlightResult>((resolve) => {
          setTimeout(() => resolve({ outcome: 'honored' }), 1);
        }),
    });
    expect(await routeRequestHighlight(highlightRequest('signal'), FROM, { registry })).toEqual({
      honored: true,
    });
  });
});
