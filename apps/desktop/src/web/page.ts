/* The page's bundle (out/web.js): the webview's desktop entry (ADR-0031),
 * started with what only the app has to hand it — the editors, which are
 * Monaco's (#404). Monaco itself is not in this bundle: a Tab's page loads it
 * on its first diff (lazyEditors.ts), and the window's own page and the
 * settings page never do. */

import { startDesktopEntry } from "@ging/webview/desktop/main";

import { lazyEditors } from "./lazyEditors";

startDesktopEntry({ editors: lazyEditors(document) });
