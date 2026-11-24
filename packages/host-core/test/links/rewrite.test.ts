import { describe, expect, it } from 'vitest';
import { parseCruxLinkQuery, type CruxLinkGrammar } from '../../src/links/grammar';
import { desktopLinkFromEditorUri, desktopLinkFromText } from '../../src/links/rewrite';

const GRAMMAR: CruxLinkGrammar = { scheme: 'wavecrux', keys: { file: 4096, signal: 1024, t: 48 } };
const EXTENSION = 'ferrite-engineering.wavecrux';

/**
 * What VS Code's `URI.parse` hands a URI handler for [link]: path, query and
 * fragment each percent-decoded once. Written out by hand from VS Code's
 * `percentDecode` (every run of `%XX` decoded as UTF-8, a run that is not
 * UTF-8 left as it is), not by calling the code under test.
 */
function asDelivered(path: string, decodedQuery: string, fragment = ''): { path: string; query: string; fragment: string } {
  return { path, query: decodedQuery, fragment };
}

function values(link: string): Record<string, string> | string {
  const result = parseCruxLinkQuery(link, GRAMMAR);
  return result.ok ? Object.fromEntries(result.values) : result.refusal;
}

describe('the editor form, as VS Code delivers it, is rewritten to the desktop form', () => {
  it('re-encodes each decoded value, so the desktop parser reads the values the sender wrote', () => {
    // vscode://ferrite-engineering.wavecrux/open?file=%2Fwork%2Fc%2B%2B%2Frun%201%2Fwitness.vcd&signal=top.u_alu.result&t=1500ns
    const rewrite = desktopLinkFromEditorUri(
      asDelivered('/open', 'file=/work/c++/run 1/witness.vcd&signal=top.u_alu.result&t=1500ns'),
      'wavecrux',
    );
    expect(rewrite).toEqual({
      ok: true,
      link: 'wavecrux://open?file=%2Fwork%2Fc%2B%2B%2Frun%201%2Fwitness.vcd&signal=top.u_alu.result&t=1500ns',
    });
    if (!rewrite.ok) return;
    expect(values(rewrite.link)).toEqual({ file: '/work/c++/run 1/witness.vcd', signal: 'top.u_alu.result', t: '1500ns' });
  });

  it('keeps a literal % that VS Code decoded from %25, rather than decoding it twice', () => {
    // file=%2Fw%2F100%25done.vcd, delivered as file=/w/100%done.vcd
    const rewrite = desktopLinkFromEditorUri(asDelivered('/open', 'file=/w/100%done.vcd'), 'wavecrux');
    expect(rewrite.ok && values(rewrite.link)).toEqual({ file: '/w/100%done.vcd' });
  });

  it('refuses a value that still holds an escape, which cannot be told from a file name', () => {
    // file=%2Fw%2Fa%2541.vcd (a file named a%41.vcd) is delivered as file=/w/a%41.vcd
    expect(desktopLinkFromEditorUri(asDelivered('/open', 'file=/w/a%41.vcd'), 'wavecrux')).toEqual({
      ok: false,
      refusal: 'bad-encoding',
    });
    // An escape VS Code could not decode (not UTF-8) is left in place, and refused the same way.
    expect(desktopLinkFromEditorUri(asDelivered('/open', 'file=/w/%FF.vcd'), 'wavecrux').ok).toBe(false);
  });

  it('refuses, never misreads, a file name the decoding splits', () => {
    // file=%2Fa%26b%3Dc%3Fd%23e.vcd&signal=tb.dut&t=0us, delivered with its & and = decoded.
    const rewrite = desktopLinkFromEditorUri(
      asDelivered('/open', 'file=/a&b=c?d#e.vcd&signal=tb.dut&t=0us'),
      'wavecrux',
    );
    expect(rewrite.ok && values(rewrite.link)).toBe('unknown-key');
  });

  it('refuses another action, a fragment, and leaves a bad pair for the parser', () => {
    expect(desktopLinkFromEditorUri(asDelivered('/close', 'file=/a.vcd'), 'wavecrux').ok).toBe(false);
    expect(desktopLinkFromEditorUri(asDelivered('', 'file=/a.vcd'), 'wavecrux').ok).toBe(false);
    expect(desktopLinkFromEditorUri(asDelivered('/open', 'file=/a.vcd', 'x'), 'wavecrux').ok).toBe(false);
    const bare = desktopLinkFromEditorUri(asDelivered('/OPEN/', 'file'), 'wavecrux');
    expect(bare.ok && values(bare.link)).toBe('malformed');
    const empty = desktopLinkFromEditorUri(asDelivered('/open', ''), 'wavecrux');
    expect(empty.ok && values(empty.link)).toBe('missing-value');
  });
});

describe('text given to the Open Link command or found in a terminal', () => {
  it('passes the desktop form through unchanged', () => {
    expect(desktopLinkFromText('  wavecrux://open?file=%2Fa.vcd ', 'wavecrux', EXTENSION)).toEqual({
      ok: true,
      link: 'wavecrux://open?file=%2Fa.vcd',
    });
  });

  it('rewrites the editor form written out, under any editor scheme, without decoding it', () => {
    for (const editorScheme of ['vscode', 'vscode-insiders', 'cursor']) {
      expect(
        desktopLinkFromText(`${editorScheme}://Ferrite-Engineering.WaveCrux/open?file=%2Fa%25.vcd&t=5`, 'wavecrux', EXTENSION),
      ).toEqual({ ok: true, link: 'wavecrux://open?file=%2Fa%25.vcd&t=5' });
    }
  });

  it('keeps what the desktop parser must refuse, so it refuses it', () => {
    const rewrite = desktopLinkFromText('vscode://ferrite-engineering.wavecrux/run?file=%2Fa.vcd#x', 'wavecrux', EXTENSION);
    expect(rewrite.ok && values(rewrite.link)).toBe('malformed');
  });

  it('says another product or anything else is not a link of this one', () => {
    for (const text of [
      'netcrux://open?file=%2Fa.json',
      'vscode://ferrite-engineering.netcrux/open?file=%2Fa.json',
      'https://example.com/open?file=%2Fa.vcd',
      '/w/a.vcd',
    ]) {
      expect(desktopLinkFromText(text, 'wavecrux', EXTENSION)).toEqual({ ok: false, refusal: 'wrong-scheme' });
    }
  });
});
