/**
 * Renders [CapabilitiesPanelContent] to the webview panel's HTML body.
 *
 * Pure string building — no `vscode` dependency, so `panel-html.test.ts`
 * exercises it directly. Every dynamic value is escaped: nothing in
 * [CapabilitiesPanelContent] originates from a peer or from user input
 * today, but the panel is rendered inside a `vscode.WebviewPanel`, and
 * "nothing here happens to be attacker-controlled yet" is not a reason to
 * skip escaping something that renders as HTML.
 */
import type { CapabilitiesPanelContent, CapabilityAction } from './panel-content';
import {
  capabilitiesPanelTitle,
  desktopSectionHeading,
  linksSectionHeading,
  proSectionHeading,
  tierLabel,
  tierSectionHeading,
} from './strings';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The `data-command` attribute a handoff button carries. The panel's own
 * inline script (see [renderCapabilitiesPanelHtml]) posts `{ commandId }`
 * back to the extension on click; the extension side (a thin adapter, not
 * built here) forwards it to `vscode.commands.executeCommand`.
 */
function renderAction(action: CapabilityAction): string {
  if (action.kind === 'install-link') {
    return `<a class="crux-action" href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a>`;
  }
  return (
    `<button class="crux-action" type="button" data-command="${escapeHtml(action.commandId)}">` +
    `${escapeHtml(action.label)}</button>`
  );
}

/**
 * The capability boundaries for one product row, or the empty string
 * when that product declared none.
 *
 * Rendered as a nested list *under* the row rather than folded into the
 * headline: the headline is one sentence a reader skims, and burying four
 * boundaries in it would make the honest answer the least readable thing
 * on the page — which is the failure mode the "state it plainly, no
 * wheedling" rule for this copy is really about.
 */
function renderNotes(notes: readonly string[]): string {
  if (notes.length === 0) return '';
  const items = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  return `<li class="crux-notes"><ul>${items}</ul></li>`;
}

/** Render [content] as the panel body's inner HTML — a full document, `<style>` included. */
export function renderCapabilitiesPanelHtml(content: CapabilitiesPanelContent): string {
  const productRows = content.productRows
    .map(
      (row) => `
        <li class="crux-row">
          <span class="crux-row-headline">${escapeHtml(row.headline)}</span>
          ${renderAction(row.action)}
        </li>${renderNotes(row.notes)}`,
    )
    .join('');

  const links = content.links
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></li>`,
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(capabilitiesPanelTitle())}</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); padding: 1rem 1.25rem; }
  h1 { font-size: 1.1rem; }
  h2 { font-size: 0.95rem; margin-top: 1.5rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin: 0.4rem 0; }
  .crux-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .crux-notes > ul { margin: 0.2rem 0 0.9rem 0; }
  .crux-notes li {
    margin: 0.35rem 0;
    padding-left: 0.8rem;
    border-left: 2px solid var(--vscode-panel-border, #454545);
    color: var(--vscode-descriptionForeground, #999);
    font-size: 0.92em;
    line-height: 1.5;
  }
  .crux-action { }
  a { color: var(--vscode-textLink-foreground, #3794ff); }
</style>
</head>
<body>
  <h1>${escapeHtml(capabilitiesPanelTitle())}</h1>

  <h2>${escapeHtml(tierSectionHeading())}</h2>
  <p>${escapeHtml(tierLabel(content.tier))}</p>

  <h2>${escapeHtml(desktopSectionHeading())}</h2>
  <ul>${productRows}</ul>

  <h2>${escapeHtml(proSectionHeading())}</h2>
  <p>${escapeHtml(content.proPitch)}</p>
  <p><a href="${escapeHtml(content.proLink.url)}">${escapeHtml(content.proLink.label)}</a></p>

  <h2>${escapeHtml(linksSectionHeading())}</h2>
  <ul>${links}</ul>

  <script>
    const vscode = acquireVsCodeApi();
    for (const button of document.querySelectorAll('button[data-command]')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ kind: 'command', commandId: button.getAttribute('data-command') });
      });
    }
  </script>
</body>
</html>`;
}
