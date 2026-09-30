/**
 * The advertising switch: suppress a product's desktop
 * advertising once its desktop peer is present, and name the handoff
 * command to show instead.
 *
 * This module decides *whether* to advertise and *what command id* a
 * handoff affordance should carry. It does not register that command or
 * give it behaviour — "Open in WaveCrux Desktop" needs a live editor
 * selection and a connected peer to send to, which is exactly what
 * `editor/send.ts`'s `PeerSendCommands` already models for the generic
 * "Send to <peer>" case. A later, product-specific prompt (WaveCrux's own
 * funnel content, explicitly out of scope here) is where
 * [desktopHandoffCommandId]'s id gets a `vscode.commands.registerCommand`
 * behind it — most naturally by constructing a `PeerSendCommands` scoped
 * to peers whose `productName` matches this one product.
 */
import type { CruxDesktopProduct } from './detector';

/**
 * The command id a handoff affordance for [product] should carry.
 *
 * `edacrux.*`, matching `CRUX_SEND_COMMAND_IDS` in `editor/send.ts`: the
 * command is host-core's regardless of which product's extension
 * ultimately gives it behaviour, and a window with only one product
 * extension installed must not see a command that reads as belonging to
 * a different one.
 */
export function desktopHandoffCommandId(product: CruxDesktopProduct): string {
  return `edacrux.openInDesktop.${product}`;
}

/**
 * Whether to advertise [product]'s desktop app, and what to show instead
 * when not.
 *
 * `advertise: true` — no desktop peer detected; show the install pitch.
 * `advertise: false` — a peer is present; show the handoff affordance at
 * [handoffCommandId] instead. There is no third state: a surface either
 * pitches the app the user does not have, or hands off to the one they
 * do — never both, and never neither.
 */
export type DesktopAdvertisingDecision =
  | { readonly advertise: true }
  | { readonly advertise: false; readonly handoffCommandId: string };

/** Decide [DesktopAdvertisingDecision] for [product] given whether its desktop peer is [present]. */
export function desktopAdvertisingDecision(
  product: CruxDesktopProduct,
  present: boolean,
): DesktopAdvertisingDecision {
  return present
    ? { advertise: false, handoffCommandId: desktopHandoffCommandId(product) }
    : { advertise: true };
}
