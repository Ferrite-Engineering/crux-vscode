import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { desktopDetect } from '@crux-vscode/host-core';
import {
  LINTCRUX_ARTIFACT_KIND,
  LINTCRUX_PROJECT_EXTENSION,
  LINTCRUX_PROJECT_GLOB,
  getLintCruxLabel,
  isLintCruxProjectFile,
  noProjectMessage,
  openTriageInDesktop,
  pickLintCruxProjectFile,
  triageBoundaryMessage,
  type TriageHandoffDeps,
} from '../src/handoff';

/** A successful CXP handoff, the outcome host-core reports on the happy path. */
const openedInPeer: desktopDetect.ArtifactHandoffOutcome = {
  kind: 'opened-in-peer',
  designId: 'a1b2c3d4e5f60718',
  path: '/work/design/design.lintcrux',
};

interface Recorder {
  readonly deps: TriageHandoffDeps;
  readonly openedPaths: string[];
  readonly openedUrls: string[];
  readonly messages: { message: string; actions: readonly string[] }[];
}

function recorder(options: {
  present: boolean;
  projectFile?: string | undefined;
  choose?: (actions: readonly string[]) => string | undefined;
  handoff?: desktopDetect.ArtifactHandoffOutcome;
}): Recorder {
  const openedPaths: string[] = [];
  const openedUrls: string[] = [];
  const messages: { message: string; actions: readonly string[] }[] = [];
  return {
    openedPaths,
    openedUrls,
    messages,
    deps: {
      desktopPeerPresent: () => options.present,
      projectFile: () => Promise.resolve(options.projectFile),
      handOff: (fsPath) => {
        openedPaths.push(fsPath);
        return Promise.resolve(options.handoff ?? openedInPeer);
      },
      openUrl: (url) => {
        openedUrls.push(url);
        return Promise.resolve();
      },
      showMessage: (message, ...actions) => {
        messages.push({ message, actions });
        return Promise.resolve(options.choose?.(actions));
      },
    },
  };
}

describe('openTriageInDesktop — with a desktop peer', () => {
  it('hands the project to the peer over CXP', async () => {
    const harness = recorder({ present: true, projectFile: '/work/design/design.lintcrux' });
    const outcome = await openTriageInDesktop(harness.deps);
    expect(outcome).toEqual({
      kind: 'handed-off',
      projectFile: '/work/design/design.lintcrux',
      handoff: openedInPeer,
    });
    expect(harness.openedPaths).toEqual(['/work/design/design.lintcrux']);
  });

  it('reports the OS fallback distinctly from a CXP open', async () => {
    // The distinction the switch to CXP exists to create: before it, both
    // of these were one `openExternal` and one indistinguishable outcome.
    const fellBack: desktopDetect.ArtifactHandoffOutcome = {
      kind: 'launched-externally',
      path: '/work/design/design.lintcrux',
      why: 'not-understood',
    };
    const harness = recorder({
      present: true,
      projectFile: '/work/design/design.lintcrux',
      handoff: fellBack,
    });
    expect(await openTriageInDesktop(harness.deps)).toMatchObject({ handoff: fellBack });
  });

  it('hands over a `source` artifact — the only kind LintCrux’s handler accepts', () => {
    // `_dispatchRequestOpenArtifact` in lintcrux_cxp_request_handler.dart
    // answers honored:false for anything else, by name.
    expect(LINTCRUX_ARTIFACT_KIND).toBe('source');
  });

  it('does not pitch the app to someone who already has it running', async () => {
    const harness = recorder({ present: true, projectFile: '/work/design/design.lintcrux' });
    await openTriageInDesktop(harness.deps);
    expect(harness.messages).toEqual([]);
    expect(harness.openedUrls).toEqual([]);
  });

  it('says so plainly when there is no project file to hand over', async () => {
    const harness = recorder({ present: true, projectFile: undefined });
    const outcome = await openTriageInDesktop(harness.deps);
    expect(outcome).toEqual({ kind: 'no-project' });
    expect(harness.messages[0]?.message).toBe(noProjectMessage());
    // A statement, not an upsell: no buttons.
    expect(harness.messages[0]?.actions).toEqual([]);
    expect(harness.openedPaths).toEqual([]);
  });
});

describe('openTriageInDesktop — with no desktop peer', () => {
  it('states the boundary rather than half-building the triage view', async () => {
    const harness = recorder({ present: false });
    const outcome = await openTriageInDesktop(harness.deps);
    expect(outcome).toEqual({ kind: 'boundary', followed: false });
    expect(harness.messages[0]?.message).toBe(triageBoundaryMessage());
    expect(harness.messages[0]?.actions).toEqual([getLintCruxLabel()]);
  });

  it('names what the app does that the editor does not', () => {
    const message = triageBoundaryMessage();
    expect(message).toContain('LintCrux Desktop');
    for (const promise of ['new since last run', 'waivers are in force', 'trending']) {
      expect(message).toContain(promise);
    }
  });

  it('opens the product site only when the button is taken', async () => {
    const declined = recorder({ present: false });
    await openTriageInDesktop(declined.deps);
    expect(declined.openedUrls).toEqual([]);

    const accepted = recorder({ present: false, choose: (actions) => actions[0] });
    const outcome = await openTriageInDesktop(accepted.deps);
    expect(outcome).toEqual({ kind: 'boundary', followed: true });
    // The same URL host-core's capabilities panel uses, not a second one.
    expect(accepted.openedUrls).toEqual(['https://lintcrux.app']);
  });

  it('never opens a file when there is no peer to open it in', async () => {
    const harness = recorder({
      present: false,
      projectFile: '/work/design/design.lintcrux',
      choose: (actions) => actions[0],
    });
    await openTriageInDesktop(harness.deps);
    expect(harness.openedPaths).toEqual([]);
  });
});

describe('pickLintCruxProjectFile', () => {
  /** The workspace search, returning [found] in the order given. */
  const search =
    (...found: string[]) =>
    (): Promise<readonly string[]> =>
      Promise.resolve(found);

  it('hands over the project in the active editor, without searching', async () => {
    let searched = false;
    const picked = await pickLintCruxProjectFile('/ws/uart/uart.lintcrux', () => {
      searched = true;
      return Promise.resolve(['/ws/cpu/cpu.lintcrux']);
    });
    expect(picked).toBe('/ws/uart/uart.lintcrux');
    expect(searched).toBe(false);
  });

  // The defect: the first project the search returned went over, whichever
  // design the user was editing. MUTATION: returning the first search result
  // before looking for the nearest project makes this red.
  it('prefers the project nearest above the file being edited', async () => {
    const picked = await pickLintCruxProjectFile(
      '/ws/soc/uart/rtl/uart_tx.sv',
      search('/ws/soc/soc.lintcrux', '/ws/cpu/cpu.lintcrux', '/ws/soc/uart/uart.lintcrux'),
    );
    expect(picked).toBe('/ws/soc/uart/uart.lintcrux');
  });

  it('prefers an enclosing project to an unrelated one found first', async () => {
    const picked = await pickLintCruxProjectFile(
      '/ws/soc/uart/rtl/uart_tx.sv',
      search('/ws/cpu/cpu.lintcrux', '/ws/soc/soc.lintcrux'),
    );
    expect(picked).toBe('/ws/soc/soc.lintcrux');
  });

  it('does not take a sibling folder whose name starts the same for an enclosing one', async () => {
    const picked = await pickLintCruxProjectFile(
      '/ws/uart2/rtl/tx.sv',
      search('/ws/uart/uart.lintcrux', '/ws/a/a.lintcrux'),
    );
    // Neither encloses the file, so the first in path order.
    expect(picked).toBe('/ws/a/a.lintcrux');
  });

  it('with nothing active, takes the first project in path order, not search order', async () => {
    const picked = await pickLintCruxProjectFile(
      undefined,
      search('/ws/uart/uart.lintcrux', '/ws/cpu/cpu.lintcrux'),
    );
    expect(picked).toBe('/ws/cpu/cpu.lintcrux');
  });

  it('never hands over a file that is not a project, even when the search returns one', async () => {
    const picked = await pickLintCruxProjectFile(
      '/ws/uart/rtl/tx.sv',
      search('/ws/uart/uart.lintcrux-waivers.json', '/ws/uart/results.sarif'),
    );
    expect(picked).toBeUndefined();
  });

  it('finds nothing when the workspace has no project', async () => {
    expect(await pickLintCruxProjectFile(undefined, search())).toBeUndefined();
  });
});

/**
 * What LintCrux's `request_open_artifact` handler accepts, stated once here
 * and once in LintCrux's own `test/features/remote/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` — any other kind is refused;
 * 2. the path passes the floor, which is the route's only path rule:
 *    absolute, no NUL, and no surrounding white space, because the string
 *    checked is the string opened. It is not rooted, so a project LintCrux
 *    never opened is honoured;
 * 3. it names a `.lintcrux` project.
 *
 * The live half — a project file published and sent by host-core's
 * `openArtifactInDesktop`, resolved by crux_cxp's store and admitted by its
 * floor — is `host-core/test/cxp/dart-interop.test.ts` ("the desktop
 * hand-off").
 */
describe('the contract with LintCrux’s handler', () => {
  /** LintCrux's floor for this route, restated: see the doc comment above. */
  function passesLintCruxFloor(fsPath: string): boolean {
    return (
      fsPath.trim().length > 0 &&
      !fsPath.includes(String.fromCharCode(0)) &&
      fsPath.trim() === fsPath &&
      path.isAbsolute(fsPath)
    );
  }

  it('hands over a `source` artifact — the one kind LintCrux opens', () => {
    expect(LINTCRUX_ARTIFACT_KIND).toBe('source');
  });

  it('searches with a glob that names exactly the project extension', () => {
    expect(LINTCRUX_PROJECT_GLOB).toBe(`**/*${LINTCRUX_PROJECT_EXTENSION}`);
  });

  it('whatever the editor or the workspace offers, what is picked satisfies all three', async () => {
    const offers: readonly (string | undefined)[] = [
      undefined,
      path.resolve('/ws/uart/rtl/tx.sv'),
      path.resolve('/ws/uart/uart.lintcrux'),
      path.resolve('/ws/cpu/cpu.lintcrux'),
      path.resolve('/ws/uart/.lintcrux-waivers.json'),
      path.resolve('/ws/uart/results.sarif'),
      path.resolve('/ws/uart/design.crux-project'),
    ];
    for (const active of offers) {
      for (const found of offers) {
        const picked = await pickLintCruxProjectFile(active, () =>
          Promise.resolve(found === undefined ? [] : [found]),
        );
        if (picked === undefined) continue;
        expect(passesLintCruxFloor(picked), picked).toBe(true);
        expect(isLintCruxProjectFile(picked), picked).toBe(true);
      }
    }
  });
});
