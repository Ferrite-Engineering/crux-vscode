/**
 * Name resolution: GTKWave stems parsing and the bidirectional name index.
 *
 * The question this module answers, in both directions:
 *
 * - *design path → file + line* — where is `top.cpu.alu.result` declared?
 *   What `request_open_source` and "jump to declaration" need.
 * - *file + line + identifier → design path(s)* — what is this thing I have
 *   selected, in the peer's vocabulary? What "show this in WaveCrux" needs,
 *   and what RTL annotation needs per **visible line**
 *   rather than per request.
 *
 * Both directions exist from the first commit because the second one cannot
 * be retrofitted onto an index built for the first without a scan — see
 * `name-index.ts` for the data structure and why a visible-range query is a
 * handful of hash lookups.
 *
 * Ambiguity is answered with **every** candidate, ordered deterministically
 * and labelled with how it was found. One identifier under four
 * instantiations is four correct answers; the caller asks the user, and the
 * label is how the user learns that a stems file would have made it exact.
 *
 * See docs/implementation-map.md §2 (`names/*`) and §6.
 */
export {
  DEFAULT_STEMS_PARSE_LIMITS,
  StemsEntryKind,
  localNameOf,
  parseStems,
  stripBitRange,
  type StemsEntry,
  type StemsParseLimits,
  type StemsParseOutcome,
  type StemsParseResult,
} from './stems-parser';

export {
  NameIndex,
  isExactMatch,
  type NameCandidate,
  type NameMatchOrigin,
  type NameQuery,
  type SourceLocation,
} from './name-index';

export {
  MAX_HIERARCHY_CANDIDATES,
  emptyHierarchyProvider,
  hierarchyCandidates,
  type DesignHierarchyProvider,
} from './hierarchy';

export {
  NameResolver,
  describeCandidate,
  type NameResolverOptions,
  type ResolvedSourceLocation,
  type SourceLocationRefusal,
} from './resolver';

export {
  STEMS_GLOB,
  StemsIndexService,
  timerScheduler,
  vscodeStemsFileSize,
  vscodeStemsReader,
  vscodeStemsWatcher,
  type Scheduler,
  type StemsFileChange,
  type StemsFileChangeType,
  type StemsFileWatcher,
  type StemsIndexServiceOptions,
  type StemsIndexUpdate,
} from './stems-index-service';

export { fromStemsDescription, nameMatchDescription } from './strings';
