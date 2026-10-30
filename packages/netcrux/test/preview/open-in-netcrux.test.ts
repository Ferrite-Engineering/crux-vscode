import { describe, expect, it } from 'vitest';
import type { desktopDetect } from '@crux-vscode/host-core';
import { openInNetCrux, type OpenInNetCruxDeps } from '../../src/preview/open-in-netcrux';

type HandoffOutcome = desktopDetect.ArtifactHandoffOutcome;

interface Rig {
  readonly deps: OpenInNetCruxDeps;
  readonly calls: string[];
  readonly messages: string[];
}

/** A rig with a running peer or not, an installed app or not, and the handoff's outcome. */
function rig(options: {
  peer: boolean;
  installed?: string;
  outcome?: HandoffOutcome;
  /** When the handoff falls back, the outcome that follows the fallback. */
  fallBack?: boolean;
  launchFails?: boolean;
}): Rig {
  const calls: string[] = [];
  const messages: string[] = [];
  const deps: OpenInNetCruxDeps = {
    peerRunning: () => Promise.resolve(options.peer),
    locateInstalled: () => options.installed,
    launch: (installed, fsPath) => {
      calls.push(`launch ${installed} ${fsPath}`);
      return options.launchFails === true ? Promise.reject(new Error('spawn failed')) : Promise.resolve();
    },
    offerInstall: () => {
      calls.push('offerInstall');
      return Promise.resolve();
    },
    showMessage: (message) => {
      messages.push(message);
    },
    launchedMessage: () => 'launched',
    log: () => {},
    handOff: async (fsPath, fallback, showMessage) => {
      calls.push(`handOff ${fsPath}`);
      if (options.fallBack === true) {
        await fallback(fsPath);
        // The shared handoff words its message for the OS fallback it
        // normally makes; the rig has it say so, as it does.
        showMessage('handed to your default application');
        return { kind: 'launched-externally', path: fsPath, why: 'no-answer' };
      }
      showMessage('opened by the peer');
      return options.outcome ?? { kind: 'opened-in-peer', designId: 'd', path: fsPath };
    },
  };
  return { deps, calls, messages };
}

describe('openInNetCrux', () => {
  it('hands the netlist to a running NetCrux over the protocol', async () => {
    const { deps, calls, messages } = rig({ peer: true, installed: '/Applications/NetCrux.app' });
    expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'opened-in-running-app' });
    expect(calls).toEqual(['handOff /w/top.json']);
    expect(messages).toEqual(['opened by the peer']);
  });

  it('reports a running NetCrux that said no, without launching a second one', async () => {
    const { deps, calls } = rig({
      peer: true,
      installed: '/Applications/NetCrux.app',
      outcome: { kind: 'refused-by-peer' },
    });
    expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'refused-by-running-app' });
    expect(calls).toEqual(['handOff /w/top.json']);
  });

  it('treats a refused handshake the same way', async () => {
    const { deps } = rig({ peer: true, outcome: { kind: 'refused-handshake' } });
    expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'refused-by-running-app' });
  });

  it('launches the installed app when none is running, never the OS opener', async () => {
    const { deps, calls, messages } = rig({ peer: false, installed: '/Applications/NetCrux.app' });
    expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'launched' });
    expect(calls).toEqual(['launch /Applications/NetCrux.app /w/top.json']);
    expect(messages).toEqual(['launched']);
  });

  it('points to the download page when NetCrux is not installed', async () => {
    const { deps, calls } = rig({ peer: false });
    expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'not-installed' });
    expect(calls).toEqual(['offerInstall']);
  });

  it('says a launch that could not start is a failure', async () => {
    const { deps } = rig({ peer: false, installed: '/x/netcrux', launchFails: true });
    const outcome = await openInNetCrux('/w/top.json', deps);
    expect(outcome.kind).toBe('launch-failed');
  });

  describe('when a running NetCrux does not answer', () => {
    it('launches the installed app, in its own words and not the handoff’s', async () => {
      const { deps, calls, messages } = rig({
        peer: true,
        installed: '/Applications/NetCrux.app',
        fallBack: true,
      });
      expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'launched' });
      expect(calls).toEqual([
        'handOff /w/top.json',
        'launch /Applications/NetCrux.app /w/top.json',
      ]);
      // The shared sentence about "your default application" would be wrong
      // here: the file went to NetCrux, not to whatever owns JSON.
      expect(messages).toEqual(['launched']);
    });

    it('offers the download when nothing is installed to launch', async () => {
      const { deps, calls, messages } = rig({ peer: true, fallBack: true });
      expect(await openInNetCrux('/w/top.json', deps)).toEqual({ kind: 'not-installed' });
      expect(calls).toEqual(['handOff /w/top.json', 'offerInstall']);
      expect(messages).toEqual([]);
    });
  });

  it('reports a handoff that failed outright', async () => {
    const { deps } = rig({ peer: true, outcome: { kind: 'failed', error: new Error('x') } });
    expect((await openInNetCrux('/w/top.json', deps)).kind).toBe('launch-failed');
  });
});
