import { describe, expect, it } from 'vitest';
import {
  desktopAdvertisingDecision,
  desktopHandoffCommandId,
} from '../../src/desktop-detect/advertising';

describe('desktopAdvertisingDecision', () => {
  it('advertises when no desktop peer is present', () => {
    expect(desktopAdvertisingDecision('wavecrux', false)).toEqual({ advertise: true });
  });

  it('suppresses advertising and names the handoff command when a peer is present', () => {
    expect(desktopAdvertisingDecision('wavecrux', true)).toEqual({
      advertise: false,
      handoffCommandId: desktopHandoffCommandId('wavecrux'),
    });
  });

  it('the handoff command id is host-core-owned (edacrux.*) and distinct per product', () => {
    expect(desktopHandoffCommandId('wavecrux')).toBe('edacrux.openInDesktop.wavecrux');
    expect(desktopHandoffCommandId('lintcrux')).toBe('edacrux.openInDesktop.lintcrux');
    expect(desktopHandoffCommandId('wavecrux')).not.toBe(desktopHandoffCommandId('lintcrux'));
  });
});
