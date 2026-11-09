/**
 * Type definitions for localized strings in webview.
 * The shape is what getWebviewLocalizedStrings (webviewL10n.ts) returns; the
 * host calls it with its own translator and injects the result.
 */

import type { LocalizedStrings } from "@ging/webview/webviewL10n";

declare global {
  /**
   * Localized strings provided by the extension context.
   * Available in the webview via a global variable injected in the HTML.
   */
  var l10n: LocalizedStrings;
}
