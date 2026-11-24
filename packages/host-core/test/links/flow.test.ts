import { describe, expect, it } from 'vitest';
import { openCruxLink, type CruxLinkFlow, type CruxLinkNotice } from '../../src/links/flow';
import type { LinkTargetResult } from '../../src/links/target';

interface Link {
  readonly file: string;
}

interface Recorder {
  readonly notices: CruxLinkNotice[];
  readonly confirmed: string[];
  readonly opened: string[];
}

function flowFor(
  options: {
    parse?: CruxLinkFlow<Link>['parse'];
    vet?: LinkTargetResult;
    openTab?: string;
    answer?: boolean;
    openThrows?: boolean;
  } = {},
): { flow: CruxLinkFlow<Link>; seen: Recorder } {
  const seen: Recorder = { notices: [], confirmed: [], opened: [] };
  const flow: CruxLinkFlow<Link> = {
    parse: options.parse ?? ((link) => ({ ok: true, link: { file: link.replace('x://open?file=', '') } })),
    vet: () => Promise.resolve(options.vet ?? { ok: true, path: '/real/dump.vcd' }),
    openTabPath: () => Promise.resolve(options.openTab),
    confirm: (path) => {
      seen.confirmed.push(path);
      return Promise.resolve(options.answer ?? false);
    },
    open: (path) => {
      seen.opened.push(path);
      return options.openThrows === true ? Promise.reject(new Error('editor gone')) : Promise.resolve();
    },
    notify: (notice) => seen.notices.push(notice),
  };
  return { flow, seen };
}

const LINK = { ok: true as const, link: 'x://open?file=/w/alias.vcd' };

describe('openCruxLink', () => {
  it('confirms a file that is not open, and opens the resolved path on Open', async () => {
    const { flow, seen } = flowFor({ answer: true });
    expect(await openCruxLink(LINK, flow)).toEqual({ kind: 'opened', path: '/real/dump.vcd', confirmed: true });
    expect(seen.confirmed).toEqual(['/real/dump.vcd']);
    expect(seen.opened).toEqual(['/real/dump.vcd']);
  });

  it('opens nothing on Cancel', async () => {
    const { flow, seen } = flowFor({ answer: false });
    expect(await openCruxLink(LINK, flow)).toEqual({ kind: 'cancelled', path: '/real/dump.vcd' });
    expect(seen.opened).toEqual([]);
    expect(seen.notices).toEqual([]);
  });

  it('asks nothing for a file open in a tab, and focuses that tab', async () => {
    const { flow, seen } = flowFor({ openTab: '/link/to/dump.vcd' });
    expect(await openCruxLink(LINK, flow)).toEqual({ kind: 'opened', path: '/link/to/dump.vcd', confirmed: false });
    expect(seen.confirmed).toEqual([]);
    expect(seen.opened).toEqual(['/link/to/dump.vcd']);
  });

  it('says why a rewrite or a parse refused, and opens nothing', async () => {
    const rewrite = flowFor();
    expect(await openCruxLink({ ok: false, refusal: 'bad-encoding' }, rewrite.flow)).toMatchObject({ kind: 'refused' });
    expect(rewrite.seen.notices).toEqual([{ kind: 'invalid' }]);

    const unknown = flowFor({ parse: () => ({ ok: false, refusal: 'unknown-key' }) });
    await openCruxLink(LINK, unknown.flow);
    expect(unknown.seen.notices).toEqual([{ kind: 'invalid' }]);

    const relative = flowFor({ parse: () => ({ ok: false, refusal: 'relative-path' }) });
    await openCruxLink(LINK, relative.flow);
    expect(relative.seen.notices).toEqual([{ kind: 'path' }]);

    for (const { seen } of [rewrite, unknown, relative]) {
      expect(seen.confirmed).toEqual([]);
      expect(seen.opened).toEqual([]);
    }
  });

  it.each([
    ['path-refused', { kind: 'path' }],
    ['wrong-kind', { kind: 'wrong-kind', fileName: 'alias.vcd' }],
    ['file-not-found', { kind: 'not-found', fileName: 'alias.vcd' }],
  ] as const)('says why the file was refused (%s), and opens nothing', async (refusal, notice) => {
    const { flow, seen } = flowFor({ vet: { ok: false, refusal } });
    expect(await openCruxLink(LINK, flow)).toEqual({ kind: 'refused', stage: 'target', reason: refusal });
    expect(seen.notices).toEqual([notice]);
    expect(seen.confirmed).toEqual([]);
    expect(seen.opened).toEqual([]);
  });

  it('names a Windows file by its own base name', async () => {
    const { flow, seen } = flowFor({
      parse: () => ({ ok: true, link: { file: 'C:\\w\\gone.vcd' } }),
      vet: { ok: false, refusal: 'file-not-found' },
    });
    await openCruxLink(LINK, flow);
    expect(seen.notices).toEqual([{ kind: 'not-found', fileName: 'gone.vcd' }]);
  });

  it('never throws when the product open fails', async () => {
    const { flow } = flowFor({ openTab: '/real/dump.vcd', openThrows: true });
    await expect(openCruxLink(LINK, flow)).resolves.toMatchObject({ kind: 'opened' });
  });
});
