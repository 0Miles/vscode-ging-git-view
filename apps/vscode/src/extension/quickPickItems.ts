import type { PickItem } from "@ging/core/host/ports";

/**
 * `items` as the rows of VS Code's QuickPick, for `Prompts.pick` and
 * `pickMany`: a `warning` row's label leads with the warning icon, a
 * `separatorAbove` row comes after `separator` — VS Code's own separator row,
 * handed in — and every other row keeps its `value`, which is what the prompt
 * answers.
 *
 * Kept free of `vscode` so that is pinned by a unit test (ADR-0018).
 */
export function quickPickItems<T, S>(
  items: readonly PickItem<T>[],
  separator: S
): (PickItem<T> | S)[] {
  return items.flatMap((item) => {
    const row = item.warning ? { ...item, label: `$(warning) ${item.label}` } : item;
    return item.separatorAbove ? [separator, row] : [row];
  });
}
