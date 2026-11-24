/**
 * A `netcrux://` link to a netlist in the schematic preview: the preview is
 * found by its file, asked to select only once its netlist has loaded, and
 * the viewer's answer becomes what the user is told.
 *
 * The viewer's side of the exchange is NetCrux's `host_bridge_messages.dart`
 * (`select`, `select_result`); the not-found sentences are the desktop app's
 * own (`linkCellNotFound`: "Opened {fileName}, but it has no cell named
 * {cell}.", `linkNetNotFound` likewise, in NetCrux's `lib/l10n/app_en.arb`).
 */
import { describe, expect, it } from 'vitest';
import { placementMessage } from '../../src/links/register';
import {
  NetlistLoadWatch,
  NetlistPanelRegistry,
  NetlistSelector,
  netlistPanelKey,
  type NetlistLinkPanel,
} from '../../src/links/netlist-panels';
import { placeNetCruxLinkInPreview } from '../../src/links/place';
import { parseWebviewMessage, type SelectFrame } from '../../src/preview/messages';

/** A schedule whose timers fire only when the test says so. */
function manualSchedule(): {
  schedule: (run: () => void, delayMs: number) => () => void;
  fireAll: () => void;
} {
  const timers = new Set<() => void>();
  return {
    schedule: (run) => {
      timers.add(run);
      return () => timers.delete(run);
    },
    fireAll: () => {
      for (const run of [...timers]) {
        timers.delete(run);
        run();
      }
    },
  };
}

/** A preview whose viewer is the test: it sees each posted frame and answers by hand. */
function preview(options: { delivered?: boolean } = {}): {
  panel: NetlistLinkPanel;
  load: NetlistLoadWatch;
  selector: NetlistSelector;
  posted: SelectFrame[];
  /** The viewer's raw `select_result` for the latest frame, through the real parser. */
  answer: (fields: Record<string, unknown>) => void;
} {
  const posted: SelectFrame[] = [];
  const load = new NetlistLoadWatch();
  const selector = new NetlistSelector((frame) => {
    posted.push(frame);
    return Promise.resolve(options.delivered ?? true);
  });
  return {
    panel: { load, selector },
    load,
    selector,
    posted,
    answer: (fields) => {
      const message = parseWebviewMessage({
        type: 'crux.netcrux',
        protocol: 1,
        kind: 'select_result',
        id: posted.at(-1)?.id,
        ...fields,
      });
      if (message?.type === 'select-result') selector.accept(message);
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('a link to a netlist in the preview', () => {
  it('posts the select frame only after the preview reports loaded', async () => {
    const view = preview();
    const placed = placeNetCruxLinkInPreview({ kind: 'cell', name: 'top.u_cpu.pc_reg' }, view.panel);
    view.load.status('loading');
    await flush();
    expect(view.posted).toEqual([]);

    view.load.status('loaded');
    await flush();
    expect(view.posted).toEqual([
      { type: 'crux.netcrux', protocol: 1, kind: 'select', element: 'cell', name: 'top.u_cpu.pc_reg', id: 1 },
    ]);
    view.answer({ outcome: 'selected' });
    expect(await placed).toEqual({ kind: 'selected', coneView: false });
  });

  it('maps not_found to the desktop wording for a cell, and for a net', async () => {
    const cell = preview();
    cell.load.status('loaded');
    const placedCell = placeNetCruxLinkInPreview({ kind: 'cell', name: 'top.nope' }, cell.panel);
    await flush();
    cell.answer({ outcome: 'not_found' });
    const cellPlacement = await placedCell;
    expect(cellPlacement).toEqual({ kind: 'element-not-found' });
    expect(placementMessage(cellPlacement, 'top.json', { kind: 'cell', name: 'top.nope' })).toBe(
      'Opened top.json, but it has no cell named top.nope.',
    );

    const net = preview();
    net.load.status('loaded');
    const placedNet = placeNetCruxLinkInPreview({ kind: 'net', name: 'top.u_cpu.nope' }, net.panel);
    await flush();
    expect(net.posted[0]?.element).toBe('net');
    net.answer({ outcome: 'not_found' });
    const netPlacement = await placedNet;
    expect(placementMessage(netPlacement, 'top.json', { kind: 'net', name: 'top.u_cpu.nope' })).toBe(
      'Opened top.json, but it has no net named top.u_cpu.nope.',
    );
  });

  it('says nothing for a selection, and carries a cone view through', async () => {
    const view = preview();
    view.load.status('loaded');
    const placed = placeNetCruxLinkInPreview({ kind: 'cell', name: 'top.dma_reg' }, view.panel);
    await flush();
    view.answer({ outcome: 'selected', coneView: true });
    const placement = await placed;
    expect(placement).toEqual({ kind: 'selected', coneView: true });
    expect(placementMessage(placement, 'top.json', { kind: 'cell', name: 'top.dma_reg' })).toBeUndefined();
  });

  it('a netlist that did not load is said as the desktop says it, and nothing is asked', async () => {
    const notice = preview();
    notice.load.markFailed();
    const placement = await placeNetCruxLinkInPreview({ kind: 'cell', name: 'top.u' }, notice.panel);
    expect(placement).toEqual({ kind: 'load-failed' });
    expect(notice.posted).toEqual([]);
    expect(placementMessage(placement, 'top.json', { kind: 'cell', name: 'top.u' })).toBe(
      'NetCrux could not read top.json. The tab shows why.',
    );

    const viewerFailed = preview();
    viewerFailed.load.status('failed');
    expect(await placeNetCruxLinkInPreview({ kind: 'net', name: 'y' }, viewerFailed.panel)).toEqual({
      kind: 'load-failed',
    });

    const noDesign = preview();
    noDesign.load.status('loaded');
    const placed = placeNetCruxLinkInPreview({ kind: 'net', name: 'y' }, noDesign.panel);
    await flush();
    noDesign.answer({ outcome: 'no_design' });
    expect(await placed).toEqual({ kind: 'load-failed' });
  });

  it('a link with no element asks nothing; no preview is not answered', async () => {
    const view = preview();
    expect(await placeNetCruxLinkInPreview({}, view.panel)).toEqual({ kind: 'opened' });
    expect(await placeNetCruxLinkInPreview({ kind: 'cell', name: 'a' }, undefined)).toEqual({ kind: 'not-answered' });
    expect(view.posted).toEqual([]);
    expect(placementMessage({ kind: 'not-answered' }, 'top.json', { kind: 'cell', name: 'a' })).toBe(
      'Opened top.json, but the schematic preview did not select a.',
    );
  });
});

describe('NetlistSelector', () => {
  it('numbers each request and matches an answer to its own', async () => {
    const view = preview();
    const first = view.selector.select({ element: 'cell', name: 'a' });
    const second = view.selector.select({ element: 'net', name: 'b' });
    await flush();
    expect(view.posted.map((frame) => frame.id)).toEqual([1, 2]);
    // Answered out of order, and once with an id nobody asked for.
    view.selector.accept({ id: 9, outcome: 'selected', coneView: false });
    view.selector.accept({ id: 2, outcome: 'not-found', coneView: false });
    view.selector.accept({ id: 1, outcome: 'selected', coneView: false });
    expect(await first).toEqual({ outcome: 'selected', coneView: false });
    expect(await second).toEqual({ outcome: 'not-found' });
  });

  it('is unavailable when the frame is not delivered, on timeout, and once closed', async () => {
    const undelivered = preview({ delivered: false });
    expect(await undelivered.selector.select({ element: 'cell', name: 'a' })).toEqual({ outcome: 'unavailable' });

    const clock = manualSchedule();
    const slow = new NetlistSelector(() => Promise.resolve(true), clock.schedule);
    const waiting = slow.select({ element: 'cell', name: 'a' });
    await flush();
    clock.fireAll();
    expect(await waiting).toEqual({ outcome: 'unavailable' });

    const view = preview();
    const pending = view.selector.select({ element: 'cell', name: 'a' });
    await flush();
    view.selector.close();
    expect(await pending).toEqual({ outcome: 'unavailable' });
    expect(await view.selector.select({ element: 'cell', name: 'b' })).toEqual({ outcome: 'unavailable' });
  });
});

describe('NetlistLoadWatch', () => {
  it('waits through loading, follows a reload, and ends gone when the panel closes', async () => {
    const clock = manualSchedule();
    const load = new NetlistLoadWatch(clock.schedule);
    const first = load.wait();
    load.status('loading');
    load.status('loaded');
    expect(await first).toBe('loaded');
    // The file changed on disk and is being read again.
    load.status('loading');
    const second = load.wait();
    load.status('failed');
    expect(await second).toBe('failed');

    const timedOut = new NetlistLoadWatch(clock.schedule);
    const waiting = timedOut.wait();
    clock.fireAll();
    expect(await waiting).toBe('timeout');

    load.close();
    load.status('loaded');
    expect(await load.wait()).toBe('gone');
  });
});

describe('NetlistPanelRegistry', () => {
  it('hands a waiting link its own preview, by file, and forgets a closed one', async () => {
    const clock = manualSchedule();
    const registry = new NetlistPanelRegistry(clock.schedule);
    const key = netlistPanelKey('/w/Top.json', 'darwin');
    expect(key).toBe(netlistPanelKey('/w/top.json', 'darwin'));
    expect(netlistPanelKey('/w/Top.json', 'linux')).not.toBe(netlistPanelKey('/w/top.json', 'linux'));

    const waiting = registry.waitFor(key);
    const view = preview();
    const release = registry.adopt(key, view.panel);
    expect(await waiting).toBe(view.panel);
    expect(await registry.waitFor(key)).toBe(view.panel);

    release();
    const gone = registry.waitFor(key);
    clock.fireAll();
    expect(await gone).toBeUndefined();
  });
});
