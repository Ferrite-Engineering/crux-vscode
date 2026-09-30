#!/usr/bin/env node
// Builds the WaveCrux Flutter web bundle and stages a pruned copy into
// packages/wavecrux/media/wavecrux-web/, which the extension serves to its
// webview and `vsce package` folds into the VSIX.
//
// The staged directory is a build artifact: it is gitignored, and this script
// is the only thing that writes it. `pnpm --filter wavecrux run package`
// depends on it (see that package's "package" script).
//
// WHY THE FLAGS (docs/webview-hosting.md §1):
//   --no-web-resources-cdn  CanvasKit otherwise loads from
//                           https://www.gstatic.com/flutter-canvaskit, which a
//                           webview CSP has no reason to allow. With this flag
//                           the emitted buildConfig carries
//                           `useLocalCanvasKit: true` and the loader resolves
//                           `canvaskit/` against document.baseURI instead.
//   --pwa-strategy=none     Service workers do not work under the
//                           vscode-webview:// scheme. Flutter still writes an
//                           (empty) flutter_service_worker.js; we drop it below
//                           so nothing can be tempted to register it.
//   --release               dart2js output; a debug build's eval-heavy loader
//                           would need a far laxer script-src.
//
// WHY THE PRUNE: build/web/canvaskit is ~48 MB on disk and exactly one variant
// is ever fetched. The emitted buildConfig has a single entry —
// {compileTarget: dart2js, renderer: canvaskit} — so every skwasm/wimp variant
// is unreachable for this build, and the loader picks the `chromium/`
// subdirectory whenever the browser has Chromium break iterators and
// ImageDecoder, which an Electron-hosted webview always does. That choice was
// confirmed empirically, not assumed: the webview shim reports every CanvasKit
// and .wasm URL Flutter actually fetches (the `resource` diagnostic in
// packages/wavecrux/src/webview/html.ts; docs/webview-hosting.md §5).
//
// WHERE THE SOURCE COMES FROM: a checkout of the open-core WaveCrux app,
// github.com/Ferrite-Engineering/wavecrux. CRUX_WAVECRUX_REPO names it;
// otherwise a sibling ../wavecrux next to this repository is used.
//
// Usage: node tool/build-wavecrux-web.mjs [--skip-flutter] [--check]
//   --skip-flutter  restage from an existing build/web without invoking Flutter
//   --check         report whether the staged payload looks complete; exit 1 if not

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
const stageDir = path.join(repoRoot, 'packages', 'wavecrux', 'media', 'wavecrux-web');

const skipFlutter = process.argv.includes('--skip-flutter');
const checkOnly = process.argv.includes('--check');

/**
 * Where the open-core WaveCrux repo is checked out. CRUX_WAVECRUX_REPO wins;
 * otherwise a sibling `wavecrux` checkout next to this repository.
 */
function resolveSourceRepo() {
  const fromEnv = process.env.CRUX_WAVECRUX_REPO;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(repoRoot, '..', 'wavecrux');
}

// Everything the webview actually loads, and nothing else. Expressed as an
// allowlist of top-level entries plus a per-file predicate, so a future
// Flutter release that starts emitting something new gets left out until
// somebody decides it belongs — the failure mode is a visible 404 in the
// shim's diagnostics, not a silently fatter VSIX.
const TOP_LEVEL_KEEP = new Set([
  'assets', // AssetManifest.bin, fonts, shaders, NOTICES
  'canvaskit', // filtered further below
  'main.dart.js',
  'flutter.js', // the loader; the shim drives it directly (see below)
  // flutter_bootstrap.js is deliberately NOT staged: the shim never runs it,
  // and shipping a second entry point that would start Flutter with the wrong
  // (unconfigured) resource base is an invitation to a very confusing bug.
  // Its one useful part, `_flutter.buildConfig`, is extracted below from the
  // build directory.
  'wasm', // wellen + lxt2fst engines
  'version.json',
]);

// Within canvaskit/: only the variant this build can reach.
const CANVASKIT_KEEP = new Set(['chromium/canvaskit.js', 'chromium/canvaskit.wasm']);

/** Debug symbol maps: 6 MB of them, and never fetched at runtime. */
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
        // Keep the directory that holds a kept file; drop every other one.
        if (entry.isDirectory()) {
          if (![...CANVASKIT_KEEP].some((keep) => keep.startsWith(`${inside}/`))) continue;
        } else if (!CANVASKIT_KEEP.has(inside)) {
          continue;
        }
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

// Files whose absence means the webview would render nothing. --check exists
// so the packaging step fails loudly instead of shipping a VSIX with an empty
// media/ directory.
/** Name of the file [extractBuildConfig] writes into the staged directory. */
const BUILD_CONFIG_FILE = 'flutter-build-config.json';

/**
 * Lift `_flutter.buildConfig` out of the generated `flutter_bootstrap.js`.
 *
 * The shim cannot simply run `flutter_bootstrap.js`: that file ends with a
 * bare `_flutter.loader.load()`, and the whole reason the webview works is
 * that the shim must pass `config` (assetBase / canvasKitBaseUrl /
 * entrypointBaseUrl) into that call. So the shim loads `flutter.js` itself
 * and supplies the build config — which is generated per build (it carries
 * the engine revision) and therefore has to be extracted rather than
 * hardcoded.
 */
function extractBuildConfig(buildWeb, targetRoot) {
  const bootstrap = readFileSync(path.join(buildWeb, 'flutter_bootstrap.js'), 'utf8');
  const match = /_flutter\.buildConfig\s*=\s*(\{[\s\S]*?\});/.exec(bootstrap);
  if (match === null) {
    console.error('[wavecrux-web] could not find _flutter.buildConfig in flutter_bootstrap.js');
    console.error('Flutter changed its bootstrap shape; update tool/build-wavecrux-web.mjs.');
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(match[1]);
  } catch (error) {
    console.error(`[wavecrux-web] _flutter.buildConfig is not JSON: ${error.message}`);
    process.exit(1);
  }
  const renderers = (config.builds ?? []).map((b) => b.renderer).filter(Boolean);
  writeFileSync(
    path.join(targetRoot, BUILD_CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  console.log(`[wavecrux-web] build config: renderer(s) ${renderers.join(', ') || '(none)'}`);
  if (config.useLocalCanvasKit !== true) {
    console.error('[wavecrux-web] useLocalCanvasKit is not true — was --no-web-resources-cdn dropped?');
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
  'wasm/wellen_wasm_loader.js',
  'wasm/wellen_wasm_bg.wasm',
];

function check() {
  const missing = REQUIRED.filter((file) => !existsSync(path.join(stageDir, file)));
  if (missing.length > 0) {
    console.error(`[wavecrux-web] staged payload incomplete at ${stageDir}`);
    for (const file of missing) console.error(`  missing: ${file}`);
    console.error('Run: node tool/build-wavecrux-web.mjs');
    process.exit(1);
  }
  console.log(`[wavecrux-web] staged payload OK (${stageDir})`);
}

if (checkOnly) {
  check();
} else {
  const sourceRepo = resolveSourceRepo();
  if (!existsSync(path.join(sourceRepo, 'pubspec.yaml'))) {
    console.error(`[wavecrux-web] no WaveCrux checkout at ${sourceRepo}`);
    console.error(
      'Clone https://github.com/Ferrite-Engineering/wavecrux next to this repository, ' +
        'or set CRUX_WAVECRUX_REPO to the path of a WaveCrux checkout.',
    );
    process.exit(1);
  }

  if (!skipFlutter) {
    const flags = [
      'build',
      'web',
      '--release',
      '--no-web-resources-cdn',
      '--pwa-strategy=none',
    ];
    console.log(`[wavecrux-web] flutter ${flags.join(' ')}  (cwd: ${sourceRepo})`);
    const result = spawnSync('flutter', flags, { cwd: sourceRepo, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('[wavecrux-web] flutter build web failed');
      process.exit(result.status ?? 1);
    }
  }

  const buildWeb = path.join(sourceRepo, 'build', 'web');
  if (!existsSync(buildWeb)) {
    console.error(`[wavecrux-web] no build output at ${buildWeb}`);
    process.exit(1);
  }

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const { bytes, files } = copyFiltered(buildWeb, stageDir);
  extractBuildConfig(buildWeb, stageDir);
  console.log(
    `[wavecrux-web] staged ${files} file(s), ${humanSize(bytes)} → ${path.relative(repoRoot, stageDir)}`,
  );
  check();
}
