import type { PickItem } from "@ging/core/host/ports";

/**
 * `items` as the rows of VS Code's QuickPick, for `Prompts.pick` and
 * `pickMany`: a `warning` row's label leads with the warning icon, and every
 * row keeps its `value`, which is what the prompt answers.
 *
 * Kept free of `vscode` so that is pinned by a unit test (ADR-0018).
 */
export function quickPickItems<T>(items: readonly PickItem<T>[]): PickItem<T>[] {
  return items.map((item) =>
    item.warning ? { ...item, label: `$(warning) ${item.label}` } : item
  );
}
