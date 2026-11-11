/**
 * Steps the core's command services share: asking a yes-or-no question, and
 * (below) finding the current repository, listing its remotes and running a
 * change to it, each failure said the same way.
 */

import type { Prompts } from "@ging/core/host/ports";

/** A modal yes-or-no question whose one way to say yes is `confirmLabel`;
 *  resolves to whether it was said. */
export async function confirm(
  prompts: Pick<Prompts, "choose">,
  message: string,
  confirmLabel: string
): Promise<boolean> {
  return (
    (await prompts.choose(message, { actions: [{ label: confirmLabel, value: true }] })) ?? false
  );
}
