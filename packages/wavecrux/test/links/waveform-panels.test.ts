import { describe, expect, it } from 'vitest';
import {
  placeWaveCruxLink,
  WaveformLoadWatch,
  WaveformPanelRegistry,
  waveformPanelKey,
  type WaveformLinkPanel,
} from '../../src/links/waveform-panels';
import { WebviewHighlightTarget, type WebviewHighlightAnswer } from '../../src/webview/highlight-bridge';
import type { HostBridgeFrame } from '../../src/webview/open-waveform';

/** A timer the test fires by hand. */
function manualSchedule(): { schedule: (run: () => void) => () => void; fire: () => void } {
  const pending = new Set<() => void>();
  return {
    schedule: (run) => {
      pending.add(run);
      return () => pending.delete(run);
    },
    fire: () => {
      for (const run of [...pending]) run();
    },
  };
}

const ACK = (honored: boolean): unknown => ({ kind: 'request_open_artifact_ack', payload: { in_reply_to: 'm', honored } });

describe('WaveformLoadWatch', () => {
  it('waits for the app to say the waveform is open, and claims only that answer', async () => {
    const watch = new WaveformLoadWatch();
    const waiting = watch.wait(1_000);
    expect(watch.accept({ kind: 'request_highlight_ack', payload: {} })).toBe(false);
    expect(watch.accept(ACK(true))).toBe(true);
    expect(await waiting).toBe('loaded');
    expect(await watch.wait(1_000)).toBe('loaded');
  });

  it('says failed, gone, and timed out', async () => {
    const failed = new WaveformLoadWatch();
    failed.accept(ACK(false));
    expect(await failed.wait()).toBe('failed');

    const gone = new WaveformLoadWatch();
    const waiting = gone.wait(1_000);
    gone.close();
    expect(await waiting).toBe('gone');

    const timer = manualSchedule();
    const slow = new WaveformLoadWatch(timer.schedule);
    const late = slow.wait(5);
    timer.fire();
    expect(await late).toBe('timeout');
  });

  it('waits again after a context release, until the bytes are acknowledged again', async () => {
    const watch = new WaveformLoadWatch();
    watch.accept(ACK(true));
    watch.reset();
    const again = watch.wait(1_000);
    watch.accept(ACK(true));
    expect(await again).toBe('loaded');
  });
});

describe('WaveformPanelRegistry', () => {
  const panel: WaveformLinkPanel = {
    highlights: { request: () => Promise.resolve({ outcome: 'honored' }) },
    load: { wait: () => Promise.resolve('loaded') },
  };

  it('hands a link the panel of its own file, once it exists', async () => {
    const registry = new WaveformPanelRegistry();
    const waiting = registry.waitFor('/w/b.vcd', 1_000);
    registry.adopt('/w/a.vcd', { ...panel });
    const release = registry.adopt('/w/b.vcd', panel);
    expect(await waiting).toBe(panel);
    release();
    const timer = manualSchedule();
    const later = new WaveformPanelRegistry(timer.schedule).waitFor('/w/b.vcd', 5);
    timer.fire();
    expect(await later).toBeUndefined();
  });

  it('keys a file the way VS Code compares documents', () => {
    expect(waveformPanelKey('/W/Dump.vcd', 'darwin')).toBe('/w/dump.vcd');
    expect(waveformPanelKey('/W/Dump.vcd', 'linux')).toBe('/W/Dump.vcd');
  });
});

describe('placeWaveCruxLink', () => {
  function panelAnswering(answer: WebviewHighlightAnswer, load: 'loaded' | 'failed' | 'timeout' = 'loaded') {
    const asked: unknown[] = [];
    const panel: WaveformLinkPanel = {
      highlights: {
        request: (request) => {
          asked.push(request);
          return Promise.resolve(answer);
        },
      },
      load: { wait: () => Promise.resolve(load) },
    };
    return { panel, asked };
  }

  it('asks the panel to select the signal at the link time, in both time keys', async () => {
    const { panel, asked } = panelAnswering({ outcome: 'honored' });
    expect(await placeWaveCruxLink({ signal: 'top.clk', time: '1500ns', timePs: 1_500_000 }, panel)).toEqual({
      kind: 'selected',
    });
    expect(asked).toEqual([
      { element: { kind: 'signal', path: 'top.clk' }, metadata: { 'crux.time_ps': 1_500_000 }, time: '1500ns' },
    ]);
  });

  it('sends a tick time as time alone', async () => {
    const { panel, asked } = panelAnswering({ outcome: 'honored' });
    await placeWaveCruxLink({ signal: 'top.clk', time: '42' }, panel);
    expect(asked).toEqual([{ element: { kind: 'signal', path: 'top.clk' }, metadata: {}, time: '42' }]);
  });

  it.each([
    [{ outcome: 'honored', detail: 'clamped' } as const, { kind: 'time-not-exact', detail: 'clamped' }],
    [{ outcome: 'refused' } as const, { kind: 'signal-not-found' }],
    [{ outcome: 'timeout' } as const, { kind: 'not-answered' }],
    [{ outcome: 'error' } as const, { kind: 'not-answered' }],
  ])('maps %j to %j', async (answer, placement) => {
    const { panel } = panelAnswering(answer);
    expect(await placeWaveCruxLink({ signal: 'top.clk', time: '5ns', timePs: 5000 }, panel)).toEqual(placement);
  });

  it('asks nothing before the waveform has loaded, or when it will not', async () => {
    const failed = panelAnswering({ outcome: 'honored' }, 'failed');
    expect(await placeWaveCruxLink({ signal: 'a' }, failed.panel)).toEqual({ kind: 'load-failed' });
    const slow = panelAnswering({ outcome: 'honored' }, 'timeout');
    expect(await placeWaveCruxLink({ signal: 'a' }, slow.panel)).toEqual({ kind: 'not-answered' });
    expect(await placeWaveCruxLink({ signal: 'a' }, undefined)).toEqual({ kind: 'not-answered' });
    expect([...failed.asked, ...slow.asked]).toEqual([]);
  });

  it('opens a file alone, and says a time with no signal places no cursor', async () => {
    expect(await placeWaveCruxLink({}, undefined)).toEqual({ kind: 'opened' });
    expect(await placeWaveCruxLink({ time: '5ns', timePs: 5000 }, undefined)).toEqual({ kind: 'time-needs-signal' });
  });

  it('crosses the bridge as a request_highlight carrying time', async () => {
    const posted: HostBridgeFrame[] = [];
    const target = new WebviewHighlightTarget({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
    });
    target.open();
    const answer = target.request({
      element: { kind: 'signal', path: 'top.clk' },
      metadata: { 'crux.time_ps': 5000 },
      time: '5ns',
    });
    await Promise.resolve();
    const frame = posted[0];
    expect(frame?.envelope.kind).toBe('request_highlight');
    expect(frame?.envelope.payload).toEqual({
      element: { kind: 'signal', path: 'top.clk' },
      metadata: { 'crux.time_ps': 5000 },
      time: '5ns',
    });
    target.accept({
      kind: 'request_highlight_ack',
      payload: { in_reply_to: frame?.envelope.message_id, honored: true },
    });
    expect(await answer).toEqual({ outcome: 'honored' });
  });
});
