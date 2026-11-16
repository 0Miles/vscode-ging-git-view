/* Which theme the user chose for the app (#397): dark, light, or the system's.
 * Kept in `HostStorage`'s global tier, so the next launch opens in it; the
 * main process hands it to Electron as `nativeTheme.themeSource`, which every
 * window then follows (main.ts). */

import type { StateStore } from "@ging/core/host/ports";
import { THEME_CHOICES, type ThemeChoice } from "@ging/webview/desktop/settings/protocol";

/** Its key in the global tier: the desktop host's own, beside core's. */
const KEY = "desktopTheme";

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  (THEME_CHOICES as readonly unknown[]).includes(value);

/** The choice kept in `store`; the system's, where none was made or what is
 *  there is not one (a later version's, say). */
export function readThemeChoice(store: StateStore): ThemeChoice {
  const kept = store.get<unknown>(KEY, "system");
  return isThemeChoice(kept) ? kept : "system";
}

export function writeThemeChoice(store: StateStore, choice: ThemeChoice): PromiseLike<void> {
  return store.update(KEY, choice);
}
