import englishBundle from "@ging/shared/l10n/bundle.l10n.json";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

/* Apart from setup.ts for the reason viewStateFixture.ts is: the webview
 * harness bundles it and runs it under plain node, so it may not import
 * vitest or the DOM. */

/** The webview's strings as an English-speaking user gets them: each key looked
 *  up in the base bundle, the key itself where the bundle has nothing. */
export function englishStrings() {
  const bundle: Record<string, string> = englishBundle;
  return getWebviewLocalizedStrings((key) => bundle[key] || key);
}
