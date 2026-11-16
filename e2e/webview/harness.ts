import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "../..");

/** The webview's entries the harness builds a page for (ADR-0031). */
export const ENTRIES = ["vscode", "desktop"] as const;
export type Entry = (typeof ENTRIES)[number];

/** Build the harness page for `entry` through the script's own command line,
 *  into out/webview-harness/<entry>/. */
export function buildHarness(entry: Entry): void {
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "webview-harness.js"),
    `--entry=${entry}`
  ]);
}

/** The file:// URL of `entry`'s harness page, built by the global setup. */
export function harnessPage(entry: Entry): string {
  return pathToFileURL(path.join(ROOT, "out", "webview-harness", entry, "index.html")).href;
}
