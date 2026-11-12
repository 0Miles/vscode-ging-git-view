/* The VS Code entry: the bundle `apps/vscode/esbuild.js` builds into
 * `out/web.min.js`. Loading it starts the graph view, exactly as it did when the
 * whole view lived in this file.
 *
 * It imports nothing that only the desktop host ships. The desktop entry,
 * `desktop/main.ts`, imports the same view and adds its own screens and its own
 * message listener; this one never imports that, so none of it reaches the
 * extension's bundle (ADR-0031). */

import { startGitGraphView } from "./gitGraphView";

startGitGraphView();
