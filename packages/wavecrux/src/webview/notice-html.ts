/**
 * The page shown instead of the app when a file is recognised and cannot be
 * opened here.
 *
 * Deliberately not the Flutter build: booting a 16 MB payload to display two
 * sentences would take longer than reading them, and the sentences are the
 * whole answer. Deliberately not a notification either — a notification is
 * gone in five seconds and the user is left looking at an empty editor tab
 * wondering what happened.
 *
 * No script, and a CSP that allows none: nothing here is interactive.
 */

/** Escaping for text interpolated into the document. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a title + body notice.
 *
 * Both strings arrive localized; this function contains no user-facing text of
 * its own, which is what keeps `vscode.l10n.t()` at the call site where the
 * bundle can see it.
 */
export function renderNoticeHtml(options: {
  readonly title: string;
  readonly message: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
  <style>
    body {
      margin: 0; padding: 40px 32px; line-height: 1.6;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
    }
    .notice { max-width: 60ch; margin: 0 auto; }
    h1 { font-size: 1.25em; font-weight: 600; margin: 0 0 12px; }
    p { margin: 0; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="notice">
    <h1>${escapeHtml(options.title)}</h1>
    <p>${escapeHtml(options.message)}</p>
  </div>
</body>
</html>
`;
}
