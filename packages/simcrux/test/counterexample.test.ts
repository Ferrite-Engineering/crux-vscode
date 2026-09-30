import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { editor } from '@crux-vscode/host-core';
import {
  getWaveCruxLabel,
  openCounterexampleInWaveCrux,
  type CounterexampleHandoffDeps,
} from '../src/counterexample/handoff';
import { parseSimResults } from '../src/run/results';
import { readSimProject } from '../src/run/project';
import { buildSimTestTree } from '../src/tests/tree';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TRACE = '/work/riscv-formal-demo/insn_sub_ch0/engine_0/trace.vcd';

interface Recorder {
  readonly deps: CounterexampleHandoffDeps;
  readonly opened: Array<{ waveformPath: string; viewType: string }>;
  readonly messages: string[];
  readonly urls: string[];
}

function recorder(overrides: Partial<CounterexampleHandoffDeps> = {}): Recorder {
  const opened: Array<{ waveformPath: string; viewType: string }> = [];
  const messages: string[] = [];
  const urls: string[] = [];
  const deps: CounterexampleHandoffDeps = {
    waveformPath: TRACE,
    pathExists: () => true,
    isExtensionInstalled: () => true,
    openWith: (waveformPath, viewType) => {
      opened.push({ waveformPath, viewType });
      return Promise.resolve();
    },
    openUrl: (url) => {
      urls.push(url);
      return Promise.resolve();
    },
    showMessage: (message) => {
      messages.push(message);
      return Promise.resolve(undefined);
    },
    ...overrides,
  };
  return { deps, opened, messages, urls };
}

describe('openCounterexampleInWaveCrux — the success path', () => {
  it('opens the recorded trace with WaveCrux’s registered viewType', async () => {
    const { deps, opened } = recorder();
    const outcome = await openCounterexampleInWaveCrux(deps);
    expect(outcome).toEqual({ kind: 'opened', waveformPath: TRACE });
    // The two things the command actually resolves to. This is as close to
    // "the waveform opened beside it" as a headless test can assert; what
    // remains unproven without a GUI is only that VSCode honours the
    // viewType and the column, both of which are its own contract.
    expect(opened).toEqual([{ waveformPath: TRACE, viewType: 'wavecrux.waveform' }]);
  });

  it('asks for the same viewType WaveCrux’s manifest registers', () => {
    // One definition, in host-core, precisely so a rename cannot break
    // this handoff silently.
    expect(editor.WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE).toBe('wavecrux.waveform');
  });

  it('checks for the WaveCrux extension by its composed id, not a spelled literal', async () => {
    const isExtensionInstalled = vi.fn(() => true);
    await openCounterexampleInWaveCrux(recorder({ isExtensionInstalled }).deps);
    expect(isExtensionInstalled).toHaveBeenCalledWith('ferrite-engineering.wavecrux');
    expect(editor.cruxExtensionId('wavecrux')).toBe('ferrite-engineering.wavecrux');
  });

  it('says nothing to the user when it worked', async () => {
    const { deps, messages } = recorder();
    await openCounterexampleInWaveCrux(deps);
    expect(messages).toEqual([]);
  });
});

describe('openCounterexampleInWaveCrux — when WaveCrux is not installed', () => {
  it('states the boundary rather than failing a command', async () => {
    const { deps, messages, opened } = recorder({ isExtensionInstalled: () => false });
    const outcome = await openCounterexampleInWaveCrux(deps);
    expect(outcome).toEqual({ kind: 'wavecrux-absent', followed: false });
    expect(opened).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('WaveCrux extension is not installed');
  });

  it('offers the extension page, not the desktop download', async () => {
    // The missing thing is an extension; sending the user to
    // https://wavecrux.app would answer a question they did not ask.
    const { deps, urls } = recorder({
      isExtensionInstalled: () => false,
      showMessage: () => Promise.resolve(getWaveCruxLabel()),
    });
    const outcome = await openCounterexampleInWaveCrux(deps);
    expect(outcome).toEqual({ kind: 'wavecrux-absent', followed: true });
    expect(urls).toEqual(['vscode:extension/ferrite-engineering.wavecrux']);
  });

  it('records that the link was not taken when the message was dismissed', async () => {
    const { deps, urls } = recorder({ isExtensionInstalled: () => false });
    expect(await openCounterexampleInWaveCrux(deps)).toEqual({
      kind: 'wavecrux-absent',
      followed: false,
    });
    expect(urls).toEqual([]);
  });
});

describe('openCounterexampleInWaveCrux — when the trace is not here', () => {
  it('says the regression ran elsewhere instead of opening an empty editor', async () => {
    const { deps, messages, opened } = recorder({ pathExists: () => false });
    const outcome = await openCounterexampleInWaveCrux(deps);
    expect(outcome).toEqual({ kind: 'trace-missing', waveformPath: TRACE });
    expect(opened).toEqual([]);
    expect(messages[0]).toContain('not on this machine');
    expect(messages[0]).toContain(TRACE);
  });

  it('checks the file before the extension, so it never pitches an install for nothing', async () => {
    const isExtensionInstalled = vi.fn(() => false);
    const { deps } = recorder({ pathExists: () => false, isExtensionInstalled });
    const outcome = await openCounterexampleInWaveCrux(deps);
    expect(outcome.kind).toBe('trace-missing');
    expect(isExtensionInstalled).not.toHaveBeenCalled();
  });
});

describe('openCounterexampleInWaveCrux — when there is nothing to open', () => {
  it('explains that only a refuted proof produces a trace', async () => {
    const { deps, messages } = recorder({ waveformPath: undefined });
    expect(await openCounterexampleInWaveCrux(deps)).toEqual({ kind: 'no-counterexample' });
    expect(messages[0]).toContain('verdict FAIL');
  });

  it('treats an empty path as no path', async () => {
    const { deps } = recorder({ waveformPath: '' });
    expect(await openCounterexampleInWaveCrux(deps)).toEqual({ kind: 'no-counterexample' });
  });
});

describe('openCounterexampleInWaveCrux — when the editor host refuses', () => {
  it('returns the failure rather than throwing out of a command handler', async () => {
    const { deps } = recorder({
      openWith: () => Promise.reject(new Error('no editor for that viewType')),
    });
    const outcome = await openCounterexampleInWaveCrux(deps);
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('no editor') as unknown });
  });
});

describe('the demo, end to end', () => {
  /**
   * The suite demo, driven from the shipped fixtures: read a
   * real run, find the failing property, and open its trace. Every step is
   * the production code path; only the four injected side effects are
   * stubbed.
   */
  it('reads a run, finds the one failing property with a trace, and opens it', async () => {
    const tree = buildSimTestTree({
      project: readSimProject(
        readFileSync(path.join(fixtures, 'riscv-formal-demo.simcrux.yaml'), 'utf8'),
      ),
      document: parseSimResults(
        readFileSync(path.join(fixtures, 'riscv-formal-demo.results.ndjson'), 'utf8'),
      ),
      // The fixture's `/work/…` paths do not exist anywhere, so the demo is
      // driven with a filesystem that has exactly the trace and nothing else.
      pathExists: (fsPath) => fsPath === TRACE,
    });

    const clickable = tree.suites
      .flatMap((suite) => suite.tests)
      .filter((test) => test.counterexamplePath !== undefined);
    expect(clickable).toHaveLength(1);

    const { deps, opened } = recorder({
      waveformPath: clickable[0]?.counterexamplePath,
      pathExists: (fsPath) => fsPath === TRACE,
    });
    const outcome = await openCounterexampleInWaveCrux(deps);

    expect(outcome).toEqual({ kind: 'opened', waveformPath: TRACE });
    expect(opened).toEqual([{ waveformPath: TRACE, viewType: 'wavecrux.waveform' }]);
  });

  it('offers nothing to click on the four proofs that decided nothing', () => {
    const tree = buildSimTestTree({
      project: readSimProject(
        readFileSync(path.join(fixtures, 'riscv-formal-demo.simcrux.yaml'), 'utf8'),
      ),
      document: parseSimResults(
        readFileSync(path.join(fixtures, 'riscv-formal-demo.results.ndjson'), 'utf8'),
      ),
      pathExists: () => true,
    });
    for (const id of [
      'pc_fwd/pc_fwd_unknown',
      'reg/reg_timeout',
      'causal/causal_error',
      'liveness/liveness_no_outcome',
    ]) {
      const node = tree.suites.flatMap((suite) => suite.tests).find((test) => test.id === id);
      expect(node?.counterexamplePath).toBeUndefined();
    }
  });
});
