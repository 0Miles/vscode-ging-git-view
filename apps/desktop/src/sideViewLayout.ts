/* How the side views' column sits in every Tab (#459): the width the user
 * dragged it to, and whether the View menu's Side Views shows it. The app's,
 * kept in `HostStorage`'s global tier as the theme is (themeChoice.ts): a new
 * Tab and the next launch open with it. Neither is a repository's — a width
 * per repository is nothing anyone would miss. */

import type { StateStore } from "@ging/core/host/ports";
import {
  clampSideViewWidth,
  DEFAULT_SIDE_VIEW_LAYOUT,
  type SideViewLayout
} from "@ging/webview/desktop/sideViews/protocol";

/** Their keys in the global tier: the desktop host's own, beside core's. */
const WIDTH_KEY = "desktopSideViewWidth";
const SHOWN_KEY = "desktopSideViewShown";

export type SideViewLayoutStore = {
  /** As kept; the defaults where nothing, or nothing usable, is. */
  get(): SideViewLayout;
  /** Keep `width`, held to the column's bounds. */
  setWidth(width: number): void;
  setShown(shown: boolean): void;
  /** Heard after each change that moved something: every Tab follows. */
  onDidChange(listener: (layout: SideViewLayout) => void): { dispose(): void };
};

export function createSideViewLayoutStore(store: StateStore): SideViewLayoutStore {
  const listeners = new Set<(layout: SideViewLayout) => void>();

  const get = (): SideViewLayout => {
    const width = store.get<unknown>(WIDTH_KEY, undefined);
    const shown = store.get<unknown>(SHOWN_KEY, undefined);
    return {
      // A later version's, or a hand-edited file's, is held to what this one
      // draws.
      width:
        typeof width === "number" && Number.isFinite(width)
          ? clampSideViewWidth(width)
          : DEFAULT_SIDE_VIEW_LAYOUT.width,
      shown: typeof shown === "boolean" ? shown : DEFAULT_SIDE_VIEW_LAYOUT.shown
    };
  };

  const write = (key: string, value: unknown) => {
    const before = get();
    void store.update(key, value);
    const after = get();
    if (after.width === before.width && after.shown === before.shown) return;
    for (const listener of listeners) listener(after);
  };

  return {
    get,
    setWidth: (width) => write(WIDTH_KEY, clampSideViewWidth(width)),
    setShown: (shown) => write(SHOWN_KEY, shown),
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    }
  };
}
