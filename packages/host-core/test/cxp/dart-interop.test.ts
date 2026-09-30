/**
 * Wire-1.2 interoperability against the REAL crux_cxp — both directions.
 *
 * Every other test in this directory drives the TypeScript transport against
 * itself, which cannot catch the failure that matters most here: two
 * implementations that each pass their own suites and still refuse each
 * other. For the token that failure is silent — the handshake is answered
 * `unauthorized`, the connector records a dial failure, and the user sees a
 * desktop product that never connects.
 *
 * So this spawns a real Dart peer (`tool/dart-conformance/cxp_peer.dart`:
 * crux_cxp's own `LocalCxpServer`, `CxpManifestWriter`, `CxpDiscovery` and
 * `CxpPeerConnector`, production defaults throughout) over a private manifest
 * directory and checks, against it:
 *
 * - TypeScript → Dart: the Dart manifest's `token` decodes; a `hello` without
 *   it, or with a wrong one, is refused `unauthorized`; with it, the handshake
 *   completes on wire `1.2`, and a one-shot request through the manifest is
 *   acknowledged by the Dart handler;
 * - Dart → TypeScript: the Dart connector reads OUR manifest's token and our
 *   strict server accepts it; and when our manifest names the wrong token,
 *   the Dart side receives our refusal as `CxpHandshakeException` with code
 *   `unauthorized` — the error frame is understood, not just sent;
 * - both at once: a planted manifest naming a routable host is refused by
 *   both connectors, before either dials, with the same reason;
 * - the desktop hand-off: `openArtifactInDesktop` publishes each product's
 *   artifact — NetCrux's design file, WaveCrux's waveform, LintCrux's
 *   project, SimCrux's config — into a shared workspace and sends
 *   `request_open_artifact`, and crux_cxp's own `CxpWorkspaceStore` and floor
 *   rule resolve and admit the same file under the `design_id` the
 *   TypeScript side derived.
 *
 * A second suite runs the two containment rules — `isCxpLoopbackHost` and
 * `isValidDesignId` — over a shared corpus through
 * `tool/dart-conformance/cxp_rules.dart` and requires the same answers.
 *
 * It needs the sibling `crux-shared` checkout and a Dart toolchain, which
 * every development machine has and crux-vscode's CI runner does not; the
 * suite skips there and says so. Run it before any release that touches
 * `src/cxp/` — see `docs/implementation-map.md` §4.4.
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LocalCxpClient } from '../../src/cxp/client';
import { CxpPeerConnector } from '../../src/cxp/connector';
import { CxpDiscovery } from '../../src/cxp/discovery';
import { CxpDialRefusedError, CxpHandshakeError } from '../../src/cxp/errors';
import { isJsonObject } from '../../src/cxp/json';
import { isCxpLoopbackHost } from '../../src/cxp/loopback';
import { decodeCxpPeerManifest, type CxpPeerManifest } from '../../src/cxp/manifest';
import { CxpManifestWriter } from '../../src/cxp/manifest-writer';
import { CxpErrorCode, CxpMessageKind } from '../../src/cxp/messages';
import { sendOneShotRequest } from '../../src/cxp/one-shot';
import { createVscodePeerIdentity } from '../../src/cxp/peer-id';
import { LocalCxpServer } from '../../src/cxp/server';
import { CxpWorkspaceStore } from '../../src/cxp/workspace-store';
import { openArtifactInDesktop } from '../../src/desktop-detect/artifact-handoff';
import { pollUntil, RawPeer } from './harness';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const DART_PEER = path.join(REPO_ROOT, 'tool', 'dart-conformance', 'cxp_peer.dart');
const DART_RULES = path.join(REPO_ROOT, 'tool', 'dart-conformance', 'cxp_rules.dart');
const CONTAINMENT_CORPUS = fileURLToPath(
  new URL('../fixtures/cxp-containment/corpus.json', import.meta.url),
);
/** The reference implementation, resolved with no `pub get` and no file written there. */
const CRUX_SHARED_PACKAGE_CONFIG = path.join(
  REPO_ROOT,
  '..',
  'crux-shared',
  '.dart_tool',
  'package_config.json',
);

/** crux_cxp's refusal text — asserted verbatim, since the two must agree. */
const DART_UNAUTHORIZED_MESSAGE =
  'A hello to this peer must carry the token published in its manifest.';

/** Whether the live cross-run can happen here. See design-id-conformance.test.ts. */
function dartPeerAvailable(): boolean {
  if (!existsSync(CRUX_SHARED_PACKAGE_CONFIG)) return false;
  if (!existsSync(DART_PEER) || !existsSync(DART_RULES)) return false;
  try {
    execFileSync('dart', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = dartPeerAvailable();
if (!canRun) {
  console.warn(
    '[cxp dart-interop] SKIPPED: needs a Dart toolchain and a crux-shared checkout at ' +
      `${CRUX_SHARED_PACKAGE_CONFIG}. Nothing has checked wire 1.2 against crux_cxp on this run.`,
  );
}

interface DartEvent {
  readonly event: string;
  readonly peer_id?: string;
  readonly port?: number;
  readonly code?: string | null;
  readonly reason?: string | null;
  readonly error?: string;
  readonly kind?: string;
  readonly from?: string;
  readonly design_id?: string;
  readonly artifact_kind?: string;
  readonly hint?: string | null;
  readonly resolved?: string | null;
  readonly floor_refusal?: string | null;
}

describe.skipIf(!canRun)('wire 1.2 against a live crux_cxp peer', () => {
  let dir: string;
  /** The Dart peer's shared workspace: where it looks up a `design_id`. */
  let workspaceDir: string;
  let dart: ChildProcessWithoutNullStreams;
  const events: DartEvent[] = [];
  let stderr = '';
  let dartPeerId: string;
  let dartManifest: CxpPeerManifest;
  const cleanups: (() => void | Promise<void>)[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'crux-cxp-dart-interop-'));
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'crux-cxp-dart-workspace-'));
    dart = spawn(
      'dart',
      ['run', `--packages=${CRUX_SHARED_PACKAGE_CONFIG}`, DART_PEER, dir, workspaceDir],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let buffer = '';
    dart.stdout.setEncoding('utf8');
    dart.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) events.push(JSON.parse(line) as DartEvent);
      }
    });
    dart.stderr.setEncoding('utf8');
    dart.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    // First run compiles the harness, so this is generous.
    await pollUntil(
      () => events.some((e) => e.event === 'ready') || dart.exitCode !== null,
      'the Dart peer must start',
      90_000,
    );
    const ready = events.find((e) => e.event === 'ready');
    if (ready?.peer_id === undefined) {
      throw new Error(`the Dart peer did not start (exit ${String(dart.exitCode)}): ${stderr}`);
    }
    dartPeerId = ready.peer_id;

    // Learn the port and the token the way every peer does: from the file.
    const manifestPath = path.join(dir, `${dartPeerId}.json`);
    const json: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!isJsonObject(json)) throw new Error('the Dart manifest is not a JSON object');
    dartManifest = decodeCxpPeerManifest(json, manifestPath);
  }, 120_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(async () => {
    if (dart !== undefined && dart.exitCode === null) {
      const exited = new Promise<void>((resolve) => dart.once('exit', () => resolve()));
      dart.stdin.end(); // the harness removes its manifest and exits
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (dart.exitCode === null) dart.kill();
    }
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    if (workspaceDir !== undefined) await rm(workspaceDir, { recursive: true, force: true });
  }, 15_000);

  function newClient(): LocalCxpClient {
    const client = new LocalCxpClient({
      selfIdentity: createVscodePeerIdentity({
        workspaceFolder: '/interop/client',
        productVersion: '0.0.0-interop',
        pid: process.pid,
        startedAt: Date.now(),
      }),
      connectTimeoutMs: 5000,
      handshakeTimeoutMs: 5000,
    });
    cleanups.push(() => client.dispose());
    return client;
  }

  async function refusalOf(token: string | undefined): Promise<unknown> {
    return newClient()
      .connect({ host: dartManifest.host, port: dartManifest.port, token })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  }

  describe('TypeScript dials Dart', () => {
    it('the Dart manifest publishes a 128-bit token under "token", on loopback', () => {
      expect(dartManifest.token).toMatch(/^[0-9a-f]{32}$/);
      expect(dartManifest.host).toBe('127.0.0.1');
      expect(dartManifest.identity.peerId).toBe(dartPeerId);
    });

    it('a hello without the token is refused unauthorized, in crux_cxp words', async () => {
      const error = await refusalOf(undefined);
      expect(error).toBeInstanceOf(CxpHandshakeError);
      expect((error as CxpHandshakeError).code).toBe(CxpErrorCode.unauthorized);
      expect((error as CxpHandshakeError).message).toBe(
        `unauthorized: ${DART_UNAUTHORIZED_MESSAGE}`,
      );
    });

    it('a hello with the wrong token is refused unauthorized', async () => {
      const error = await refusalOf('0'.repeat(32));
      expect(error).toBeInstanceOf(CxpHandshakeError);
      expect((error as CxpHandshakeError).code).toBe(CxpErrorCode.unauthorized);
    });

    it('a hello with the manifest token completes the handshake', async () => {
      const client = newClient();
      await client.connect({
        host: dartManifest.host,
        port: dartManifest.port,
        token: dartManifest.token,
      });
      expect(client.isConnected).toBe(true);
      expect(client.remotePeer?.peerId).toBe(dartPeerId);
    });

    it('the Dart hello_ack speaks 1.2, and the raw token field is what it reads', async () => {
      const raw = await RawPeer.connectTo(dartManifest.port);
      cleanups.push(() => raw.close());
      raw.sendEnvelope({
        kind: CxpMessageKind.hello,
        from: 'vscode-rawinterop-1-1',
        payload: {
          identity: {
            peer_id: 'vscode-rawinterop-1-1',
            product_name: 'VSCode',
            product_version: '0.0.0-interop',
            capabilities: [],
          },
          token: dartManifest.token ?? '',
        },
      });
      await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'hello_ack');
      expect(raw.ofKind(CxpMessageKind.helloAck)[0]?.['cxp_version']).toBe('1.2');
    });

    it('a one-shot request through the manifest reaches the Dart handler and is acked', async () => {
      const result = await sendOneShotRequest(
        dartManifest,
        {
          kind: CxpMessageKind.requestHighlight,
          element: { kind: 'signal', path: 'top.cpu.pc' },
          metadata: {},
        },
        {
          selfIdentity: createVscodePeerIdentity({
            workspaceFolder: '/interop/one-shot',
            productVersion: '0.0.0-interop',
            pid: process.pid,
            startedAt: Date.now(),
          }),
          ackKind: CxpMessageKind.requestHighlightAck,
          ackTimeoutMs: 5000,
        },
      );
      expect(result).toEqual({ kind: 'acked', honored: true });
    });

    it('the Dart server closes on a frame that is not an envelope, as ours does', async () => {
      const raw = await RawPeer.connectTo(dartManifest.port);
      cleanups.push(() => raw.close());
      raw.writeRaw('GET / HTTP/1.1\r\n');
      await pollUntil(() => raw.closed, 'the Dart server must close');
      expect(raw.errorPayloads(CxpErrorCode.malformedEnvelope)).toHaveLength(1);
    });
  });

  describe('Dart dials TypeScript', () => {
    /**
     * A TypeScript peer published into the shared directory: strict server,
     * writer, and an identity carrying this process's real pid — crux_cxp's
     * discovery reaps a manifest whose pid is dead, so a synthetic one would
     * vanish before the Dart connector ever dialled it.
     */
    async function publishTypeScriptPeer(
      workspace: string,
      options: { readonly serverToken: string; readonly publishedToken: string },
    ): Promise<{ readonly server: LocalCxpServer; readonly peerId: string }> {
      const identity = createVscodePeerIdentity({
        workspaceFolder: `/interop/${workspace}`,
        productVersion: '0.0.0-interop',
        pid: process.pid,
        startedAt: Date.now(),
      });
      const server = new LocalCxpServer({ selfIdentity: identity, authToken: options.serverToken });
      await server.start();
      cleanups.push(() => server.stop());
      const writer = new CxpManifestWriter({
        manifestDirectory: dir,
        heartbeatIntervalMs: null,
        authToken: options.publishedToken,
      });
      cleanups.push(() => writer.remove());
      await writer.write({ identity, host: '127.0.0.1', port: server.boundPort ?? 0 });
      return { server, peerId: identity.peerId };
    }

    it('the Dart connector presents our manifest token and our strict server accepts it', async () => {
      const token = 'c3'.repeat(16);
      const { server, peerId } = await publishTypeScriptPeer('accepted', {
        serverToken: token,
        publishedToken: token,
      });
      await pollUntil(
        () => events.some((e) => e.event === 'dialled' && e.peer_id === peerId),
        'the Dart connector must complete its handshake with our server',
        10_000,
      );
      // Dart's auto-subscribe arrives on the socket OUR server accepted, which
      // only exists if our token check passed the Dart hello.
      await pollUntil(
        () => server.subscriptionsOf(dartPeerId).length > 0,
        "the Dart peer's subscribe must reach our accept loop",
        10_000,
      );
      expect(
        events.filter((e) => e.event === 'dial_failure' && e.peer_id === peerId),
      ).toEqual([]);
    });

    it('a manifest naming a routable host is refused by both, before either dials', async () => {
      // One planted file in the shared directory, read by both connectors at
      // once. Its id sorts after ours, so our tie-break would dial it — the
      // loopback rule, not the tie-break, has to be what refuses it — and it
      // carries this process's pid, so neither discovery reaps it as dead.
      const planted = {
        peerId: `zzplanted-${process.pid}-${Date.now()}`,
        productName: 'Planted',
        productVersion: '0.0.0',
        capabilities: [],
      };
      const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: null });
      cleanups.push(() => writer.remove());
      await writer.write({ identity: planted, host: '192.0.2.1', port: 54322 });

      const self = createVscodePeerIdentity({
        workspaceFolder: '/interop/routable',
        productVersion: '0.0.0-interop',
        pid: process.pid,
        startedAt: Date.now(),
      });
      const discovery = new CxpDiscovery({
        manifestDirectory: dir,
        selfPeerId: self.peerId,
        scanIntervalMs: 50,
      });
      cleanups.push(() => {
        discovery.stop();
      });
      const connector = new CxpPeerConnector({
        selfIdentity: self,
        discovery,
        retryIntervalMs: 50,
        maxRetryBackoffTicks: 1,
      });
      cleanups.push(() => connector.dispose());
      await discovery.start();
      connector.start();

      await pollUntil(
        () =>
          events.some((e) => e.event === 'dial_failure' && e.peer_id === planted.peerId) &&
          connector.lastDialFailures.has(planted.peerId),
        'both connectors must record a failure for the planted manifest',
        10_000,
      );
      // Dart refused it without a socket...
      const dartFailures = events.filter(
        (e) => e.event === 'dial_failure' && e.peer_id === planted.peerId,
      );
      expect(new Set(dartFailures.map((e) => e.error))).toEqual(
        new Set(['CxpDialRefusedException']),
      );
      expect(events.some((e) => e.event === 'dialled' && e.peer_id === planted.peerId)).toBe(false);
      // ...and so did we, for the same reason, in the same words. A real
      // socket towards a documentation address would have failed with a
      // timeout or a network error instead.
      const ours = connector.lastDialFailures.get(planted.peerId)?.error;
      expect(ours).toBeInstanceOf(CxpDialRefusedError);
      expect((ours as CxpDialRefusedError).reason).toBe(dartFailures[0]?.reason);
      expect(connector.connectedPeers.map((p) => p.peerId)).not.toContain(planted.peerId);
    });

    it('Dart receives our refusal as CxpHandshakeException(unauthorized)', async () => {
      const { server, peerId } = await publishTypeScriptPeer('refused', {
        serverToken: 'd4'.repeat(16),
        publishedToken: 'e5'.repeat(16),
      });
      await pollUntil(
        () => events.some((e) => e.event === 'dial_failure' && e.peer_id === peerId),
        'the Dart dial to a peer publishing the wrong token must fail',
        10_000,
      );
      const failure = events.find((e) => e.event === 'dial_failure' && e.peer_id === peerId);
      expect(failure).toMatchObject({ code: 'unauthorized', error: 'CxpHandshakeException' });
      expect(server.connectedPeers.map((p) => p.peerId)).not.toContain(dartPeerId);
    });
  });

  describe('the desktop hand-off', () => {
    /**
     * What each extension hands its desktop app: the artifact kind its
     * receiver accepts, and a file of the shape the receiver opens.
     */
    const HANDOFFS = [
      { product: 'netcrux', artifactKind: 'source', file: 'top.sv', text: 'module top; endmodule\n' },
      {
        product: 'wavecrux',
        artifactKind: 'waveform',
        file: 'dump.vcd',
        text: '$date $end $enddefinitions $end\n',
      },
      { product: 'lintcrux', artifactKind: 'source', file: 'uart.lintcrux', text: '{}\n' },
      { product: 'simcrux', artifactKind: 'source', file: 'simcrux.yaml', text: 'suites: []\n' },
    ] as const;

    /**
     * "Open in <Product> Desktop", end to end but for the product: the real
     * `openArtifactInDesktop` publishes into a real workspace store and sends
     * over the socket, and the Dart peer resolves the request with crux_cxp's
     * own `CxpWorkspaceStore` and floor rule — the pieces every desktop
     * receiver is built from, and the floor each holds this request to. What
     * a product then does with the file is its own test's business: each open
     * core's `cxp_open_artifact_test.dart`.
     */
    it.each(HANDOFFS.map((h) => [`${h.product}: a \`${h.artifactKind}\` ${h.file}`, h] as const))(
      '%s resolves through crux_cxp to the same file, and the floor admits it',
      async (_name, { product, artifactKind, file, text }) => {
        const designDir = await mkdtemp(path.join(tmpdir(), `crux-cxp-dart-${product}-`));
        cleanups.push(() => rm(designDir, { recursive: true, force: true }));
        const artifactFile = path.join(designDir, file);
        await writeFile(artifactFile, text);

        const outcome = await openArtifactInDesktop({
          product,
          artifactKind,
          artifactPath: artifactFile,
          selfIdentity: createVscodePeerIdentity({
            workspaceFolder: '/interop/handoff',
            productVersion: '0.0.0-interop',
            pid: process.pid,
            startedAt: Date.now(),
          }),
          discoverPeer: () => Promise.resolve(dartManifest),
          workspace: new CxpWorkspaceStore({ workspaceDirectory: workspaceDir }),
          openPath: () => Promise.reject(new Error('a peer that answers is never bypassed')),
          showMessage: () => undefined,
          log: () => undefined,
          ackTimeoutMs: 5000,
        });

        expect(outcome).toMatchObject({ kind: 'opened-in-peer', path: artifactFile });
        const designId = outcome.kind === 'opened-in-peer' ? outcome.designId : '';
        await pollUntil(
          () => events.some((e) => e.event === 'open_artifact' && e.design_id === designId),
          'the Dart peer must report the request it resolved',
        );
        // The record the TypeScript store wrote, found by crux_cxp's store under
        // the id the TypeScript side derived; the hint arrived as sent; and the
        // floor rule that stands between a peer and an open admits the path.
        expect(events.find((e) => e.event === 'open_artifact' && e.design_id === designId)).toEqual({
          event: 'open_artifact',
          design_id: designId,
          artifact_kind: artifactKind,
          hint: artifactFile,
          resolved: artifactFile,
          floor_refusal: null,
        });
      },
    );
  });
});

interface ContainmentCorpus {
  readonly hosts: readonly string[];
  readonly hostsDartParsesNatively: readonly string[];
  readonly designIds: readonly string[];
}

/**
 * The two containment rules, answer for answer against crux_cxp's own —
 * `isCxpLoopbackHost` and `CxpWorkspaceStore.isValidDesignId`, run by
 * `tool/dart-conformance/cxp_rules.dart` over `test/fixtures/cxp-containment/`.
 *
 * Two implementations with different trust rules for the same manifest field
 * or the same wire field is the drift this estate keeps paying for, and it is
 * silent: a planted manifest one peer refuses and the other dials. So the
 * answers must be identical, `hostsDartParsesNatively` included: the
 * spellings a platform C library reads as loopback (leading-zero octets,
 * five-digit groups, zone ids, an embedded NUL). crux_cxp once handed those
 * to the library; it now implements CXP §10.5's closed set in pure Dart, so
 * both implementations refuse every one on every machine. The one-sided
 * property is enforced as well, as the one that matters most: nothing
 * crux_cxp refuses is accepted here.
 */
describe.skipIf(!canRun)('containment rules against crux_cxp', () => {
  const corpus = JSON.parse(readFileSync(CONTAINMENT_CORPUS, 'utf8')) as ContainmentCorpus;
  let root: string;
  let workspaceDirectory: string;
  let designIds: string[];
  let dart: { readonly hosts: boolean[]; readonly nativeHosts: boolean[]; readonly designIds: boolean[] };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'crux-cxp-rules-'));
    workspaceDirectory = path.join(root, 'nested', 'workspace');
    designIds = corpus.designIds.map((id) => id.split('{root}').join(root));
    const run = (hosts: readonly string[]): { hosts: boolean[]; designIds: boolean[] } =>
      JSON.parse(
        execFileSync('dart', ['run', `--packages=${CRUX_SHARED_PACKAGE_CONFIG}`, DART_RULES], {
          input: JSON.stringify({ hosts, workspaceDirectory, designIds }),
          encoding: 'utf8',
          timeout: 120_000,
        }),
      ) as { hosts: boolean[]; designIds: boolean[] };
    const main = run(corpus.hosts);
    const native = run(corpus.hostsDartParsesNatively);
    dart = { hosts: main.hosts, nativeHosts: native.hosts, designIds: main.designIds };
  }, 240_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('isCxpLoopbackHost answers every portable host exactly as crux_cxp does', () => {
    const answers = (rule: (host: string) => boolean) =>
      corpus.hosts.map((host) => ({ host, loopback: rule(host) }));
    expect(answers(isCxpLoopbackHost)).toEqual(
      corpus.hosts.map((host, k) => ({ host, loopback: dart.hosts[k] })),
    );
  });

  it('refuses every spelling a platform parser reads as loopback, as crux_cxp does', () => {
    const answers = (loopback: (host: string, k: number) => boolean) =>
      corpus.hostsDartParsesNatively.map((host, k) => ({ host, loopback: loopback(host, k) }));
    const refusedByAll = answers(() => false);
    expect(answers((host) => isCxpLoopbackHost(host))).toEqual(refusedByAll);
    expect(answers((_, k) => dart.nativeHosts[k] ?? true)).toEqual(refusedByAll);
  });

  it('never accepts a host crux_cxp refuses', () => {
    const all = [...corpus.hosts, ...corpus.hostsDartParsesNatively];
    const dartAll = [...dart.hosts, ...dart.nativeHosts];
    const acceptedHereOnly = all.filter((host, k) => isCxpLoopbackHost(host) && !dartAll[k]);
    expect(acceptedHereOnly).toEqual([]);
  });

  it('isValidDesignId answers every id exactly as crux_cxp does', () => {
    const store = new CxpWorkspaceStore({ workspaceDirectory });
    expect(designIds.map((id) => ({ id, valid: store.isValidDesignId(id) }))).toEqual(
      designIds.map((id, k) => ({ id, valid: dart.designIds[k] })),
    );
  });
});
