/**
 * What the window itself says about the graph panel: which of its tabs already
 * hold one, and whether this window may be given one uninvited.
 *
 * A window holds at most one graph panel, but the extension's handle to it dies
 * with the extension host. On a host restart VSCode brings the panel's *tab*
 * back while the extension starts from a blank slate, and it defers
 * `WebviewPanelSerializer.deserializeWebviewPanel` until that tab first becomes
 * visible — so until the user clicks it, the tab list is the only trace of the
 * panel there is. That is what we reconcile against before opening another one.
 */

/** The `viewType` the graph panel is created with, and its serializer's id. */
export const GRAPH_VIEW_TYPE = "ging-git-view";

/** A `vscode.Tab`, reduced to the one field that identifies what it holds. */
type TabLike = { readonly input: unknown };

/**
 * Whether a tab holds the graph panel. Matched structurally, and through
 * VSCode's `mainThreadWebview-` prefix: a panel created with view type `x`
 * comes back out of `TabInputWebview` as `mainThreadWebview-x`
 * (microsoft/vscode#150031), and both spellings are in the wild.
 */
export function isGraphWebviewTab(tab: TabLike): boolean {
  const input = tab.input;
  if (typeof input !== "object" || input === null || !("viewType" in input)) return false;
  const viewType = (input as { viewType: unknown }).viewType;
  return viewType === GRAPH_VIEW_TYPE || viewType === "mainThreadWebview-" + GRAPH_VIEW_TYPE;
}

/** Every graph tab currently open in the window, in tab order. */
export function findGraphTabs<T extends TabLike>(
  groups: readonly { readonly tabs: readonly T[] }[]
): T[] {
  return groups.flatMap((group) => group.tabs.filter((tab) => isGraphWebviewTab(tab)));
}

/**
 * Whether GING may put a graph panel in this window without being asked —
 * following the Source Control selection, or reviving one VSCode restored.
 *
 * Only a window with a workspace open qualifies. An empty window still sees
 * repos (the built-in git extension picks them up from open files and parent
 * folders), so without this gate the graph pops up in a window the user never
 * opened a project in. Explicit commands are unaffected: asking for the graph
 * in an empty window still opens it.
 */
export function mayOpenGraphUnprompted(workspaceFolders: readonly unknown[] | undefined): boolean {
  return workspaceFolders !== undefined && workspaceFolders.length > 0;
}
