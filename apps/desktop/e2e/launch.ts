import path from "node:path";

import { _electron, type ElectronApplication } from "@playwright/test";

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
export const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
export const ELECTRON = require("electron") as unknown as string;
/** Loaded ahead of the app's main: see quietWindows.js. */
const QUIET_WINDOWS = path.join(__dirname, "quietWindows.js");

/**
 * Start the app the way every E2E does: `args` as on its command line (the app
 * directory among them), `env` for it and its git. Its windows are drawn out
 * of the user's sight and never take the keyboard or the mouse
 * (quietWindows.js), so a local run leaves the desktop alone;
 * `GING_E2E_SHOW=1` shows them as the app would, to watch a run.
 */
export function launchApp(args: string[], env?: NodeJS.ProcessEnv): Promise<ElectronApplication> {
  const quiet = process.env.GING_E2E_SHOW === "1" ? [] : ["-r", QUIET_WINDOWS];
  return _electron.launch({
    executablePath: ELECTRON,
    args: [...quiet, ...args],
    ...(env !== undefined && { env: env as Record<string, string> })
  });
}
