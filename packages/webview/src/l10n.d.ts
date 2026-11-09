/**
 * Type definitions for localized strings in webview.
 * The shape is spelled out in localizedStrings.ts; the host fills it in
 * (getWebviewLocalizedStrings in apps/vscode).
 */

import type { LocalizedStrings } from "@ging/webview/localizedStrings";

declare global {
  /**
   * Localized strings provided by the extension context.
   * Available in the webview via a global variable injected in the HTML.
   */
  var l10n: LocalizedStrings;
}
