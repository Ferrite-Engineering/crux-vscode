import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { CruxWindowHost } from '../../src/window/window-host';
import { joinCruxWindow } from '../../src/window/join';
import { CRUX_WINDOW_API_VERSION, type CruxWindowApi } from '../../src/window/api';
import type { ExtensionHandle, ExtensionRegistryView } from '../../src/window/election';
import type { CruxSurface } from '../../src/surface/index';

let dir: string;
const hosts: CruxWindowHost[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crux-window-'));
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** Just enough `ExtensionContext` for the pieces under test. */
function fakeContext(version = '0.4.2'): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extension: { packageJSON: { version } },
  } as unknown as vscode.ExtensionContext;
}

function newHost(workspace: string): CruxWindowHost {
  const host = new CruxWindowHost({
    context: fakeContext(),
    product: 'lintcrux',
    log: () => undefined,
    record: () => undefined,
    manifestDirectory: dir,
    heartbeatIntervalMs: null,
    // Started explicitly by the test rather than on a timer.
    peerStartDelayMs: 3_600_000,
    workspaceFolder: () => `/Users/dev/${workspace}`,
    scanIntervalMs: 3_600_000,
    retryIntervalMs: 3_600_000,
  });
  hosts.push(host);
  return host;
}

const LINTCRUX: CruxSurface = {
  id: 'lintcrux',
  extensionId: 'ferrite-engineering.lintcrux',
  capabilities: ['lintcrux.diagnostics'],
};

const SIMCRUX: CruxSurface = {
  id: 'simcrux',
  extensionId: 'ferrite-engineering.simcrux',
  capabilities: ['simcrux.regression_results'],
};

async function manifests(): Promise<readonly string[]> {
  return (await readdir(dir)).filter((entry) => entry.endsWith('.json'));
}

async function readManifest(name: string): Promise<{
  identity: { peer_id: string; capabilities: string[] };
  started_at: number;
}> {
  return JSON.parse(await readFile(join(dir, name), 'utf8')) as {
    identity: { peer_id: string; capabilities: string[] };
    started_at: number;
  };
}

describe('CruxWindowHost — one window, one manifest', () => {
  it('publishes exactly one manifest whose capabilities are the union of the joined surfaces', async () => {
    const host = newHost('union');
    host.join({ surface: LINTCRUX });
    host.join({ surface: SIMCRUX });
    await host.started();

    const files = await manifests();
    expect(files).toHaveLength(1);
    const manifest = await readManifest(files[0] ?? '');
    expect(manifest.identity.capabilities).toEqual([
      'lintcrux.diagnostics',
      'request_open_artifact',
      'request_open_source',
      'simcrux.regression_results',
    ]);
  });

  it('advertises only the installed surface when one extension is installed alone', async () => {
    const host = newHost('standalone');
    host.join({ surface: LINTCRUX });
    await host.started();

    const manifest = await readManifest((await manifests())[0] ?? '');
    expect(manifest.identity.capabilities).toEqual([
      'lintcrux.diagnostics',
      'request_open_artifact',
      'request_open_source',
    ]);
    expect(manifest.identity.capabilities).not.toContain('simcrux.regression_results');
  });

  it('republishes under the SAME peer id when a surface joins late', async () => {
    // The requirement `republish` exists for: an extension installed or
    // activated mid-session. Re-minting the identity instead would change
    // the peer id, and since the manifest is named `<peer_id>.json` the
    // window would appear twice in the directory.
    const host = newHost('late');
    host.join({ surface: LINTCRUX });
    await host.started();
    const before = await manifests();
    const peerId = (await readManifest(before[0] ?? '')).identity.peer_id;

    host.join({ surface: SIMCRUX });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await manifests();
    expect(after).toEqual(before);
    const manifest = await readManifest(after[0] ?? '');
    expect(manifest.identity.peer_id).toBe(peerId);
    expect(manifest.identity.capabilities).toContain('simcrux.regression_results');
  });

  it('drops a surface again when its registration is disposed', async () => {
    const host = newHost('leave');
    host.join({ surface: LINTCRUX });
    const simcrux = host.join({ surface: SIMCRUX });
    await host.started();
    simcrux.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const manifest = await readManifest((await manifests())[0] ?? '');
    expect(manifest.identity.capabilities).not.toContain('simcrux.regression_results');
  });

  it('leaves no manifest behind on dispose', async () => {
    const host = newHost('teardown');
    host.join({ surface: LINTCRUX });
    await host.started();
    expect(await manifests()).toHaveLength(1);

    await host.dispose();
    expect(await manifests()).toEqual([]);
    await host.dispose(); // idempotent
  });

  it('survives a manifest directory it cannot resolve', async () => {
    // No CXP peer, but the window is otherwise fine: a machine with no
    // application-data root must lose cross-probing, not its status bar.
    const host = new CruxWindowHost({
      context: fakeContext(),
      product: 'lintcrux',
      log: () => undefined,
      record: () => undefined,
      manifestDirectory: '/dev/null/not-a-directory',
      heartbeatIntervalMs: null,
      peerStartDelayMs: 3_600_000,
      workspaceFolder: () => '/Users/dev/broken',
    });
    hosts.push(host);
    host.join({ surface: LINTCRUX });
    await host.started();
    expect(host.publishedIdentity?.capabilities ?? []).toContain('lintcrux.diagnostics');
  });
});

/** A scripted sibling extension for the `joinCruxWindow` tests. */
class FakeExtension implements ExtensionHandle {
  isActive = false;
  exports: unknown = undefined;

  constructor(
    readonly id: string,
    private readonly onActivate: () => unknown,
  ) {}

  activate(): Promise<unknown> {
    this.isActive = true;
    this.exports = this.onActivate();
    return Promise.resolve(this.exports);
  }
}

function registryOf(handles: readonly ExtensionHandle[]): ExtensionRegistryView {
  return { getExtension: (id) => handles.find((handle) => handle.id === id) };
}

describe('joinCruxWindow', () => {
  it('returns an api synchronously and never blocks activate()', () => {
    const membership = joinCruxWindow({
      context: fakeContext(),
      product: 'lintcrux',
      surface: LINTCRUX,
      log: () => undefined,
      record: () => undefined,
      extensions: registryOf([]),
      hostOptions: { manifestDirectory: dir, peerStartDelayMs: 3_600_000 },
    });
    // Synchronously available for VSCode to capture as `exports`, before
    // the election has had a chance to settle.
    expect(membership.api.cruxWindowApiVersion).toBe(CRUX_WINDOW_API_VERSION);
    void membership.dispose();
  });

  it('hosts, and registers a surface queued before the election settled', async () => {
    const membership = joinCruxWindow({
      context: fakeContext(),
      product: 'lintcrux',
      surface: LINTCRUX,
      log: () => undefined,
      record: () => undefined,
      extensions: registryOf([]),
      hostOptions: { manifestDirectory: dir, peerStartDelayMs: 3_600_000 },
    });
    const role = await membership.settled();
    expect(role.kind).toBe('host');
    expect(membership.api.isWindowHost()).toBe(true);
    expect(membership.api.capabilities()).toContain('lintcrux.diagnostics');
    await membership.dispose();
  });

  it('joins a sibling host and contributes into ITS registry', async () => {
    const host = newHost('guest-join');
    const hostApi: CruxWindowApi = {
      cruxWindowApiVersion: CRUX_WINDOW_API_VERSION,
      isWindowHost: () => true,
      hostExtensionId: () => 'ferrite-engineering.lintcrux',
      join: (contribution) => host.join(contribution),
      peers: () => [],
      capabilities: () => host.registry.capabilities(),
    };
    const lintcrux = new FakeExtension('ferrite-engineering.lintcrux', () => hostApi);

    const membership = joinCruxWindow({
      context: fakeContext(),
      product: 'simcrux',
      surface: SIMCRUX,
      log: () => undefined,
      record: () => undefined,
      extensions: registryOf([lintcrux]),
    });
    await membership.settled();

    expect(membership.api.isWindowHost()).toBe(false);
    expect(membership.api.hostExtensionId()).toBe('ferrite-engineering.lintcrux');
    // The window — not the guest — carries the composed capability list.
    expect(host.registry.capabilities()).toContain('simcrux.regression_results');
    expect(membership.api.capabilities()).toContain('simcrux.regression_results');

    await membership.dispose();
    expect(host.registry.capabilities()).not.toContain('simcrux.regression_results');
  });

  it('a guest builds no peer of its own', async () => {
    const host = newHost('guest-no-peer');
    host.join({ surface: LINTCRUX });
    await host.started();
    const hostApi: CruxWindowApi = {
      cruxWindowApiVersion: CRUX_WINDOW_API_VERSION,
      isWindowHost: () => true,
      hostExtensionId: () => 'ferrite-engineering.lintcrux',
      join: (contribution) => host.join(contribution),
      peers: () => [],
      capabilities: () => host.registry.capabilities(),
    };
    const membership = joinCruxWindow({
      context: fakeContext(),
      product: 'simcrux',
      surface: SIMCRUX,
      log: () => undefined,
      record: () => undefined,
      extensions: registryOf([new FakeExtension('ferrite-engineering.lintcrux', () => hostApi)]),
      hostOptions: { manifestDirectory: dir },
    });
    await membership.settled();
    expect(membership.host).toBeUndefined();
    // One window, one manifest — the whole point.
    expect(await manifests()).toHaveLength(1);
    await membership.dispose();
  });
});
