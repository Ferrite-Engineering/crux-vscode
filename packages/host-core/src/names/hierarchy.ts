import { localNameOf, stripBitRange } from './stems-parser';
import type { NameCandidate } from './name-index';

/**
 * The design hierarchy fallback, for workspaces with no stems file.
 *
 * Stems files are generated (`vermin`, `xml2stems`, a Verilator AST
 * import); most repositories do not have one checked in, and the first time
 * a user tries to cross-probe is exactly when they have not yet heard of
 * them. Refusing to resolve anything without stems would make the feature
 * appear broken. So when the index has nothing, the identifier is matched
 * against the hierarchy of the design a peer has actually loaded.
 *
 * This is a **guess** and is labelled as one (`hierarchy-name`). That
 * labelling is the point: the quick-pick that says "name match" is how a
 * user learns a stems file would have made it exact.
 */

/**
 * Source of the loaded design hierarchy.
 *
 * **A seam, deliberately not an implementation.** The real hierarchy
 * arrives over WCP as `wavecrux.getHierarchy`, and no WCP client exists in
 * host-core yet; wiring one here would couple name resolution to a
 * protocol client that is not this module's subject. Implementations are
 * injected — the fake in the tests, a WCP-backed one later.
 */
export interface DesignHierarchyProvider {
  /**
   * Full hierarchical paths of every element in the loaded design.
   *
   * **An empty list is the correct answer to "nothing is loaded".** A
   * VSCode window with no Crux app running has no hierarchy, and that is
   * an ordinary state — not an error, not a reason to show the user
   * anything. Implementations must not throw for it; [hierarchyCandidates]
   * defends against the ones that do anyway.
   */
  paths(): readonly string[] | Promise<readonly string[]>;
}

/** A provider for a window with nothing loaded. Always `[]`. */
export const emptyHierarchyProvider: DesignHierarchyProvider = {
  paths(): readonly string[] {
    return [];
  },
};

/**
 * Most hierarchy matches offered for one identifier.
 *
 * Uncapped, a query for `clk` in a large SoC returns thousands of paths
 * and the quick-pick becomes a wall. The cap is only ever reached by
 * identifiers so generic that the list was not going to be actionable
 * anyway, and it applies solely to this fallback — stems answers, which
 * are exact and few, are never truncated.
 */
export const MAX_HIERARCHY_CANDIDATES = 100;

/** Normalised comparison form: bit range dropped, case folded. */
function normalize(name: string): string {
  return stripBitRange(name.trim()).toLowerCase();
}

/**
 * Name-match [identifier] against the paths [provider] reports.
 *
 * Three ways a hierarchy path can match, all case-insensitive and all with
 * bit ranges stripped:
 *
 * 1. the whole path equals the identifier (the user selected a full dotted
 *    path, which happens in testbenches);
 * 2. the path *ends with* the identifier on a component boundary, so
 *    `cpu.alu.result` matches `top.cpu.alu.result` but `u.result` does not
 *    match `top.cpu.alu_result`;
 * 3. the path's trailing component equals the identifier — the common case,
 *    and the ambiguous one.
 *
 * Every match is returned, in codepoint order. A hierarchy with four
 * instantiations of one module produces four candidates and the caller
 * asks; picking the first would send the user to whichever instance the
 * peer happened to enumerate first, which is not a decision anyone made.
 */
export async function hierarchyCandidates(
  identifier: string,
  provider: DesignHierarchyProvider,
): Promise<readonly NameCandidate[]> {
  const wanted = normalize(identifier);
  if (wanted.length === 0) return [];

  let paths: readonly string[];
  try {
    paths = await provider.paths();
  } catch {
    // A peer that went away mid-request, a malformed WCP reply, a provider
    // that throws when nothing is loaded: all of them mean "no candidates".
    // None of them is worth surfacing — the user asked to send a selection,
    // not to hear about the hierarchy plumbing.
    return [];
  }

  const dotted = `.${wanted}`;
  // A Set: a hierarchy that lists the same path twice (a peer that merged
  // two scopes, a reload race) must not produce two identical quick-pick
  // rows the user cannot tell apart.
  const matched = new Set<string>();
  for (const path of paths) {
    const candidate = normalize(path);
    if (
      candidate === wanted ||
      candidate.endsWith(dotted) ||
      normalize(localNameOf(candidate)) === wanted
    ) {
      matched.add(path);
    }
  }

  return [...matched]
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
    .slice(0, MAX_HIERARCHY_CANDIDATES)
    .map((path) => ({ path, origin: 'hierarchy-name' }) as const);
}
