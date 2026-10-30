#!/usr/bin/env node
// Builds the NetCrux Flutter web viewer and stages a pruned copy into
// packages/netcrux/media/netcrux-web/, which the extension serves to its
// webview and `vsce package` folds into the VSIX.
//
// The staged directory is a build artifact: it is gitignored, and this script
// is the only thing that writes it. `pnpm --filter netcrux run package` depends
// on it (see that package's "package" script).
//
// The same pattern as tool/build-wavecrux-web.mjs (docs/webview-hosting.md),
// with the differences this viewer has:
//
//   * The layout engine is a WebAssembly module in a Web Worker
//     (web/wasm/elk_wasm_{worker.js,.js,_bg.wasm}), built from Rust by
//     `dart run tool/build_web_wasm.dart`. It is built here, every full run, so
//     the staged engine is never older than the Dart that starts it.
//   * The page shim starts that worker from a blob, because a webview cannot
//     start a worker from its resource origin (docs/webview-hosting.md §7), so
//     the three files are staged as they are and the shim composes the worker.
//
// WHY THE FLAGS (docs/webview-hosting.md §1): --no-web-resources-cdn keeps
// CanvasKit off the gstatic CDN, --pwa-strategy=none keeps the service worker
// out (it cannot run under vscode-webview://), --release is dart2js output a
// strict script-src can run.
//
// WHERE THE SOURCE COMES FROM: a checkout of the open-core NetCrux app,
// github.com/Ferrite-Engineering/netcrux. CRUX_NETCRUX_REPO names it; otherwise
// a sibling ../netcrux next to this repository is used.
//
// THE STALE-PAYLOAD GUARD: nothing compares a staged build with its checkout,
// so a VSIX packaged over an old staging silently ships an old viewer. `--check`
// therefore also reads the staged `main.dart.js` for the strings the editor-host
// bridge is made of: a viewer built before the bridge existed, or with it
// renamed, fails the check instead of rendering a start screen with no document.
// What it cannot know is whether the checkout has moved on since; the staged
// `payload-info.json` records the commit and version the payload came from, and
// the full build is the only thing that refreshes it.
//
// Usage: node tool/build-netcrux-web.mjs [--skip-flutter] [--check]
//   --skip-flutter  restage from an existing build/web without invoking Flutter
//   --check         report whether the staged payload looks complete and current
//                   enough to package; exit 1 if not

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const stageDir = path.join(repoRoot, 'packages', 'netcrux', 'media', 'netcrux-web');

const skipFlutter = process.argv.includes('--skip-flutter');
const checkOnly = process.argv.includes('--check');

/** Where the open-core NetCrux repo is checked out. */
function resolveSourceRepo() {
  const fromEnv = process.env.CRUX_NETCRUX_REPO;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(repoRoot, '..', 'netcrux');
}

// Everything the webview loads, and nothing else: an allowlist of top-level
// entries plus a per-file predicate, so a future Flutter release that starts
// emitting something new is left out until somebody decides it belongs. The
// failure mode is a visible 404 in the page's diagnostics, not a fatter VSIX.
const TOP_LEVEL_KEEP = new Set([
  'assets', // AssetManifest.bin, fonts, shaders, NOTICES
  'canvaskit', // filtered below
  'main.dart.js',
  'flutter.js', // the loader; the page drives it directly
  // flutter_bootstrap.js is deliberately NOT staged: the page never runs it, and
  // a second entry point that would start Flutter with the wrong resource base
  // is an invitation to a very confusing bug. Its one useful part,
  // `_flutter.buildConfig`, is extracted below.
  'wasm', // the layout engine; filtered below
  'version.json',
]);

// Within canvaskit/: only the variant this build can reach (the dart2js build's
// single entry is {renderer: canvaskit}; the loader appends `chromium/` when the
// browser has Chromium break iterators and ImageDecoder, which an Electron
// webview always has).
const CANVASKIT_KEEP = new Set(['chromium/canvaskit.js', 'chromium/canvaskit.wasm']);

// Within wasm/: exactly the three files the page composes the worker from.
const WASM_KEEP = new Set(['elk_wasm.js', 'elk_wasm_bg.wasm', 'elk_wasm_worker.js']);

/** Debug symbol maps: megabytes of them, never fetched at runtime. */
function isDroppedFile(relative) {
  return relative.endsWith('.symbols') || relative.endsWith('.map');
}

function copyFiltered(sourceRoot, targetRoot) {
  let bytes = 0;
  let files = 0;

  const walk = (relativeDir) => {
    const absoluteDir = path.join(sourceRoot, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (relativeDir === '' && !TOP_LEVEL_KEEP.has(entry.name)) continue;
      if (relative.startsWith('canvaskit/')) {
        const inside = relative.slice('canvaskit/'.length);
        if (entry.isDirectory()) {
          if (![...CANVASKIT_KEEP].some((keep) => keep.startsWith(`${inside}/`))) continue;
        } else if (!CANVASKIT_KEEP.has(inside)) {
          continue;
        }
      }
      if (relative.startsWith('wasm/') && !entry.isDirectory()) {
        if (!WASM_KEEP.has(relative.slice('wasm/'.length))) continue;
      }
      if (entry.isDirectory()) {
        walk(relative);
        continue;
      }
      if (isDroppedFile(relative)) continue;
      const from = path.join(sourceRoot, relative);
      const to = path.join(targetRoot, relative);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
      bytes += statSync(from).size;
      files += 1;
    }
  };

  walk('');
  return { bytes, files };
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Name of the file [extractBuildConfig] writes into the staged directory. */
const BUILD_CONFIG_FILE = 'flutter-build-config.json';

/** Name of the file recording where the payload came from. */
const PAYLOAD_INFO_FILE = 'payload-info.json';

/**
 * Lift `_flutter.buildConfig` out of the generated `flutter_bootstrap.js`. The
 * page cannot run that file: it ends with a bare `_flutter.loader.load()`, and
 * the page must pass `config` (asset and CanvasKit base URLs) into that call. The
 * config carries the engine revision, so it is extracted per build, not hardcoded.
 */
function extractBuildConfig(buildWeb, targetRoot) {
  const bootstrap = readFileSync(path.join(buildWeb, 'flutter_bootstrap.js'), 'utf8');
  const match = /_flutter\.buildConfig\s*=\s*(\{[\s\S]*?\});/.exec(bootstrap);
  if (match === null) {
    console.error('[netcrux-web] could not find _flutter.buildConfig in flutter_bootstrap.js');
    console.error('Flutter changed its bootstrap shape; update tool/build-netcrux-web.mjs.');
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(match[1]);
  } catch (error) {
    console.error(`[netcrux-web] _flutter.buildConfig is not JSON: ${error.message}`);
    process.exit(1);
  }
  const renderers = (config.builds ?? []).map((b) => b.renderer).filter(Boolean);
  writeFileSync(path.join(targetRoot, BUILD_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`[netcrux-web] build config: renderer(s) ${renderers.join(', ') || '(none)'}`);
  if (config.useLocalCanvasKit !== true) {
    console.error('[netcrux-web] useLocalCanvasKit is not true: was --no-web-resources-cdn dropped?');
    process.exit(1);
  }
  return config;
}

const REQUIRED = [
  'main.dart.js',
  'flutter.js',
  BUILD_CONFIG_FILE,
  'canvaskit/chromium/canvaskit.js',
  'canvaskit/chromium/canvaskit.wasm',
  'assets/AssetManifest.bin',
  'assets/fonts/fallback/Roboto-Regular.ttf',
  'wasm/elk_wasm.js',
  'wasm/elk_wasm_bg.wasm',
  'wasm/elk_wasm_worker.js',
];

/**
 * Strings the staged viewer must contain, each a name the extension's page
 * shim and the viewer agree on (packages/netcrux/src/preview/messages.ts). A
 * viewer without them boots, draws its start screen and never shows the
 * document, which no other gate would notice.
 */
const BRIDGE_STRINGS = [
  ['main.dart.js', 'cruxEditorHost'],
  ['main.dart.js', 'cruxHostBridge'],
  ['main.dart.js', 'cruxLayoutWorkerUrl'],
  ['main.dart.js', 'crux.netcrux'],
  ['main.dart.js', 'open_netlist'],
  ['main.dart.js', 'open_source'],
  // The worker and the glue must compose into one module (see html.ts): the
  // worker must read the hosted resources, and the two must not both declare
  // the glue's export as a top-level name.
  ['wasm/elk_wasm_worker.js', 'cruxLayoutHosted'],
  ['wasm/elk_wasm.js', 'export function layoutJsonWithProgress'],
  ['wasm/elk_wasm.js', 'async function __wbg_init'],
];

function check() {
  const missing = REQUIRED.filter((file) => !existsSync(path.join(stageDir, file)));
  if (missing.length > 0) {
    console.error(`[netcrux-web] staged payload incomplete at ${stageDir}`);
    for (const file of missing) console.error(`  missing: ${file}`);
    console.error('Run: node tool/build-netcrux-web.mjs');
    process.exit(1);
  }
  const lacking = BRIDGE_STRINGS.filter(
    ([file, needle]) => !readFileSync(path.join(stageDir, file), 'utf8').includes(needle),
  );
  if (lacking.length > 0) {
    console.error(`[netcrux-web] staged payload is stale or foreign: ${stageDir}`);
    for (const [file, needle] of lacking) console.error(`  ${file} does not contain "${needle}"`);
    console.error('The viewer in it predates the editor-host bridge. Run: node tool/build-netcrux-web.mjs');
    process.exit(1);
  }
  const workerSource = readFileSync(path.join(stageDir, 'wasm/elk_wasm_worker.js'), 'utf8');
  if (/^(?:let|const|var|function)\s+layoutJsonWithProgress\b/m.test(workerSource)) {
    console.error('[netcrux-web] elk_wasm_worker.js declares layoutJsonWithProgress at top level;');
    console.error('it collides with the glue once the page composes them into one module.');
    process.exit(1);
  }
  let info = '(no payload-info.json)';
  if (existsSync(path.join(stageDir, PAYLOAD_INFO_FILE))) {
    const parsed = JSON.parse(readFileSync(path.join(stageDir, PAYLOAD_INFO_FILE), 'utf8'));
    info = `NetCrux ${parsed.version} @ ${parsed.commit}${parsed.dirty ? ' (uncommitted changes)' : ''}`;
  }
  console.log(`[netcrux-web] staged payload OK: ${info} (${stageDir})`);
}

/** Run [command] in [cwd], failing the build when it fails. */
function run(command, args, cwd) {
  console.log(`[netcrux-web] ${command} ${args.join(' ')}  (cwd: ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[netcrux-web] ${command} ${args.join(' ')} failed`);
    process.exit(result.status ?? 1);
  }
}

/** `git` output in [cwd], or undefined. */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

if (checkOnly) {
  check();
} else {
  const sourceRepo = resolveSourceRepo();
  if (!existsSync(path.join(sourceRepo, 'pubspec.yaml'))) {
    console.error(`[netcrux-web] no NetCrux checkout at ${sourceRepo}`);
    console.error(
      'Clone https://github.com/Ferrite-Engineering/netcrux next to this repository, ' +
        'or set CRUX_NETCRUX_REPO to the path of a NetCrux checkout.',
    );
    process.exit(1);
  }

  // The payload compiles kBetaPeriod from the crux-shared the NetCrux checkout
  // pins. Refuse a payload whose version disagrees with that flag (a 1.x
  // payload with the beta still on would ship every paid feature free), using
  // NetCrux's own release gate. A checkout too old to carry the gate fails closed.
  const gate = path.join(sourceRepo, 'scripts', 'check_beta_period.sh');
  if (!existsSync(gate)) {
    console.error(`[netcrux-web] ${gate} is missing; the NetCrux checkout predates the beta-flag gate.`);
    process.exit(1);
  }
  run('bash', [gate], sourceRepo);

  if (!skipFlutter) {
    // The same preparation the web deploy does (scripts/deploy_web.sh): the
    // generated providers and strings are not committed, and the layout engine
    // is a Rust build, so none of them can be assumed fresh.
    run('flutter', ['pub', 'get'], sourceRepo);
    run('dart', ['run', 'build_runner', 'build', '--delete-conflicting-outputs'], sourceRepo);
    run('flutter', ['gen-l10n'], sourceRepo);
    run('dart', ['run', 'tool/build_web_wasm.dart'], sourceRepo);
    run(
      'flutter',
      ['build', 'web', '--release', '--no-web-resources-cdn', '--pwa-strategy=none'],
      sourceRepo,
    );
  }

  const buildWeb = path.join(sourceRepo, 'build', 'web');
  if (!existsSync(buildWeb)) {
    console.error(`[netcrux-web] no build output at ${buildWeb}`);
    process.exit(1);
  }

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const { bytes, files } = copyFiltered(buildWeb, stageDir);
  extractBuildConfig(buildWeb, stageDir);

  const version = JSON.parse(readFileSync(path.join(buildWeb, 'version.json'), 'utf8')).version;
  writeFileSync(
    path.join(stageDir, PAYLOAD_INFO_FILE),
    `${JSON.stringify(
      {
        version,
        commit: git(['rev-parse', 'HEAD'], sourceRepo) ?? 'unknown',
        dirty: (git(['status', '--porcelain'], sourceRepo) ?? '').length > 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(
    `[netcrux-web] staged ${files} file(s), ${humanSize(bytes)} -> ${path.relative(repoRoot, stageDir)}`,
  );
  check();
}
