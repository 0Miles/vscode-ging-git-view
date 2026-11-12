/* The VS Code entry, bundled by `apps/vscode/esbuild.js` into
 * `out/web.min.js`. Loading it starts the graph view. It never imports
 * anything under `desktop/` (ADR-0031). */

import { startGitGraphView } from "./gitGraphView";

startGitGraphView();
