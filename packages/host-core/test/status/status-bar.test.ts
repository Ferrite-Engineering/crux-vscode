import { describe, expect, it } from 'vitest';
import type { Disposable } from '../../src/cxp/emitter';
import { buildCapabilitiesPanelContent, type CapabilitiesPanelContent } from '../../src/status/panel-content';
import {
  STATUS_PANEL_COMMAND_ID,
  StatusBarController,
  type StatusBarHost,
  type StatusBarItemHandle,
} from '../../src/status/status-bar';
import { STATUS_BAR_TEXT } from '../../src/status/strings';

class FakeStatusBarItem implements StatusBarItemHandle {
  text = '';
  tooltip = '';
  command = '';
  shown = false;
  disposed = false;

  show(): void {
    this.shown = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeStatusBarHost implements StatusBarHost {
  readonly item = new FakeStatusBarItem();

  createStatusBarItem(): StatusBarItemHandle {
    return this.item;
  }
}

function fixedContent(): CapabilitiesPanelContent {
  return buildCapabilitiesPanelContent({ tier: 'openCore', installedProducts: [], desktopPresence: [] });
}

describe('StatusBarController', () => {
  it('shows the item immediately, with the shared text/tooltip/command, and never hides it', () => {
    const host = new FakeStatusBarHost();
    const controller = new StatusBarController({
      host,
      registerCommand: (): Disposable => ({ dispose: () => undefined }),
      buildContent: fixedContent,
      showPanel: () => undefined,
    });
    expect(host.item.shown).toBe(true);
    expect(host.item.text).toBe(STATUS_BAR_TEXT);
    expect(host.item.command).toBe(STATUS_PANEL_COMMAND_ID);
    expect(host.item.tooltip.length).toBeGreaterThan(0);
    controller.dispose();
  });

  it('registers exactly the STATUS_PANEL_COMMAND_ID the item points at', () => {
    const host = new FakeStatusBarHost();
    const registeredIds: string[] = [];
    new StatusBarController({
      host,
      registerCommand: (id, _handler): Disposable => {
        registeredIds.push(id);
        return { dispose: () => undefined };
      },
      buildContent: fixedContent,
      showPanel: () => undefined,
    });
    expect(registeredIds).toEqual([STATUS_PANEL_COMMAND_ID]);
  });

  it('a click builds fresh content and shows the panel — the click is the instrumented moment', () => {
    const host = new FakeStatusBarHost();
    let commandHandler: (() => void) | undefined;
    const shown: { title: string; html: string }[] = [];
    let buildCount = 0;
    let opened = 0;

    new StatusBarController({
      host,
      registerCommand: (_id, handler): Disposable => {
        commandHandler = handler;
        return { dispose: () => undefined };
      },
      buildContent: () => {
        buildCount += 1;
        return fixedContent();
      },
      showPanel: (title, html) => shown.push({ title, html }),
      onOpened: () => {
        opened += 1;
      },
    });

    expect(buildCount).toBe(0); // not built until clicked
    expect(opened).toBe(0);

    commandHandler?.();

    expect(opened).toBe(1);
    expect(buildCount).toBe(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.html).toContain('<!doctype html>');

    // A second click rebuilds — tier/desktop presence can have changed.
    commandHandler?.();
    expect(buildCount).toBe(2);
    expect(shown).toHaveLength(2);
  });

  it('dispose() disposes both the command registration and the status-bar item', () => {
    const host = new FakeStatusBarHost();
    let commandDisposed = false;
    const controller = new StatusBarController({
      host,
      registerCommand: (): Disposable => ({
        dispose: () => {
          commandDisposed = true;
        },
      }),
      buildContent: fixedContent,
      showPanel: () => undefined,
    });
    controller.dispose();
    expect(commandDisposed).toBe(true);
    expect(host.item.disposed).toBe(true);
  });
});
