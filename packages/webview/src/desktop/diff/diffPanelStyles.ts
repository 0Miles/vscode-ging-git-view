/* The diff viewer's styles (#404), a file shown read-only in it too (#405).
 * Written into the page by the desktop entry's own bundle rather than added
 * to media/main.css, which ships in the extension too (ADR-0031). Only
 * `--vscode-*` variables the desktop theme gives
 * (`apps/desktop/tests/theme.test.ts`).
 *
 * The viewer covers the graph's area and nothing else: the side-view column
 * (#399) and the working tree column (#403) each say how wide they are in
 * the variable named for them, on `<html>` or `<body>`, and the viewer leaves
 * them that much room. The file history column (#408), over the graph's area
 * at its left, does the same in its own variable, and the viewer opens to
 * its right, the list it was opened from still in view. Between the graph's
 * floating layers (300) and the graph's dialog backing (400): a dialog the
 * graph raises meanwhile is still seen, over it. */

export const DIFF_PANEL_STYLES = `
#diffViewer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: calc(var(--ging-side-view-width, 0px) + var(--ging-file-history-width, 0px));
  right: var(--ging-working-tree-width, 0px);
  z-index: 350;
  display: flex;
  flex-direction: column;
  background-color: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}
#diffViewer[hidden] {
  display: none;
}
#diffViewer:focus {
  outline: none;
}
#diffViewer .diffViewerBar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
#diffViewer .diffViewerTitle {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: inherit;
  font-weight: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#diffViewer .diffViewerLayouts {
  display: flex;
  flex: none;
}
#diffViewer .diffViewerLayouts[hidden] {
  display: none;
}
#diffViewer button {
  padding: 2px 8px;
  border: 1px solid var(--vscode-widget-border);
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  cursor: pointer;
}
#diffViewer .diffViewerLayouts button + button {
  border-left: none;
}
#diffViewer .diffViewerLayouts button:first-child {
  border-radius: 3px 0 0 3px;
}
#diffViewer .diffViewerLayouts button:last-child {
  border-radius: 0 3px 3px 0;
}
#diffViewer button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}
#diffViewer button[aria-pressed="true"] {
  background-color: var(--vscode-toolbar-activeBackground);
}
#diffViewer button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
#diffViewer .diffViewerClose {
  display: flex;
  flex: none;
  align-items: center;
  padding: 3px;
  border-color: transparent;
  border-radius: 3px;
}
#diffViewer .diffViewerClose svg {
  display: block;
  width: 16px;
  height: 16px;
  fill: var(--vscode-icon-foreground);
}
#diffViewer .diffViewerEditor {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
#diffViewer .diffViewerError {
  margin: 16px;
  color: var(--vscode-errorForeground);
}
#diffViewer .diffViewerNotice {
  margin: 16px;
  color: var(--vscode-descriptionForeground);
}
#diffViewer .diffViewerSaid {
  flex: none;
  margin: 0;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
}
#diffViewer .diffViewerKeys {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
#diffViewer .diffViewerHunkWidget {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  overflow: visible;
}
#diffViewer .diffViewerHunk {
  position: absolute;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding-left: 4px;
  white-space: nowrap;
}
#diffViewer .diffViewerHunk button {
  padding: 0 6px;
  border-radius: 2px;
  font-size: 11px;
  line-height: 16px;
  color: var(--vscode-button-secondaryForeground);
  background-color: var(--vscode-button-secondaryBackground);
  border-color: var(--vscode-button-border, transparent);
}
#diffViewer .diffViewerHunk button:hover {
  background-color: var(--vscode-button-secondaryHoverBackground);
}
`;
