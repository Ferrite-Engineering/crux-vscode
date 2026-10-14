import { describe, expect, it } from 'vitest';
import {
  MANAGE_WORKSPACE_TRUST_COMMAND,
  hintIfUntrusted,
  manageTrustLabel,
  requireTrustToRun,
  trustRequiredToRunMessage,
  type TrustHost,
} from '../src/trust';

function fakeHost(
  trusted: boolean,
  answer: string | undefined = undefined,
): { host: TrustHost; shown: { message: string; actions: readonly string[] }[]; managed: number[] } {
  const shown: { message: string; actions: readonly string[] }[] = [];
  const managed: number[] = [];
  const host: TrustHost = {
    isTrusted: () => trusted,
    showWarning: (message, ...actions) => {
      shown.push({ message, actions });
      return Promise.resolve(answer);
    },
    manageTrust: () => {
      managed.push(1);
      return Promise.resolve();
    },
  };
  return { host, shown, managed };
}

describe('requireTrustToRun', () => {
  it('lets a trusted workspace run, without saying anything', async () => {
    const { host, shown } = fakeHost(true);
    expect(await requireTrustToRun(host)).toBe(true);
    expect(shown).toEqual([]);
  });

  it('refuses an untrusted workspace and says why, instead of doing nothing', async () => {
    const { host, shown } = fakeHost(false);
    expect(await requireTrustToRun(host)).toBe(false);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.message).toBe(trustRequiredToRunMessage());
    expect(shown[0]?.message).toContain('trusted folder');
    expect(shown[0]?.actions).toEqual([manageTrustLabel()]);
  });

  it('opens the trust editor when the user asks, and still refuses the run', async () => {
    const { host, managed } = fakeHost(false, manageTrustLabel());
    expect(await requireTrustToRun(host)).toBe(false);
    expect(managed).toHaveLength(1);
  });

  it('does not open the trust editor when the message is dismissed', async () => {
    const { host, managed } = fakeHost(false, undefined);
    await requireTrustToRun(host);
    expect(managed).toEqual([]);
  });

  it('reads trust live, so a folder trusted later runs', async () => {
    let trusted = false;
    const host: TrustHost = { ...fakeHost(false).host, isTrusted: () => trusted };
    expect(await requireTrustToRun(host)).toBe(false);
    trusted = true;
    expect(await requireTrustToRun(host)).toBe(true);
  });
});

describe('hintIfUntrusted', () => {
  it('says nothing in a trusted workspace', () => {
    const { host, shown } = fakeHost(true);
    expect(hintIfUntrusted(host, { hasProject: true })).toBe(false);
    expect(shown).toEqual([]);
  });

  it('says nothing in an untrusted folder that has no SimCrux project', () => {
    const { host, shown } = fakeHost(false);
    expect(hintIfUntrusted(host, { hasProject: false })).toBe(false);
    expect(shown).toEqual([]);
  });

  it('tells the user in an untrusted folder that has one', () => {
    const { host, shown } = fakeHost(false);
    expect(hintIfUntrusted(host, { hasProject: true })).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.message).toBe(trustRequiredToRunMessage());
  });
});

describe('the message', () => {
  it('names the fix and uses no em dash', () => {
    expect(trustRequiredToRunMessage()).toMatch(/trust/i);
    expect(trustRequiredToRunMessage()).not.toContain('—');
    expect(manageTrustLabel()).not.toContain('—');
  });

  it('opens the command VSCode registers for the trust editor', () => {
    expect(MANAGE_WORKSPACE_TRUST_COMMAND).toBe('workbench.trust.manage');
  });
});
