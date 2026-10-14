import { describe, expect, it } from 'vitest';
import { FOLLOW_DISABLED_NOTICE, createFollowDisabledNotice } from '../src/webview/follow-notice';

describe('createFollowDisabledNotice', () => {
  it('logs nothing until it is called', () => {
    const lines: string[] = [];
    createFollowDisabledNotice((line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('logs once however many selections are dropped', () => {
    // The app announces on every cursor move; a line per announcement would
    // bury the output channel.
    const lines: string[] = [];
    const note = createFollowDisabledNotice((line) => lines.push(line));
    for (let i = 0; i < 50; i += 1) note();
    expect(lines).toEqual([FOLLOW_DISABLED_NOTICE]);
  });

  it('names the setting that turns it on and says who does not receive selections', () => {
    expect(FOLLOW_DISABLED_NOTICE).toContain('edacrux.crossProbe.followWaveformSelection');
    expect(FOLLOW_DISABLED_NOTICE).toContain('Other extensions in this window do not receive');
  });

  it('carries no em dash', () => {
    expect(FOLLOW_DISABLED_NOTICE).not.toContain('—');
  });
});
