import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { desktopDetect } from '@crux-vscode/host-core';
import {
  SIMCRUX_ARTIFACT_KIND,
  SIMCRUX_PROJECT_EXTENSIONS,
  getSimCruxLabel,
  isSimCruxProjectFile,
  openHistoryInDesktop,
  pickSimCruxProjectFile,
  type HistoryHandoffDeps,
} from '../src/handoff';

/** A successful CXP handoff, the outcome host-core reports on the happy path. */
const openedInPeer: desktopDetect.ArtifactHandoffOutcome = {
  kind: 'opened-in-peer',
  designId: 'a1b2c3d4e5f60718',
  path: '/work/design/simcrux.yaml',
};

interface Recorder {
  readonly deps: HistoryHandoffDeps;
  readonly opened: string[];
  readonly urls: string[];
  readonly messages: string[];
}

function recorder(overrides: Partial<HistoryHandoffDeps> = {}): Recorder {
  const opened: string[] = [];
  const urls: string[] = [];
  const messages: string[] = [];
  const deps: HistoryHandoffDeps = {
    desktopPeerPresent: () => true,
    projectFile: () => Promise.resolve('/work/design/simcrux.yaml'),
    handOff: (fsPath) => {
      opened.push(fsPath);
      return Promise.resolve(openedInPeer);
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
  return { deps, opened, urls, messages };
}

describe('openHistoryInDesktop — a peer is running', () => {
  it('hands the project to the peer over CXP', async () => {
    const { deps, opened, messages } = recorder();
    expect(await openHistoryInDesktop(deps)).toEqual({
      kind: 'handed-off',
      projectFile: '/work/design/simcrux.yaml',
      handoff: openedInPeer,
    });
    expect(opened).toEqual(['/work/design/simcrux.yaml']);
    // No boundary message: the user already has the app.
    expect(messages).toEqual([]);
  });

  it('hands over the simcrux.yaml, so the design id is rooted at the project dir', async () => {
    // The one derivation input that is easy to get wrong for SimCrux: the
    // id must key the *input* directory the desktop app publishes its dumps
    // under, never the output directory a VCD lands in.
    const { deps, opened } = recorder();
    await openHistoryInDesktop(deps);
    expect(opened[0]?.endsWith('simcrux.yaml')).toBe(true);
    expect(SIMCRUX_ARTIFACT_KIND).toBe('source');
  });

  it('reports the OS fallback distinctly from a CXP open', async () => {
    const fellBack: desktopDetect.ArtifactHandoffOutcome = {
      kind: 'launched-externally',
      path: '/work/design/simcrux.yaml',
      why: 'no-answer',
    };
    const { deps } = recorder({ handOff: () => Promise.resolve(fellBack) });
    expect(await openHistoryInDesktop(deps)).toMatchObject({ handoff: fellBack });
  });

  it('says so when there is no project file to hand over', async () => {
    const { deps, opened, messages } = recorder({ projectFile: () => Promise.resolve(undefined) });
    expect(await openHistoryInDesktop(deps)).toEqual({ kind: 'no-project' });
    expect(opened).toEqual([]);
    expect(messages[0]).toContain('no simcrux.yaml');
  });
});

describe('openHistoryInDesktop — no peer', () => {
  it('explains the boundary rather than pitching generically', async () => {
    const { deps, messages, opened } = recorder({ desktopPeerPresent: () => false });
    expect(await openHistoryInDesktop(deps)).toEqual({ kind: 'boundary', followed: false });
    expect(opened).toEqual([]);
    expect(messages[0]).toContain('run history');
  });

  it('opens the product site when the link is taken', async () => {
    const { deps, urls } = recorder({
      desktopPeerPresent: () => false,
      showMessage: () => Promise.resolve(getSimCruxLabel()),
    });
    expect(await openHistoryInDesktop(deps)).toEqual({ kind: 'boundary', followed: true });
    // The desktop *app* is what is missing here, unlike the counterexample
    // handoff's boundary, where the missing thing is an extension.
    expect(urls).toEqual(['https://simcrux.app']);
  });

  it('never looks for a project file when there is no peer to give it to', async () => {
    let asked = false;
    const { deps } = recorder({
      desktopPeerPresent: () => false,
      projectFile: () => {
        asked = true;
        return Promise.resolve('/work/simcrux.yaml');
      },
    });
    await openHistoryInDesktop(deps);
    expect(asked).toBe(false);
  });
});

/** Files a SimCrux workspace holds that SimCrux would not open as a project. */
const NOT_A_PROJECT = [
  '/ws/rtl/top.sv', // a source file: SimCrux sends it to an editor
  '/ws/sim/results.json',
  '/ws/sim/run.simcrux-session',
  '/ws/README.md',
];

describe('pickSimCruxProjectFile', () => {
  it('hands over the configured project file, without searching', async () => {
    let searched = false;
    const picked = await pickSimCruxProjectFile('/ws/sim/regress.yaml', () => {
      searched = true;
      return Promise.resolve('/ws/simcrux.yaml');
    });
    expect(picked).toBe('/ws/sim/regress.yaml');
    expect(searched).toBe(false);
  });

  it('searches when nothing is configured', async () => {
    const picked = await pickSimCruxProjectFile(undefined, () =>
      Promise.resolve('/ws/simcrux.yaml'),
    );
    expect(picked).toBe('/ws/simcrux.yaml');
  });

  // SimCrux sends a source file that is not a project to an editor, so it
  // would come back to this window. MUTATION: returning [configured]
  // without checking it makes this red.
  it.each(NOT_A_PROJECT)('passes over a configured %s and searches instead', async (configured) => {
    const picked = await pickSimCruxProjectFile(configured, () =>
      Promise.resolve('/ws/simcrux.yaml'),
    );
    expect(picked).toBe('/ws/simcrux.yaml');
  });

  it.each(NOT_A_PROJECT)('never hands over %s, even when the search returns it', async (found) => {
    expect(await pickSimCruxProjectFile(undefined, () => Promise.resolve(found))).toBeUndefined();
  });

  it('recognises a project file whatever the case of its extension', () => {
    expect(isSimCruxProjectFile('/ws/SIM/Regress.YML')).toBe(true);
    expect(isSimCruxProjectFile('/ws/uart.Crux-Project')).toBe(true);
    expect(isSimCruxProjectFile('/ws/.crux-project')).toBe(true);
  });
});

/**
 * What SimCrux's `request_open_artifact` handler does with a project, stated
 * once here and once in SimCrux's own
 * `test/features/remote/providers/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` — any other kind is refused;
 * 2. the path passes the floor, which is a project open's only path rule:
 *    absolute, no NUL, and no surrounding white space, because the string
 *    checked is the string opened. It is not rooted, so a config SimCrux
 *    never opened opens;
 * 3. it names a SimCrux project — a `.yaml` / `.yml` config or a
 *    `.crux-project` manifest — which SimCrux opens as a config tab. Any other
 *    source file goes to the user's editor instead, and only inside the
 *    directories SimCrux has opened.
 *
 * The live half — a config published and sent by host-core's
 * `openArtifactInDesktop`, resolved by crux_cxp's store and admitted by its
 * floor — is `host-core/test/cxp/dart-interop.test.ts` ("the desktop
 * hand-off").
 */
describe('the contract with SimCrux’s handler', () => {
  /** SimCrux's floor for a project open, restated: see the doc comment above. */
  function passesSimCruxFloor(fsPath: string): boolean {
    return (
      fsPath.trim().length > 0 &&
      !fsPath.includes(String.fromCharCode(0)) &&
      fsPath.trim() === fsPath &&
      path.isAbsolute(fsPath)
    );
  }

  it('hands over a `source` artifact — the one kind SimCrux opens', () => {
    expect(SIMCRUX_ARTIFACT_KIND).toBe('source');
  });

  it('offers exactly the files SimCrux opens as a project', () => {
    // SimCrux's `isSimcruxProjectPath`: `.yaml`, `.yml`, and a manifest.
    expect([...SIMCRUX_PROJECT_EXTENSIONS].sort()).toEqual(['.crux-project', '.yaml', '.yml']);
  });

  it('whatever is configured or found, what is picked satisfies all three', async () => {
    const offers: readonly (string | undefined)[] = [
      undefined,
      ...NOT_A_PROJECT,
      path.resolve('/ws/simcrux.yaml'),
      path.resolve('/ws/sim/regress.yml'),
      path.resolve('/ws/uart.crux-project'),
    ];
    for (const configured of offers) {
      for (const found of offers) {
        const picked = await pickSimCruxProjectFile(configured, () => Promise.resolve(found));
        if (picked === undefined) continue;
        expect(passesSimCruxFloor(picked), picked).toBe(true);
        expect(isSimCruxProjectFile(picked), picked).toBe(true);
        expect(NOT_A_PROJECT).not.toContain(picked);
      }
    }
  });
});
