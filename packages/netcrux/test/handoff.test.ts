import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { desktopDetect } from '@crux-vscode/host-core';
import {
  isNetCruxDesignFile,
  NETCRUX_ARTIFACT_KIND,
  NETCRUX_DESIGN_EXTENSIONS,
  NETCRUX_DESIGN_GLOB,
  noNetCruxDesignMessage,
  openDesignInNetCrux,
  pickNetCruxDesignFile,
} from '../src/handoff';

const opened: desktopDetect.ArtifactHandoffOutcome = {
  kind: 'opened-in-peer',
  designId: 'a1b2c3d4e5f60718',
  path: '/ws/rtl/top.sv',
};

/** Files a NetCrux workspace holds that are not HDL NetCrux can load as `source`. */
const NOT_A_DESIGN = [
  '/ws/debug.netcrux', // a per-tab session export
  '/ws/cpu.netcrux-project', // a project: NetCrux has no artifact kind for one
  '/ws/cpu.crux-project', // the suite manifest, likewise
  '/ws/.crux-project',
  '/ws/rtl/defs.vh', // headers: included text, not a design
  '/ws/rtl/pkg.svh',
  '/ws/build/netlist.json',
  '/ws/README.md',
];

describe('openDesignInNetCrux', () => {
  it('hands the design file to the desktop peer', async () => {
    const handedOff: string[] = [];
    const outcome = await openDesignInNetCrux({
      designFile: () => Promise.resolve('/ws/rtl/top.sv'),
      handOff: (fsPath) => {
        handedOff.push(fsPath);
        return Promise.resolve(opened);
      },
      showMessage: () => undefined,
    });

    expect(outcome).toEqual({ kind: 'handed-off', designFile: '/ws/rtl/top.sv', handoff: opened });
    expect(handedOff).toEqual(['/ws/rtl/top.sv']);
  });

  it('reports the handoff’s own outcome rather than flattening it', async () => {
    // The whole point of switching to CXP is that "the app opened it" and
    // "the OS opened it with whatever owns the extension" are different
    // events; a caller that could not tell them apart would log the same line
    // for both.
    const fellBack: desktopDetect.ArtifactHandoffOutcome = {
      kind: 'launched-externally',
      path: '/ws/rtl/top.sv',
      why: 'no-answer',
    };
    const outcome = await openDesignInNetCrux({
      designFile: () => Promise.resolve('/ws/rtl/top.sv'),
      handOff: () => Promise.resolve(fellBack),
      showMessage: () => undefined,
    });

    expect(outcome).toMatchObject({ kind: 'handed-off', handoff: fellBack });
  });

  it('explains rather than failing silently when there is no design file', async () => {
    const shown: string[] = [];
    const handedOff: string[] = [];
    const outcome = await openDesignInNetCrux({
      designFile: () => Promise.resolve(undefined),
      handOff: (fsPath) => {
        handedOff.push(fsPath);
        return Promise.resolve(opened);
      },
      showMessage: (message) => {
        shown.push(message);
      },
    });

    expect(outcome).toEqual({ kind: 'no-design' });
    expect(handedOff).toEqual([]);
    expect(shown).toEqual([noNetCruxDesignMessage()]);
  });
});

describe('pickNetCruxDesignFile', () => {
  it('prefers the design file in the active editor, without searching', async () => {
    let searched = false;
    const picked = await pickNetCruxDesignFile('/ws/rtl/alu.v', () => {
      searched = true;
      return Promise.resolve('/ws/rtl/top.sv');
    });

    expect(picked).toBe('/ws/rtl/alu.v');
    expect(searched).toBe(false);
  });

  it.each(NOT_A_DESIGN)('passes over an active %s and searches the workspace', async (active) => {
    const picked = await pickNetCruxDesignFile(active, () => Promise.resolve('/ws/rtl/top.sv'));
    expect(picked).toBe('/ws/rtl/top.sv');
  });

  it('searches the workspace when no file is active', async () => {
    const picked = await pickNetCruxDesignFile(undefined, () => Promise.resolve('/ws/rtl/top.vhd'));
    expect(picked).toBe('/ws/rtl/top.vhd');
  });

  it('finds nothing when neither the editor nor the workspace has a design file', async () => {
    expect(await pickNetCruxDesignFile(undefined, () => Promise.resolve(undefined))).toBeUndefined();
  });

  it.each(NOT_A_DESIGN)('never hands over %s, even when the search returns it', async (found) => {
    // The defect this module was rewritten for: the search found a session
    // file and it went to NetCrux as HDL.
    expect(await pickNetCruxDesignFile(undefined, () => Promise.resolve(found))).toBeUndefined();
  });
});

/**
 * What NetCrux's `request_open_artifact` handler accepts, stated once here and
 * once in NetCrux's own `test/services/remote/cxp/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` — any other kind is refused;
 * 2. the path passes the floor, which is the route's only path rule: absolute,
 *    no NUL, and no surrounding white space, because the string checked is the
 *    string loaded. It is not rooted, so a design NetCrux never opened is
 *    honoured;
 * 3. it names a file NetCrux loads as HDL: Yosys reads it as Verilog,
 *    SystemVerilog or VHDL.
 *
 * The live half — this path, published and sent by host-core's
 * `openArtifactInDesktop`, resolved by crux_cxp's store and admitted by its
 * floor — is `host-core/test/cxp/dart-interop.test.ts` ("the desktop
 * hand-off").
 */
describe('the contract with NetCrux’s handler', () => {
  /** NetCrux's floor for this route, restated: see the doc comment above. */
  function passesNetCruxFloor(fsPath: string): boolean {
    return (
      fsPath.trim().length > 0 &&
      !fsPath.includes(String.fromCharCode(0)) &&
      fsPath.trim() === fsPath &&
      path.isAbsolute(fsPath)
    );
  }

  it('hands over a `source` artifact — the one kind NetCrux opens', () => {
    expect(NETCRUX_ARTIFACT_KIND).toBe('source');
  });

  it('offers only file types NetCrux’s own source picker accepts, and no header', () => {
    // NetCrux's `FileOpenService.pickSourceFiles` allows v, sv, svh, vh, vhd, vhdl.
    const netCruxSourcePicker = ['.v', '.sv', '.svh', '.vh', '.vhd', '.vhdl'];
    for (const extension of NETCRUX_DESIGN_EXTENSIONS) {
      expect(netCruxSourcePicker).toContain(extension);
    }
    expect(NETCRUX_DESIGN_EXTENSIONS).not.toContain('.vh');
    expect(NETCRUX_DESIGN_EXTENSIONS).not.toContain('.svh');
  });

  it('searches with a glob that names exactly the design extensions', () => {
    const braced = /^\*\*\/\*\.\{([^}]+)\}$/.exec(NETCRUX_DESIGN_GLOB);
    expect(braced).not.toBeNull();
    const globbed = (braced?.[1] ?? '').split(',').map((extension) => `.${extension}`);
    expect([...globbed].sort()).toEqual([...NETCRUX_DESIGN_EXTENSIONS].sort());
  });

  it('recognises a design file whatever the case of its extension', () => {
    expect(isNetCruxDesignFile('/ws/RTL/TOP.SV')).toBe(true);
    expect(isNetCruxDesignFile('/ws/rtl/top.Vhdl')).toBe(true);
  });

  it('whatever the editor or the workspace offers, what is picked satisfies all three', async () => {
    const offers: readonly (string | undefined)[] = [
      undefined,
      ...NOT_A_DESIGN,
      path.resolve('/ws/rtl/top.sv'),
      path.resolve('/ws/rtl/alu.v'),
      path.resolve('/ws/rtl/fsm.vhd'),
      path.resolve('/ws/rtl/fsm.vhdl'),
    ];
    for (const active of offers) {
      for (const found of offers) {
        const picked = await pickNetCruxDesignFile(active, () => Promise.resolve(found));
        if (picked === undefined) continue;
        expect(passesNetCruxFloor(picked), picked).toBe(true);
        expect(isNetCruxDesignFile(picked), picked).toBe(true);
        expect(NOT_A_DESIGN).not.toContain(picked);
      }
    }
  });
});
