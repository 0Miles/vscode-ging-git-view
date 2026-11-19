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
 * on their left; their right edges are the working tree's (#403). The scroll
 * shadow is the one place the two columns meet: the working tree sizes it by
 * `width`, which would carry it past the panel once its left edge moves, so
 * with both columns out it is pinned by its two edges instead. */

import { WORKING_TREE_WIDTH } from "@ging/webview/desktop/workingTree/workingTreePanel";

import { SIDE_VIEW_WIDTH } from "./protocol";

/** A row of a tree, in CSS pixels: what the Branches tree's window of drawn
 *  rows is reckoned in (#459). */
export const SIDE_VIEW_ROW_HEIGHT = 22;

export const SIDE_VIEW_STYLES = `
:root { --ging-side-view-width: ${SIDE_VIEW_WIDTH}px; }
body.gingSideViews { padding-left: var(--ging-side-view-width); }
body.gingSideViews #commitDetails.docked { left: var(--ging-side-view-width); }
body.gingSideViews #scrollShadow.active { left: var(--ging-side-view-width); right: 0; width: auto; }
body.gingSideViews.workingTreeOpen #scrollShadow.active { right: ${WORKING_TREE_WIDTH}px; width: auto; }
#sideViews {
  position: fixed; top: 0; bottom: 0; left: 0; width: var(--ging-side-view-width); box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden; z-index: 10;
  border-right: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-editor-background); color: var(--vscode-foreground);
  font-family: var(--vscode-font-family); font-size: 13px; user-select: none;
}
#sideViews[hidden], #sideViewResizer[hidden] { display: none; }
/* The column's edge (#459): a sash over its border, as VS Code's between two
   views, drawn in the focus colour while it is pointed at, dragged or has the
   keyboard. */
#sideViewResizer {
  position: fixed; top: 0; bottom: 0; left: calc(var(--ging-side-view-width) - 3px); width: 5px;
  z-index: 11; cursor: col-resize; touch-action: none; outline: none;
}
#sideViewResizer:hover, #sideViewResizer:focus-visible, body.sideViewResizing #sideViewResizer {
  background-color: var(--vscode-focusBorder);
}
body.sideViewResizing { cursor: col-resize; user-select: none; }
.sideView { display: flex; flex-direction: column; min-height: 0; flex: 0 0 auto; border-bottom: 1px solid var(--vscode-panel-border); }
#branchesView.open { flex: 2 1 0; }
#remotesView.open { flex: 1 1 0; }
#stashView.open { flex: 1 1 0; }
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
/* The Branches tree's drawn rows (#459): as tall as all of its rows, the
   ones drawn pushed down to where they sit. */
.sideViewRows { box-sizing: border-box; }
.sideViewRow { display: flex; align-items: center; height: ${SIDE_VIEW_ROW_HEIGHT}px; padding-right: 8px; white-space: nowrap; cursor: pointer; }
.sideViewRow:hover { background-color: var(--vscode-list-hoverBackground); }
.sideViewRow.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
/* As VS Code's lists: the selection of a list without the keyboard is drawn
   quieter, the theme's inactive selection with the text left as it is. */
#sideViews:not(:focus-within) .sideViewRow.selected { background-color: var(--vscode-list-inactiveSelectionBackground); color: inherit; }
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
/* A stash file's change, as VS Code's file decorations colour it; a rename as
   the working tree panel colours one (#403), the theme having no colour of its
   own for it. */
.sideViewFileBadge { margin-left: auto; padding-left: 6px; flex: 0 0 auto; font-size: 12px; }
.sideViewFileBadge.badgeA { color: var(--vscode-gitDecoration-addedResourceForeground); }
.sideViewFileBadge.badgeM, .sideViewFileBadge.badgeR { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
.sideViewFileBadge.badgeD { color: var(--vscode-gitDecoration-deletedResourceForeground); }
.sideViewFileBadge.badgeU { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
.sideViewRow.selected .sideViewFileBadge { color: inherit; }
.sideViewBadge { margin-left: auto; padding-left: 6px; flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
.sideViewEmpty { padding: 6px 12px; color: var(--vscode-descriptionForeground); white-space: normal; }
.sideViewEmpty button {
  display: block; margin-top: 6px; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground);
  font: inherit; cursor: pointer;
}
.sideViewEmpty button:hover { background-color: var(--vscode-button-hoverBackground); }
`;
