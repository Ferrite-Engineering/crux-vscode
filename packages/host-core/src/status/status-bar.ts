/**
 * [StatusBarController] — the window's one status-bar item.
 *
 * **Always present, never modal.** The item is shown once at construction
 * and never hidden by this module — there is no "dismiss" state, because a
 * status bar item is not an interruption to begin with. Clicking it opens
 * a panel; nothing here ever calls `showInformationMessage`,
 * `showWarningMessage`, or anything else that pops over the user's work.
 * That is the whole point of it: this *replaces* the temptation to
 * sprinkle upgrade prompts through the UI, so nothing in this module may
 * grow into one.
 *
 * **The click is the instrumented moment, not a dismissal** — there is
 * nothing to dismiss. [StatusSurfaceOptions.onOpened] fires exactly when
 * the command handler runs, i.e. once per click, and a caller wires it to
 * `TelemetryClient.record({ name: TELEMETRY_EVENTS.statusPanelOpened })`.
 */
import * as vscode from 'vscode';
import type { Disposable } from '../cxp/emitter';
import type { CapabilitiesPanelContent } from './panel-content';
import { renderCapabilitiesPanelHtml } from './panel-html';
import { STATUS_BAR_TEXT, capabilitiesPanelTitle, statusBarTooltip } from './strings';

/** Command id the status-bar item's click invokes, and the panel opens from. */
export const STATUS_PANEL_COMMAND_ID = 'edacrux.openCapabilitiesPanel';

/** The subset of `vscode.StatusBarItem` this module needs, kept mutable to match the real API. */
export interface StatusBarItemHandle extends Disposable {
  text: string;
  tooltip: string;
  command: string;
  show(): void;
}

/** Where [StatusBarController] gets its status-bar item — testable without live `vscode`. */
export interface StatusBarHost {
  createStatusBarItem(): StatusBarItemHandle;
}

/**
 * The real [StatusBarHost], backed by `vscode.window.createStatusBarItem`.
 *
 * Wraps rather than returns the `vscode.StatusBarItem` directly: its
 * `tooltip` and `command` fields accept richer types (`MarkdownString`,
 * `Command`) this module never uses, and narrowing to plain strings here
 * keeps [StatusBarItemHandle] — and every test written against it — free
 * of a `vscode`-specific union it has no reason to know about.
 */
export const vscodeStatusBarHost: StatusBarHost = {
  createStatusBarItem(): StatusBarItemHandle {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    return {
      get text(): string {
        return item.text;
      },
      set text(value: string) {
        item.text = value;
      },
      get tooltip(): string {
        return typeof item.tooltip === 'string' ? item.tooltip : '';
      },
      set tooltip(value: string) {
        item.tooltip = value;
      },
      get command(): string {
        return typeof item.command === 'string' ? item.command : '';
      },
      set command(value: string) {
        item.command = value;
      },
      show: () => item.show(),
      dispose: () => item.dispose(),
    };
  },
};

/** Construction options for [StatusBarController]. */
export interface StatusSurfaceOptions {
  readonly host: StatusBarHost;
  /**
   * Register [STATUS_PANEL_COMMAND_ID]. Production wiring:
   * `vscode.commands.registerCommand`, adapted to [Disposable]. A seam
   * rather than a direct `vscode.commands` call, so tests
   * can invoke the handler without a real extension host.
   */
  readonly registerCommand: (id: string, handler: () => void) => Disposable;
  /**
   * Build the panel's content fresh, on each open — tier and desktop
   * presence can both change between clicks, and a status surface that
   * showed a stale snapshot would be exactly the kind of quiet
   * correctness bug a "read live" module elsewhere in this package (the
   * telemetry gate, the cross-probe settings) is designed to avoid.
   */
  readonly buildContent: () => CapabilitiesPanelContent;
  /** Show the panel. Production wiring: `vscode.window.createWebviewPanel`. */
  readonly showPanel: (title: string, html: string) => void;
  /** Fired once per click, before the panel is built — the instrumented moment. */
  readonly onOpened?: () => void;
}

/** Owns the status-bar item and the command that opens the capabilities panel. */
export class StatusBarController implements Disposable {
  private readonly item: StatusBarItemHandle;
  private readonly commandSubscription: Disposable;

  constructor(private readonly options: StatusSurfaceOptions) {
    this.item = options.host.createStatusBarItem();
    this.item.text = STATUS_BAR_TEXT;
    this.item.tooltip = statusBarTooltip();
    this.item.command = STATUS_PANEL_COMMAND_ID;
    this.item.show();
    this.commandSubscription = options.registerCommand(STATUS_PANEL_COMMAND_ID, () => {
      this.options.onOpened?.();
      this.options.showPanel(capabilitiesPanelTitle(), renderCapabilitiesPanelHtml(this.options.buildContent()));
    });
  }

  dispose(): void {
    this.commandSubscription.dispose();
    this.item.dispose();
  }
}

/**
 * Real [StatusSurfaceOptions.registerCommand], adapting
 * `vscode.commands.registerCommand` to [Disposable] and pushing the
 * registration onto [context.subscriptions] so it is disposed with the
 * extension.
 *
 * ### Why a duplicate id is survivable here and not fatal
 *
 * `vscode.commands.registerCommand` **throws** on an id another extension
 * already registered, and a throw out of `activate()` kills the whole
 * extension. Measured, before `window/` existed: with all four EDACrux
 * extensions installed, LintCrux activated and the other three died on
 * `command 'edacrux.openCapabilitiesPanel' already exists` — three
 * products' entire functionality lost to one status-bar item.
 *
 * The election in `window/` is what stops that happening at all: the
 * `edacrux.*` ids are registered by the elected window host and by nobody
 * else. This catch is the second line of defence, for the one case the
 * election cannot cover — a *mixed-version* window where an older build
 * predating `window/` still registers the id unconditionally. Degrading to
 * "someone else owns that command" is right there; taking the extension
 * down with it is not.
 */
export function vscodeRegisterCommand(
  context: vscode.ExtensionContext,
  id: string,
  handler: () => void,
): Disposable {
  let subscription: vscode.Disposable;
  try {
    subscription = vscode.commands.registerCommand(id, handler);
  } catch (error) {
    console.warn(`[crux] command '${id}' is already registered in this window:`, error);
    return { dispose: () => undefined };
  }
  context.subscriptions.push(subscription);
  // Block body: `vscode.Disposable.dispose()` is typed `any`, and returning
  // it (even discarded) trips `@typescript-eslint/no-unsafe-return`.
  return {
    dispose: () => {
      subscription.dispose();
    },
  };
}

/**
 * Real [StatusSurfaceOptions.showPanel]: creates (or, on a second click,
 * simply reveals) a `vscode.WebviewPanel` and wires its `postMessage`
 * channel back to `vscode.commands.executeCommand` for the panel's own
 * handoff buttons (`panel-html.ts`'s inline script).
 *
 * One panel is reused across clicks rather than creating a new tab every
 * time — a capabilities panel is a reference the user re-opens, not a
 * one-shot dialog.
 */
export function createVscodeShowPanel(context: vscode.ExtensionContext): (
  title: string,
  html: string,
) => void {
  let panel: vscode.WebviewPanel | undefined;
  return (title: string, html: string): void => {
    if (panel === undefined) {
      panel = vscode.window.createWebviewPanel('edacruxCapabilities', title, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: false,
      });
      panel.onDidDispose(() => {
        panel = undefined;
      });
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as Record<string, unknown>)['kind'] === 'command' &&
          typeof (message as Record<string, unknown>)['commandId'] === 'string'
        ) {
          void vscode.commands.executeCommand((message as { commandId: string }).commandId);
        }
      });
      context.subscriptions.push(panel);
    } else {
      panel.reveal();
    }
    panel.title = title;
    panel.webview.html = html;
  };
}
