/* The window Show Statistics opens (#396): one at most, showing the figures
 * last asked for, as VS Code reuses one panel. Its page is the Statistics page
 * both hosts share (`statisticsMarkup.ts`) — no scripts, nothing loaded — served
 * at `ging://app/statistics` and built at each load, in the theme of the
 * moment; a theme change after that reaches it through the preload, as it
 * reaches every page. */

import path from "node:path";

import type { BrowserWindow } from "electron";

import type { L10n, Opener } from "@ging/core/host/ports";
import { renderStatisticsHtml, type StatisticsFigures } from "@ging/webview/statisticsMarkup";

import { keepPageInPlace } from "./pageGuard";
import type { Theme } from "./theme";

export type StatisticsWindow = {
  /** Show `figures` of `repo`, in a window of their own or the one showing
   *  others, brought forward. */
  show(figures: StatisticsFigures, repo: string): void;
  /** The page, built now in `theme`; `null` while there are no figures. */
  document(theme: Theme): string | null;
};

export function createStatisticsWindow({
  url,
  lang,
  createWindow,
  l10n,
  opener
}: {
  /** The page's address. */
  url: string;
  /** The language `l10n` speaks, for `<html lang>`. */
  lang: string;
  /** A window as the app makes them: themed, with the preload. */
  createWindow: () => BrowserWindow;
  l10n: L10n;
  /** Where a link out of the page would go: nothing leaves it otherwise. */
  opener: Pick<Opener, "openExternalUrl">;
}): StatisticsWindow {
  let win: BrowserWindow | null = null;
  let shown: StatisticsFigures | null = null;

  return {
    show(figures, repo) {
      shown = figures;
      const title = `${l10n.t("stats.title")} - ${path.basename(repo)}`;
      if (win === null || win.isDestroyed()) {
        const opened = createWindow();
        win = opened;
        keepPageInPlace(opened.webContents, opener);
        // The repository's name stays in the title: the page has no title of
        // its own to take its place with.
        opened.on("page-title-updated", (event) => event.preventDefault());
        opened.on("closed", () => {
          win = null;
        });
      } else if (win.isMinimized()) {
        win.restore();
      }
      win.setTitle(title);
      void win.loadURL(url);
      win.focus();
    },
    document(theme) {
      if (shown === null) return null;
      const style = Object.entries(theme.variables)
        .map(([name, value]) => `${name}: ${value};`)
        .join(" ");
      return renderStatisticsHtml(shown, (key, ...args) => l10n.t(key, ...args), {
        lang,
        htmlStyle: style
      });
    }
  };
}
