/* The VS Code entry: the bundle `apps/vscode/esbuild.js` builds into
 * `out/web.min.js`. Loading it starts the graph view, exactly as it did when the
 * whole view lived in this file.
 *
 * It imports nothing that only the desktop host ships. The desktop entry,
 * `desktop/main.ts`, imports the same view and is where the desktop host's own
 * screens and message listener go; this one never imports it, so none of that
 * reaches the extension's bundle (ADR-0031). */

import { startGitGraphView } from "./gitGraphView";

startGitGraphView();
