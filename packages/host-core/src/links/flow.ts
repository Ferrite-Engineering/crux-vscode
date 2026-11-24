/**
 * What happens to a link, in order, whichever way it arrived.
 *
 * 1. Rewritten to the desktop form (`rewrite.ts`) and parsed by the product's
 *    one parser. A refusal opens nothing and says so.
 * 2. The file it names is vetted (`target.ts`): absolute, local, of a kind a
 *    link may open, there, a regular file, as named and once links resolve.
 * 3. A file not open in a tab is confirmed by the user first. Cancel opens
 *    nothing.
 * 4. The product opens the **resolved** path (or the open tab that is the same
 *    file) and places what the link names.
 *
 * Nothing is opened in place of what the link names, and nothing is run: the
 * products open files in an editor panel and never start a program for a link.
 * This module holds the order; every step is a dependency, so each refusal is
 * tested on its own and the product adapters stay thin.
 */
import { basename } from 'node:path';
import type { DesktopLinkRewrite } from './rewrite';
import type { LinkTargetResult } from './target';

/** What the user is told when a link is refused. */
export type CruxLinkNotice =
  /** The link is not one this product reads. One sentence for every grammar refusal. */
  | { readonly kind: 'invalid' }
  /** The file is not a full local path: relative, a network or device path. */
  | { readonly kind: 'path' }
  /** The file is not one a link may open. */
  | { readonly kind: 'wrong-kind'; readonly fileName: string }
  /** The file is not there. */
  | { readonly kind: 'not-found'; readonly fileName: string };

/** How a link ended. */
export type CruxLinkOutcome =
  | { readonly kind: 'refused'; readonly stage: 'parse' | 'target'; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly path: string }
  | { readonly kind: 'opened'; readonly path: string; readonly confirmed: boolean };

/** A parser's answer. */
export type CruxLinkParse<L> =
  | { readonly ok: true; readonly link: L }
  | { readonly ok: false; readonly refusal: string };

/** One product's steps. */
export interface CruxLinkFlow<L extends { readonly file: string }> {
  /** The product's parser over the desktop form. */
  readonly parse: (link: string) => CruxLinkParse<L>;
  /** The product's file check (`vetLinkTarget` with its extensions). */
  readonly vet: (file: string) => Promise<LinkTargetResult>;
  /** The open tab holding the same file as [resolved], if any (`findOpenedPath`). */
  readonly openTabPath: (resolved: string) => Promise<string | undefined>;
  /** Ask the user. Resolves true only for an explicit Open. */
  readonly confirm: (resolved: string) => Promise<boolean>;
  /** Open [path] and place what [link] names. */
  readonly open: (path: string, link: L) => Promise<void>;
  /** Tell the user why nothing opened. */
  readonly notify: (notice: CruxLinkNotice) => void;
  /** The output channel. */
  readonly log?: (line: string) => void;
}

/** Parse refusals the user is told about as a path problem, not as an invalid link. */
const PATH_REFUSALS: ReadonlySet<string> = new Set(['relative-path']);

/**
 * Run [rewrite] (the link in the desktop form, or why there is none) through
 * [flow]. Never throws: a failure in the product's open is logged, since the
 * file is already open by then and the product has said what it could.
 */
export async function openCruxLink<L extends { readonly file: string }>(
  rewrite: DesktopLinkRewrite,
  flow: CruxLinkFlow<L>,
): Promise<CruxLinkOutcome> {
  const log = flow.log ?? ((): void => {});
  if (!rewrite.ok) {
    log(`   link: refused (${rewrite.refusal})`);
    flow.notify({ kind: 'invalid' });
    return { kind: 'refused', stage: 'parse', reason: rewrite.refusal };
  }
  const parsed = flow.parse(rewrite.link);
  if (!parsed.ok) {
    log(`   link: refused (${parsed.refusal})`);
    flow.notify(PATH_REFUSALS.has(parsed.refusal) ? { kind: 'path' } : { kind: 'invalid' });
    return { kind: 'refused', stage: 'parse', reason: parsed.refusal };
  }
  const link = parsed.link;
  const target = await flow.vet(link.file);
  if (!target.ok) {
    log(`   link: file refused (${target.refusal})`);
    const fileName = basename(link.file.replace(/\\/g, '/'));
    switch (target.refusal) {
      case 'path-refused':
        flow.notify({ kind: 'path' });
        break;
      case 'wrong-kind':
        flow.notify({ kind: 'wrong-kind', fileName });
        break;
      case 'file-not-found':
        flow.notify({ kind: 'not-found', fileName });
        break;
    }
    return { kind: 'refused', stage: 'target', reason: target.refusal };
  }
  const openTab = await flow.openTabPath(target.path);
  let confirmed = false;
  if (openTab === undefined) {
    if (!(await flow.confirm(target.path))) {
      log('   link: cancelled by the user');
      return { kind: 'cancelled', path: target.path };
    }
    confirmed = true;
  }
  const path = openTab ?? target.path;
  try {
    await flow.open(path, link);
  } catch (error) {
    log(`   link: open failed (${String(error)})`);
  }
  log(`   link: opened${confirmed ? ' after confirmation' : ' (already open)'}`);
  return { kind: 'opened', path, confirmed };
}
