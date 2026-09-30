/**
 * cross-probe/ — the window's cross-probe state, as a product surface's
 * panel wants to see it, plus the one directed-send entry point.
 *
 * See `cross-probe-host.ts` for why this is host-core's and not WaveCrux's.
 */
export {
  CROSS_PROBE_OFFLINE,
  CrossProbeHost,
  crossProbePeerLabel,
  type CrossProbeHostOptions,
  type CrossProbeSelection,
  type CrossProbeSendOutcome,
  type CrossProbeSnapshot,
} from './cross-probe-host';
export {
  appendCrossProbeEvent,
  CROSS_PROBE_EVENT_LIMIT,
  CROSS_PROBE_LOGGED_INBOUND_KINDS,
  CROSS_PROBE_PEER_CONNECTED,
  CROSS_PROBE_PEER_DISCONNECTED,
  type CrossProbeEventRecord,
} from './events';
export {
  reasonCrossProbeUnavailable,
  reasonPeerNotConnected,
  reasonPeerUnknown,
} from './strings';
