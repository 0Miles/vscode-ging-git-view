/**
 * What an editor tab shows, as far as the text documents it holds open go
 * (URIs as strings). The merge editor's input is a proposed API, not in the
 * VS Code 1.98 this extension supports, so its tabs read as `other`.
 */
export type TabContents =
  | { kind: "text"; uri: string }
  | { kind: "diff"; original: string; modified: string }
  | { kind: "other" };

/** Every document that a tab or a visible editor still holds open. */
export function openDocumentKeys(
  tabs: readonly TabContents[],
  visibleDocuments: readonly string[]
): Set<string> {
  const keys = new Set(visibleDocuments);
  for (const tab of tabs) {
    if (tab.kind === "text") keys.add(tab.uri);
    else if (tab.kind === "diff") {
      keys.add(tab.original);
      keys.add(tab.modified);
    }
  }
  return keys;
}
