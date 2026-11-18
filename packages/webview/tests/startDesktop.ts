import type { EditorFactory } from "@ging/webview/desktop/editors";

/** Editors that make nothing: no suite but the diff viewer's draws a diff
 *  or a file. */
export const NO_EDITORS: EditorFactory = {
  createDiffViewer: () => Promise.reject(new Error("no editors in this suite")),
  createFileViewer: () => Promise.reject(new Error("no editors in this suite"))
};

/** Load the desktop entry and start it, as the app's page does
 *  (`apps/desktop/src/web/page.ts`). After `vi.resetModules()`, a fresh one. */
export async function startDesktop(editors: EditorFactory = NO_EDITORS): Promise<void> {
  const entry = await import("@ging/webview/desktop/main");
  entry.startDesktopEntry({ editors });
}
