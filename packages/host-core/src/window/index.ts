/**
 * `window/` — one VSCode window, one EDACrux peer.
 *
 * The four product extensions share a process but not a module instance
 * (esbuild bundles host-core into each VSIX separately), so every
 * window-level singleton has to be *elected* rather than constructed. This
 * module is that election and the thing it elects:
 *
 * - `api.ts` — the [CruxWindowApi] each extension returns from `activate()`;
 * - `election.ts` — how the one host is chosen, deterministically;
 * - `window-host.ts` — the singletons: the surface registry, the CXP peer,
 *   the inbound editor dispatcher, the status bar, the `edacrux.*` commands;
 * - `join.ts` — [joinCruxWindow] / [deactivateCruxWindow], the two calls a
 *   product extension makes;
 * - `trust.ts` — what each extension declares for
 *   `capabilities.untrustedWorkspaces`, and what a restricted workspace
 *   therefore does to the election.
 *
 * See `docs/implementation-map.md` §6d.
 */
export {
  CRUX_WINDOW_API_VERSION,
  isCruxWindowApi,
  type CruxWindowApi,
  type CruxWindowContribution,
  type CruxWindowCrossProbe,
} from './api';

export {
  CRUX_WINDOW_HOST_ORDER,
  activeWindowHostApi,
  electCruxWindowRole,
  readWindowApi,
  type CruxWindowElectionOptions,
  type CruxWindowRole,
  type ExtensionHandle,
  type ExtensionRegistryView,
} from './election';

export {
  CRUX_RESTRICTED_CONFIGURATIONS,
  CRUX_RESTRICTED_MODE_HOST_ORDER,
  CRUX_RESTRICTED_MODE_PRODUCTS,
  CRUX_UNTRUSTED_WORKSPACE_SUPPORT,
  type CruxUntrustedWorkspaceSupport,
} from './trust';

export {
  CXP_WINDOW_PEER_START_DELAY_MS,
  CruxWindowHost,
  type CruxWindowHostOptions,
} from './window-host';

export {
  deactivateCruxWindow,
  joinCruxWindow,
  type CruxWindowJoinOptions,
  type CruxWindowMembership,
} from './join';
