// Copyright 2026 Ferrite Engineering LLC
// SPDX-License-Identifier: Apache-2.0

// Static guard: this repository points at nothing a reader cannot open.
//
// WHY THIS EXISTS
//
// crux-vscode goes public at the open-core flip. From that moment its readers
// are whoever installs the extensions: they have this repository, the four
// open-core products, `crux-shared`, the published pages on edacrux.app and
// each product's docs site, and nothing else. A comment that cites a section
// of an unpublished plan, a build script that says "the sibling
// `<product>-pro/<product>` checkout", or a test named after a row in an
// internal tracker is a dead end for every one of them — and a quiet
// disclosure of how the closed half of the suite is laid out.
//
// All three shapes were really here. This repository's own history carries a
// plan-section citation into the planning repository, a CI step that names a
// `<product>-pro/<product>` sibling directory, and a source-of-truth comment
// pointing at the closed telemetry Worker. The working tree was cleaned by
// hand in one commit; nothing stopped it coming back. This is what stops it.
//
// THE RULE
//
// State the reason in place, or cite something the reader can open: a file in
// this repository, a page on edacrux.app (the CXP specification is
// `https://edacrux.app/cxp`), or a product's published docs site.
//
// WHAT IS SCANNED
//
// Every file `git ls-files` reports: TypeScript, tests, READMEs, l10n
// bundles, `package.json` manifests, workflows and tool scripts, comments and
// string literals alike. A Marketplace listing is read by more people than
// any source file here, so it is held to the same bar. Skipped: this file
// (its rule table necessarily spells every pattern out), files whose first
// bytes are not text, and files over MAX_BYTES.
//
// THE ALLOWLIST
//
// ALLOWLIST names one exact path and the exact rules it is exempt from, with
// the reason. It is empty by design, and an entry that stops matching
// anything fails the run, so it cannot rot into a set of standing holes.
//
// WHY THE PATTERNS READ ODDLY
//
// This file goes public with the repository, and a rule table that spells out
// every private repository's name IS the disclosure it exists to prevent — a
// list of unannounced products, published in a regex. So each sensitive
// literal is broken by a regex construct that still matches it:
// `crux-upd(?:ates)` matches the update Worker's repository name, but a
// search of this file for that name finds nothing. The planted samples below
// are assembled from fragments for the same reason — a string literal would
// re-publish what the pattern hides. This file is excluded from its own scan
// anyway, but that exclusion exists so the rules do not match themselves, not
// as permission to publish the list.
//
// HOW IT RUNS
//
//     node --test tool/no-private-references.test.mjs
//
// node:test and node:assert are built in, so this guard adds no dependency to
// a repository whose lockfile is itself a supply-chain surface.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/** Files above this are bundled or generated payloads, not prose. */
const MAX_BYTES = 1024 * 1024;

/** This file. Excluded: its rule table spells out every pattern it rejects. */
const SELF = 'tool/no-private-references.test.mjs';

/**
 * Path prefixes that are not this repository's own text.
 *
 * Empty today. `packages/*\/media/` (the staged Flutter web payload) and
 * `node_modules/` are already untracked, so `git ls-files` never offers them.
 */
const SKIPPED_PREFIXES = [];

const RULES = [
  // ── Private repositories, by path or by name ──────────────────────────────
  // The planning repository, as a path. `edacrux.app/` is the public site and
  // `edacrux-edu-packs` is a public repository; neither contains that path,
  // so neither matches.
  { name: 'private-repo', pattern: /(?<![\w.:/@-])edacr(?:ux)\// },
  { name: 'private-repo', pattern: /Ferrite-Engineering\/edacr(?:ux)(?![\w-])/ },
  // The Pro overlay as a CONCEPT is public and fine to describe ("the Pro
  // overlay adds waiver management"). Its repository name and paths are not.
  {
    name: 'private-repo',
    pattern: /\b(?:wave|net|lint|sim)crux-pr(?:o)\b|<product>-pr(?:o)\b|\*-pr(?:o)\b/i,
  },
  {
    name: 'private-repo',
    pattern:
      /\b(?:wave|net|lint|sim|eda)crux-web(?:site)\b|\bferrite-web(?:site)\b|\*-web(?:site)\b/i,
  },
  // The backend services and the unannounced products. Broken literals: see
  // WHY THE PATTERNS READ ODDLY above.
  {
    name: 'private-repo',
    pattern:
      /\bcrux-upd(?:ates)\b|\bcrux-comm(?:erce)\b|\bwavecrux-upd(?:ates)\b|\bpulse(?:crux)\b|\bann(?:eal)\b|\bvcd_pars(?:er)\b/i,
  },
  // The beta repositories close at the open-core flip: they are the beta
  // cohort's public record, and archived-then-private is a 404 to anyone who
  // follows a link into one.
  {
    name: 'private-repo',
    pattern: /\b(?:wave|net|lint|sim)crux-bet(?:a)\b/i,
  },
  {
    name: 'private-repo',
    pattern:
      /\b(?:private|separate|closed[- ]source) (?:planning|docs|documentation) repo/i,
  },
  // ── Unpublished planning documents ────────────────────────────────────────
  {
    name: 'private-plan',
    pattern:
      /\b(?:project|suite|strategic|ecosystem|business|product|commercial[-_ ]launch|editor[-_ ]integration|VSCode pack|ISA pack|launch)[-_ ]plan\b|SUITE_PROJECT_PL(?:AN)|COMMERCIAL_LAUNCH_PL(?:AN)|ECOSYSTEM_PL(?:AN)|\bplan §/i,
  },
  {
    name: 'private-plan',
    pattern:
      /\bconsistency[-_ ]charter\b|\bcharter §|\bexecution[- ]prompts?\b|\bsuite-backlog\b|\bimplementation-history\b/i,
  },
  // ── Roadmap phases: they number a plan the reader does not have ───────────
  { name: 'plan-phase', pattern: /\bPhase[ -](?:\d+[a-z]?(?:\.\d+)*|[A-C]\d?)\b/ },
  // ── Tracker identifiers ───────────────────────────────────────────────────
  {
    name: 'tracking-id',
    pattern:
      /\bWS-[A-H]\b|\bWS\d\b|\b[Pp]rompt [A-Z]?\d+(?:\.\d+)?\b|\bR-CS\d+\b|\bCS\d{1,2}\b|§[A-Z]\d\b|\bIssue-\d+\b|\bF-\d{2,3}\b|\(P\d{1,3}\)/,
  },
  {
    name: 'tracking-id',
    pattern:
      /\bCross-Probe Increment\b|\bcampaign item\b|\bruling [A-Z]\d+\b|\bconsistency (?:pass|ruling)\b|\baudit-remediation\b/i,
  },
];

/**
 * Exact path → the rules it is exempt from, and why.
 *
 * Empty on purpose. An entry is for a public name that happens to match a
 * rule — the shipped `lintcrux-pro` command-line tool named in a page that
 * documents invoking it, say — never for a reference that could be restated.
 * Shape:
 *
 *     'docs/cli.md': { rules: ['private-repo'], reason: 'the shipped tool' },
 */
const ALLOWLIST = {};

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Every (rule, line, matched text) in `text`. */
function scan(text) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      // A fresh global clone per line: the rule literals are not global, so
      // `matchAll` would throw, and a shared global regex carries lastIndex
      // between lines.
      const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
      for (const match of lines[i].matchAll(global)) {
        findings.push({ rule: rule.name, line: i + 1, text: match[0].trim() });
      }
    }
  }
  return findings;
}

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => p.length > 0)
    .filter((p) => p !== SELF)
    .filter((p) => !SKIPPED_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

/** The file's text, or null for a binary or an oversized payload. */
function readText(relative) {
  const absolute = path.join(repoRoot, relative);
  let size;
  try {
    size = statSync(absolute).size;
  } catch {
    return null;
  }
  if (size > MAX_BYTES) return null;
  const bytes = readFileSync(absolute);
  const probe = Math.min(bytes.length, 8000);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) return null;
  return bytes.toString('utf8');
}

// ── The scan ─────────────────────────────────────────────────────────────────

test('tracked files name no private repository, plan or tracking id', () => {
  const files = trackedTextFiles();
  assert.ok(
    files.length > 100,
    `git ls-files returned ${files.length} files; the checkout or root changed`,
  );

  const findings = [];
  for (const relative of files) {
    const text = readText(relative);
    if (text === null) continue;
    const exempt = ALLOWLIST[relative]?.rules ?? [];
    for (const finding of scan(text)) {
      if (exempt.includes(finding.rule)) continue;
      findings.push(`${relative}:${finding.line} [${finding.rule}] ${finding.text}`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    'A file in this repository references something only the private side of ' +
      'the suite can open. Name the Pro overlay as "the Pro overlay", link a ' +
      'public specification by its URL, and state the reason inline instead ' +
      'of pointing at a plan section, a phase, or a work-stream, prompt or ' +
      `audit id:\n${findings.join('\n')}`,
  );
});

test('every allowlist entry still exempts a real finding', () => {
  const stale = [];
  for (const [relative, allowance] of Object.entries(ALLOWLIST)) {
    const text = readText(relative);
    const hits =
      text === null ? [] : scan(text).filter((f) => allowance.rules.includes(f.rule));
    if (hits.length === 0) stale.push(`${relative} (${allowance.reason})`);
  }
  assert.deepEqual(
    stale,
    [],
    `These allowlist entries exempt nothing any more — delete them:\n${stale.join('\n')}`,
  );
});

// ── The rules themselves ─────────────────────────────────────────────────────
//
// A guard whose patterns have rotted into ones that match nothing passes
// silently and forever. These samples are the readable specification of what
// each rule is for, and they are written out in full because this file is
// excluded from the scan above.

test('every rule still catches what it exists to reject', () => {
  // Assembled from fragments so this public file does not itself contain the
  // names — the same reason the patterns above are written as they are.
  const planted = {
    'private-repo path': `see \`${'edacr'}ux/docs/specs/cxp-spec.md\``,
    'private-repo overlay': `the \`wavecrux${'-pro'}\` overlay registers these`,
    'private-repo placeholder': `the sibling ../<product>${'-pro'}/<product>`,
    'private-repo website': `published from simcrux${'-website'}`,
    'private-repo beta': `file it against wavecrux${'-beta'}`,
    'private-repo backend': `source of truth: crux-${'updates'}/src/index.js`,
    'private-plan': 'rationale in the editor-integration plan §7.3',
    'private-plan section': 'the suite plan §2.3 says both flip together',
    'plan-phase': 'shipped in Phase 4.15',
    'plan-phase suffix': 'board drops (Phase 3c) win',
    'tracking-id work-stream': 'the cross-probe panel (WS-B)',
    'tracking-id prompt': 'covered by prompt A8',
  };
  for (const [label, sample] of Object.entries(planted)) {
    assert.ok(
      scan(sample).length > 0,
      `no rule matches the planted ${label} sample — a pattern has rotted: ${sample}`,
    );
  }
});

test('public references stay allowed', () => {
  const clean = [
    'CXP §9.9 (https://edacrux.app/cxp#sec-9-9)',
    'published at https://docs.wavecrux.app and https://edacrux.app/terms',
    'the closed-source Pro overlay overrides this provider',
    'the public `crux-shared` and `edacrux-edu-packs` repositories',
    'https://github.com/Ferrite-Engineering/edacrux-edu-packs',
    'install from the Visual Studio Marketplace or Open VSX',
    'a two-phase commit is not what this does',
    'Wishbone B4 §3.1.3 and GitHub issue #44',
    'set crux.wavecrux.peerPort in your workspace settings',
  ];
  for (const line of clean) {
    const hits = scan(line);
    assert.deepEqual(
      hits.map((h) => h.rule),
      [],
      `public text wrongly rejected: ${line}`,
    );
  }
});
