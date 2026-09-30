import { describe, expect, it } from 'vitest';
import { WAVECRUX_ARTIFACT_KIND } from '../src/status/surface';

/**
 * "Open in WaveCrux Desktop" against WaveCrux's `request_open_artifact`
 * handler; the contract is stated on [WAVECRUX_ARTIFACT_KIND]. The path half
 * — the active waveform's absolute path, published and sent by host-core's
 * `openArtifactInDesktop`, resolved by crux_cxp's store and admitted by its
 * floor — is `host-core/test/cxp/dart-interop.test.ts` ("the desktop
 * hand-off"), and WaveCrux's own `cxp_open_artifact_test.dart` holds the
 * receiving end.
 */
describe('the contract with WaveCrux’s handler', () => {
  it('hands over a `waveform` artifact — the one kind WaveCrux opens', () => {
    expect(WAVECRUX_ARTIFACT_KIND).toBe('waveform');
  });
});
