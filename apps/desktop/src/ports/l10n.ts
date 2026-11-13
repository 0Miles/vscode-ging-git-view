/* The desktop `L10n` (`@ging/core/host/ports`): the l10n bundles of
 * packages/shared/l10n, the same ones VS Code loads for the extension, bundled
 * into the main process at build time. */

import type { L10n } from "@ging/core/host/ports";
import english from "@ging/shared/l10n/bundle.l10n.json";
import simplifiedChinese from "@ging/shared/l10n/bundle.l10n.zh-cn.json";
import traditionalChinese from "@ging/shared/l10n/bundle.l10n.zh-tw.json";

type Bundle = Record<string, string>;

const BUNDLES: Record<string, Bundle> = {
  "zh-cn": simplifiedChinese,
  "zh-tw": traditionalChinese
};

/** The bundle a locale (Electron's `app.getLocale()`, e.g. `zh-TW`) reads, by
 *  the name VS Code gives it; null for the English base bundle. Chinese
 *  written in traditional characters — Taiwan, Hong Kong, Macau, or said
 *  outright — reads zh-tw, any other Chinese zh-cn. */
export function bundleLocale(locale: string): string | null {
  const tags = locale.toLowerCase().split(/[-_]/);
  if (tags[0] !== "zh") return null;
  return tags.some((tag) => ["tw", "hk", "mo", "hant"].includes(tag)) ? "zh-tw" : "zh-cn";
}

/** Strings from `localized`, else from the English `base`, else the key
 *  itself; `{0}`, `{1}`… stand for the arguments, as in VS Code's `l10n.t`. */
export function createL10n(base: Bundle, localized: Bundle = {}): L10n {
  return {
    t: (key, ...args) =>
      (localized[key] ?? base[key] ?? key).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
        const arg = args[Number(index)];
        return arg === undefined ? placeholder : String(arg);
      })
  };
}

export function createDesktopL10n(locale: string): L10n {
  const bundle = bundleLocale(locale);
  return createL10n(english, bundle === null ? undefined : BUNDLES[bundle]);
}
