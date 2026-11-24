import { describe, expect, it } from 'vitest';
import { findCruxLinks } from '../../src/links/detect';

const find = (line: string): string[] =>
  findCruxLinks(line, 'wavecrux', 'ferrite-engineering.wavecrux').map((link) => link.text);

describe('findCruxLinks', () => {
  it('finds the desktop form and the editor form, at their offsets', () => {
    const line = 'see wavecrux://open?file=%2Fw%2Fd.vcd&signal=top.clk&t=5 and vscode://ferrite-engineering.wavecrux/open?file=%2Fa.vcd';
    const links = findCruxLinks(line, 'wavecrux', 'ferrite-engineering.wavecrux');
    expect(links.map((link) => link.text)).toEqual([
      'wavecrux://open?file=%2Fw%2Fd.vcd&signal=top.clk&t=5',
      'vscode://ferrite-engineering.wavecrux/open?file=%2Fa.vcd',
    ]);
    for (const link of links) expect(line.slice(link.startIndex, link.startIndex + link.length)).toBe(link.text);
  });

  it('stops at brackets, quotes and sentence punctuation', () => {
    expect(find('[waveform](wavecrux://open?file=%2Fa.vcd).')).toEqual(['wavecrux://open?file=%2Fa.vcd']);
    expect(find('"wavecrux://open?file=%2Fa.vcd", then')).toEqual(['wavecrux://open?file=%2Fa.vcd']);
    expect(find('<wavecrux://open?file=%2Fa.vcd>')).toEqual(['wavecrux://open?file=%2Fa.vcd']);
    expect(find('Open wavecrux://open?file=%2Fa.vcd.')).toEqual(['wavecrux://open?file=%2Fa.vcd']);
  });

  it('claims nothing that is not this product', () => {
    expect(find('netcrux://open?file=%2Fa.json')).toEqual([]);
    expect(find('xwavecrux://open?file=%2Fa.vcd')).toEqual([]);
    expect(find('vscode://ferrite-engineering.netcrux/open?file=%2Fa.json')).toEqual([]);
    expect(find('https://wavecrux.app/docs')).toEqual([]);
    expect(find('')).toEqual([]);
  });
});
