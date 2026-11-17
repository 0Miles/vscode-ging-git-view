/* The side views' styles (#399). Written into the page by the desktop entry's
 * own bundle rather than added to media/main.css, which ships in the
 * extension too (ADR-0031); only the `--vscode-*` variables the desktop
 * theme provides (apps/desktop/tests/theme.test.ts).
 *
 * The column is the region ADR-0031 drew for it: the left edge of the window,
 * full height, `position: fixed`, owning `body`'s `padding-left` so the graph —
 * which measures the window's scroll — keeps the document's scroll and loses
 * only the column's width. The two things of the graph's that span the window
 * (the docked Commit Details View and `#scrollShadow`) give up the same width
 * on their left; their right edges are the working tree's (#403). */

/** The column's width, in CSS pixels. */
export const SIDE_VIEW_WIDTH = 260;

export const SIDE_VIEW_STYLES = `
:root { --ging-side-view-width: ${SIDE_VIEW_WIDTH}px; }
body.gingSideViews { padding-left: var(--ging-side-view-width); }
body.gingSideViews #commitDetails.docked { left: var(--ging-side-view-width); }
body.gingSideViews #scrollShadow.active { left: var(--ging-side-view-width); right: 0; width: auto; }
#sideViews {
  position: fixed; top: 0; bottom: 0; left: 0; width: var(--ging-side-view-width); box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden; z-index: 10;
  border-right: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-editor-background); color: var(--vscode-foreground);
  font-family: var(--vscode-font-family); font-size: 13px; user-select: none;
}
.sideView { display: flex; flex-direction: column; min-height: 0; flex: 0 0 auto; border-bottom: 1px solid var(--vscode-panel-border); }
#branchesView.open { flex: 2 1 0; }
#remotesView.open { flex: 1 1 0; }
.sideViewHeader { display: flex; align-items: center; height: 24px; padding: 0 4px 0 2px; flex: 0 0 auto; }
.sideViewTitle {
  display: flex; align-items: center; gap: 2px; flex: 1 1 auto; min-width: 0; height: 100%; padding: 0;
  border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; font-weight: bold;
  text-transform: uppercase; text-align: left; cursor: pointer;
}
.sideViewTitle svg, .sideViewTwisty svg { fill: currentColor; transition: transform 0.1s; }
.sideView:not(.open) .sideViewTitle svg { transform: rotate(-90deg); }
.sideViewTitle:focus-visible, .sideViewActions button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.sideViewActions { display: flex; gap: 2px; flex: 0 0 auto; }
.sideViewActions button {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer;
}
.sideViewActions button:hover { background-color: var(--vscode-toolbar-hoverBackground); }
.sideViewActions svg { fill: currentColor; }
.sideView:not(.open) .sideViewActions, .sideView:not(.open) .sideViewBody { display: none; }
.sideViewBody { flex: 1 1 auto; min-height: 0; overflow: auto; outline: none; }
.sideViewRow { display: flex; align-items: center; height: 22px; padding-right: 8px; white-space: nowrap; cursor: pointer; }
.sideViewRow:hover { background-color: var(--vscode-list-hoverBackground); }
.sideViewRow.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.sideViewRow:focus { outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; }
.sideViewRow.contextMenuActive { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.sideViewTwisty { display: flex; align-items: center; justify-content: center; width: 16px; flex: 0 0 16px; }
.sideViewRow[aria-expanded="false"] .sideViewTwisty svg { transform: rotate(-90deg); }
.sideViewIcon { display: flex; align-items: center; width: 16px; flex: 0 0 16px; margin-right: 4px; }
.sideViewIcon svg { fill: currentColor; }
.sideViewLabel { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.sideViewRow.group .sideViewLabel { font-size: 11px; font-weight: bold; text-transform: uppercase; }
.sideViewRow.dimmed .sideViewLabel { color: var(--vscode-disabledForeground); }
.sideViewDescription { margin-left: 6px; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
.sideViewRow.selected .sideViewDescription { color: inherit; }
.sideViewBadge { margin-left: auto; padding-left: 6px; flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
.sideViewEmpty { padding: 6px 12px; color: var(--vscode-descriptionForeground); white-space: normal; }
.sideViewEmpty button {
  display: block; margin-top: 6px; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground);
  font: inherit; cursor: pointer;
}
.sideViewEmpty button:hover { background-color: var(--vscode-button-hoverBackground); }
`;
