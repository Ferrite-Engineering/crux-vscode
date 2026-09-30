/**
 * The capabilities panel's content model: tier, what desktop
 * adds, what Pro adds, and links — computed as plain data so it can be
 * unit-tested without a live `vscode` webview, and rendered by
 * `panel-html.ts` or, in principle, anything else that can show data.
 */
import { desktopAdvertisingDecision } from '../desktop-detect/advertising';
import type { CruxDesktopProduct, DesktopPeerPresence } from '../desktop-detect/detector';
import type { TelemetryLicenseTier } from '../telemetry/vocabulary';
import {
  CRUX_PRODUCT_DISPLAY_NAMES,
  defaultDesktopPitch,
  defaultHandoffLabel,
  desktopAlreadyInstalledNote,
  documentationLinkLabel,
  proLinkLabel,
  proPitch,
  suiteLinkLabel,
} from './strings';

/** One row in the "Desktop app" section — always present-vs-pitch, never both. */
export interface CapabilityProductRow {
  readonly product: CruxDesktopProduct;
  readonly displayName: string;
  readonly desktopPresent: boolean;
  /** Shown above the row's action. */
  readonly headline: string;
  readonly action: CapabilityAction;
  /**
   * The capability boundaries this product's editor surface has, each one
   * sentence in the `fsdbWebUnsupportedMessage` voice:
   * what the limitation is, why it exists, and what to do about it.
   *
   * Empty by default. A product fills it through
   * [ProductCapabilityCopy.capabilityNotes] — this is where the
   * boundaries become *readable on demand* rather than only appearing at
   * the moment the user hits one. Both matter and they are not
   * substitutes: an in-place empty state teaches the person who went
   * looking for the feature, and this list teaches the person deciding
   * whether the desktop app is worth installing.
   */
  readonly notes: readonly string[];
}

/**
 * The row's action: a link to install the app the user does not have, or
 * a command id to hand off to the one they do. Never both — see
 * `desktop-detect/advertising.ts`'s [DesktopAdvertisingDecision].
 */
export type CapabilityAction =
  | { readonly kind: 'install-link'; readonly url: string; readonly label: string }
  | { readonly kind: 'handoff-command'; readonly commandId: string; readonly label: string };

/** One entry in the "Links" section. */
export interface CapabilityLink {
  readonly label: string;
  readonly url: string;
}

/** The full panel content model. */
export interface CapabilitiesPanelContent {
  readonly tier: TelemetryLicenseTier;
  readonly productRows: readonly CapabilityProductRow[];
  readonly proPitch: string;
  readonly proLink: CapabilityLink;
  readonly links: readonly CapabilityLink[];
}

/**
 * Per-product copy a product can override — the extension point for
 * product-specific content such as WaveCrux's. Its members are
 * optional; an override for one product does not require overriding the
 * others, since [buildCapabilitiesPanelContent] falls back to the
 * defaults in `strings.ts` per field, per product.
 */
export interface ProductCapabilityCopy {
  /** Overrides [defaultDesktopPitch] for one product. */
  readonly desktopPitch?: (product: CruxDesktopProduct) => string;
  /** Overrides [defaultHandoffLabel] for one product. */
  readonly handoffLabel?: (product: CruxDesktopProduct) => string;
  /** Overrides the default `https://<product>.app` install link. */
  readonly installUrl?: (product: CruxDesktopProduct) => string;
  /**
   * Supplies [CapabilityProductRow.notes] for one product — the
   * capability boundaries, stated once, in one place.
   *
   * Returned **whether or not the desktop peer is present**: the
   * boundaries are facts about the editor panel, not advertising, and a
   * user who already has the desktop app is exactly the one for whom
   * "this is why that tab is empty in here" is useful rather than a
   * pitch. Only the *headline* and *action* switch on presence
   * (`desktopAdvertisingDecision`); the notes do not.
   */
  readonly capabilityNotes?: (product: CruxDesktopProduct) => readonly string[];
}

/**
 * Public suite/product website, per the crux domain convention (`.app`,
 * not `.com`).
 *
 * Exported because the capabilities panel is not the only place a product
 * points at its own download page — a product surface that has to explain
 * a boundary in place (LintCrux's cross-design triage message, say) must
 * link to the *same* URL the panel does, or the two disagree the first
 * time one of them is edited.
 */
export function cruxProductInstallUrl(product: CruxDesktopProduct): string {
  return `https://${product}.app`;
}

/** Options for [buildCapabilitiesPanelContent]. */
export interface CapabilitiesPanelOptions {
  readonly tier: TelemetryLicenseTier;
  /**
   * Which products' rows to show — normally the product surfaces
   * currently registered in this window (`SurfaceRegistry.surfaces`),
   * so a window with only the LintCrux extension installed does not
   * pitch WaveCrux, NetCrux, or SimCrux.
   */
  readonly installedProducts: readonly CruxDesktopProduct[];
  /** Current desktop-peer presence for the installed products — `DesktopPeerDetector.snapshot`. */
  readonly desktopPresence: readonly DesktopPeerPresence[];
  /**
   * Words for every row, when one product is speaking for the panel.
   *
   * Superseded per row by [copies]. Kept because a product extension that
   * renders its own panel — or a test — has exactly one voice.
   */
  readonly copy?: ProductCapabilityCopy;
  /**
   * Per-product words, for the panel the elected window host renders.
   *
   * A window with LintCrux and SimCrux installed shows both rows, and each
   * product owns its own pitch and handoff label; a single [copy] would
   * make whichever extension happened to host speak for all of them. Falls
   * back to [copy], then to the shared defaults, per product.
   */
  readonly copies?: Partial<Record<CruxDesktopProduct, ProductCapabilityCopy>>;
  readonly links?: readonly CapabilityLink[];
}

function presenceFor(
  presence: readonly DesktopPeerPresence[],
  product: CruxDesktopProduct,
): boolean {
  return presence.find((row) => row.product === product)?.present ?? false;
}

function buildProductRow(
  product: CruxDesktopProduct,
  present: boolean,
  copy: ProductCapabilityCopy | undefined,
): CapabilityProductRow {
  const decision = desktopAdvertisingDecision(product, present);
  const displayName = CRUX_PRODUCT_DISPLAY_NAMES[product];
  const notes = copy?.capabilityNotes?.(product) ?? [];
  if (decision.advertise) {
    return {
      product,
      displayName,
      desktopPresent: false,
      headline: (copy?.desktopPitch ?? defaultDesktopPitch)(product),
      action: {
        kind: 'install-link',
        url: (copy?.installUrl ?? cruxProductInstallUrl)(product),
        label: displayName,
      },
      notes,
    };
  }
  return {
    product,
    displayName,
    desktopPresent: true,
    headline: desktopAlreadyInstalledNote(product),
    action: {
      kind: 'handoff-command',
      commandId: decision.handoffCommandId,
      label: (copy?.handoffLabel ?? defaultHandoffLabel)(product),
    },
    notes,
  };
}

/**
 * Build the panel's content model. Pure — no `vscode` dependency — so it
 * is exercised directly by `test/status/panel-content.test.ts` for every
 * combination of tier, installed products, and desktop presence, without
 * any webview or extension host in play.
 */
export function buildCapabilitiesPanelContent(
  options: CapabilitiesPanelOptions,
): CapabilitiesPanelContent {
  const productRows = options.installedProducts.map((product) =>
    buildProductRow(
      product,
      presenceFor(options.desktopPresence, product),
      options.copies?.[product] ?? options.copy,
    ),
  );
  return {
    tier: options.tier,
    productRows,
    proPitch: proPitch(),
    proLink: { label: proLinkLabel(), url: 'https://edacrux.app/pricing' },
    links: options.links ?? [
      { label: suiteLinkLabel(), url: 'https://edacrux.app' },
      { label: documentationLinkLabel(), url: 'https://edacrux.app/docs' },
    ],
  };
}
