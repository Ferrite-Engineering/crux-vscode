import { describe, expect, it } from 'vitest';
import { NETCRUX_LINK_EXTENSIONS, parseNetCruxLink } from '../../src/links/netcrux-link';

function refusalOf(raw: string): string | undefined {
  const result = parseNetCruxLink(raw);
  return result.ok ? undefined : result.refusal;
}

describe('parseNetCruxLink', () => {
  it('reads the links the reference builder writes', () => {
    // crux_mcp's location_test.dart: `/` is %2F and `$` is %24.
    expect(parseNetCruxLink('netcrux://open?file=%2Fw%2Ftop.json&cell=u%2Fa%241')).toEqual({
      ok: true,
      link: { file: '/w/top.json', kind: 'cell', name: 'u/a$1' },
    });
    expect(parseNetCruxLink('netcrux://open?file=C%3A%5Cw%5Ct.json&net=n1')).toEqual({
      ok: true,
      link: { file: 'C:\\w\\t.json', kind: 'net', name: 'n1' },
    });
    expect(parseNetCruxLink('netcrux://open?file=%2Fd.json&cell=u')).toEqual({
      ok: true,
      link: { file: '/d.json', kind: 'cell', name: 'u' },
    });
    expect(parseNetCruxLink('netcrux://open?file=%2Frtl%2Ftop.sv')).toEqual({ ok: true, link: { file: '/rtl/top.sv' } });
  });

  it.each([
    ['relative-path', 'netcrux://open?file=rtl%2Ftop.sv&cell=top.u'],
    ['relative-path', 'netcrux://open?file=C%3Artl%2Ftop.sv'],
    ['relative-path', 'netcrux://open?file=~%2Ftop.sv'],
    ['cell-and-net', 'netcrux://open?file=%2Ftop.sv&cell=a&net=b'],
    ['duplicate-key', 'netcrux://open?file=%2Ftop.sv&cell=a&cell=b'],
    ['unknown-key', 'netcrux://open?file=%2Ftop.sv&signal=a'],
    ['unknown-key', 'netcrux://open?file=%2Ftop.sv&yosys=x'],
    ['missing-value', 'netcrux://open?cell=a'],
    ['too-long', `netcrux://open?file=%2Ftop.sv&net=${'n'.repeat(1025)}`],
    ['wrong-scheme', 'wavecrux://open?file=%2Ftop.sv'],
    ['malformed', 'netcrux://open/x?file=%2Ftop.sv'],
    ['forbidden-character', 'netcrux://open?file=%2Ftop.sv&cell=top%20u'],
    ['bad-encoding', 'netcrux://open?file=%2Ftop%E2.sv'],
  ])('refuses %s: %s', (refusal, raw) => {
    expect(refusalOf(raw)).toBe(refusal);
  });

  it('mutation: a parser whose absolute rule accepts everything lets a relative path through', () => {
    const mutant = parseNetCruxLink('netcrux://open?file=rtl%2Ftop.sv', { isAbsolute: () => true });
    expect(mutant.ok).toBe(true);
  });
});

describe('the files a link may open', () => {
  it('are HDL sources and a JSON netlist, never a project, session, workspace, manifest or filelist', () => {
    expect([...NETCRUX_LINK_EXTENSIONS].sort()).toEqual(['.json', '.sv', '.svh', '.v', '.vh', '.vhd', '.vhdl']);
    for (const refused of ['.netcrux-project', '.netcrux', '.netcrux-workspace', '.crux-project', '.f', '.gz']) {
      expect(NETCRUX_LINK_EXTENSIONS.has(refused), refused).toBe(false);
    }
  });
});
