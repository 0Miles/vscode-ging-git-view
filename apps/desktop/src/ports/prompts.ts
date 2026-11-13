/* The desktop `Prompts` (`@ging/core/host/ports`) for now (#388): only what
 * the dispatch asks — the three notices and where to save a file — shown as
 * the system's own dialogs. The in-page host prompts of #390 replace it. */

import type { MessageBoxOptions, SaveDialogOptions } from "electron";

import type { HostLogger, L10n, Prompts } from "@ging/core/host/ports";

/**
 * Electron's `dialog`, as far as the prompts use it, already attached to the
 * window that asks. A seam rather than `dialog` itself: no test can click a
 * native dialog (ADR-0032), so the vitest suite answers through a fake, and
 * the main process hands over functions that look `dialog` up when called.
 */
export type NativeDialogs = {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
  showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
};

export type InterimPromptsDeps = {
  dialogs: NativeDialogs;
  l10n: L10n;
  logger: Pick<HostLogger, "logError">;
};

export function createInterimPrompts({ dialogs, l10n, logger }: InterimPromptsDeps): Prompts {
  /** A box of `type` offering `labels`, plus a way out; resolves to the index
   *  of the label clicked, or `undefined` for the way out. With no labels, the
   *  system's own single button, whose answer is nothing. */
  const ask = async (
    type: "info" | "warning" | "error",
    message: string,
    labels: readonly string[]
  ): Promise<number | undefined> => {
    const options: MessageBoxOptions =
      labels.length === 0
        ? { type, message, buttons: [] }
        : {
            type,
            message,
            buttons: [...labels, l10n.t("dialog.cancel")],
            cancelId: labels.length
          };
    const { response } = await dialogs.showMessageBox(options);
    return response < labels.length ? response : undefined;
  };

  /** What #390 brings: for now the question is answered as dismissed, and the
   *  log says it was asked, since nothing on screen will. */
  const notYet = (method: string, about: string): Promise<undefined> => {
    logger.logError(`Prompts.${method} is not available yet (#390), answered as dismissed: ${about}`);
    return Promise.resolve(undefined);
  };

  return {
    showInformation: async (message, { actions = [] } = {}) => {
      // `modal` changes nothing: a system dialog is modal either way.
      const index = await ask(
        "info",
        message,
        actions.map((action) => action.label)
      );
      return index === undefined ? undefined : actions[index].value;
    },
    showWarning: (message) => {
      void ask("warning", message, []);
    },
    showError: async (message, ...actions) => {
      const index = await ask("error", message, actions);
      return index === undefined ? undefined : actions[index];
    },
    pickSaveLocation: async ({ saveLabel, filters, defaultPath }) => {
      const { canceled, filePath } = await dialogs.showSaveDialog({
        buttonLabel: saveLabel,
        filters: Object.entries(filters).map(([name, extensions]) => ({ name, extensions })),
        defaultPath
      });
      return canceled || filePath === undefined || filePath === "" ? undefined : filePath;
    },
    choose: (message) => notYet("choose", message),
    pick: (items) => notYet("pick", items.map((item) => item.label).join(", ")),
    pickMany: (items) => notYet("pickMany", items.map((item) => item.label).join(", ")),
    input: ({ prompt }) => notYet("input", prompt)
  };
}
