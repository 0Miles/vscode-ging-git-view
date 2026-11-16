/* The desktop `Prompts` (`@ging/core/host/ports`), one per webview instance
 * (#388, #390). The questions — pick, pickMany, choose, input — are asked in
 * that instance's page, in the host prompt overlay of the webview's desktop
 * entry, which stands over the graph's own dialog rather than taking its slot
 * (ADR-0031). The notices and where to save a file are the system's own
 * dialogs. */

import type { MessageBoxOptions, SaveDialogOptions } from "electron";

import type { HostLogger, L10n, Prompts } from "@ging/core/host/ports";
import type {
  HostPrompt,
  HostPromptAnswer,
  HostPromptMessage,
  HostPromptReply
} from "@ging/webview/desktop/hostPrompt";

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

/** The page of the instance that asks: where its prompts are shown. */
export type PromptPage = {
  post(message: HostPromptMessage): void;
};

type DesktopPromptsDeps = {
  dialogs: NativeDialogs;
  l10n: L10n;
  logger: Pick<HostLogger, "log">;
  page: PromptPage;
  /** Told when a question starts waiting for an answer with none waiting
   *  before (`true`), and when the last one waiting is answered or dropped
   *  (`false`): the tab strip marks a Tab that is asking (#393). */
  onAsking?: (asking: boolean) => void;
};

/** The instance's `Prompts`, and what the main process tells it of its page. */
export type DesktopPrompts = Prompts & {
  /** A reply the page posted: that it is listening, or an answer. */
  receive(reply: HostPromptReply): void;
  /** The page is loading anew: until it says it is listening, prompts wait.
   *  The ones it was showing are shown again, not lost — git may be blocked
   *  on one waiting for a credential. */
  pageLoading(): void;
  /** The instance is gone: what is still asked is answered as dismissed, and
   *  so is whatever is asked from now on. */
  dispose(): void;
};

/** `index` as a position in `list`, or `undefined` when it is none. */
function at<T>(list: readonly T[], index: HostPromptAnswer): T | undefined {
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < list.length
    ? list[index]
    : undefined;
}

export function createDesktopPrompts({
  dialogs,
  l10n,
  logger,
  page,
  onAsking = () => {}
}: DesktopPromptsDeps): DesktopPrompts {
  /** Asked and not yet answered, by id, in the order they were asked. */
  const pending = new Map<
    number,
    { message: HostPromptMessage; settle: (answer: HostPromptAnswer) => void }
  >();
  let nextId = 0;
  let listening = false;
  let disposed = false;

  /** Ask `prompt` in the page, now or once it listens; resolves to the
   *  page's answer, `null` when dismissed. */
  const ask = (prompt: HostPrompt): Promise<HostPromptAnswer> =>
    new Promise((settle) => {
      if (disposed) {
        settle(null);
        return;
      }
      const message: HostPromptMessage = {
        command: "hostPrompt",
        id: ++nextId,
        prompt,
        labels: { ok: l10n.t("desktop.prompt.ok"), cancel: l10n.t("dialog.cancel") }
      };
      pending.set(message.id, { message, settle });
      if (pending.size === 1) onAsking(true);
      if (listening) page.post(message);
    });

  /** A notice of `type` offering `labels`, plus a way out; resolves to the
   *  index of the label clicked, or `undefined` for the way out. With no
   *  labels, the system's own single button, whose answer is nothing. */
  const notify = async (
    type: "info" | "warning" | "error",
    message: string,
    labels: readonly string[]
  ): Promise<number | undefined> => {
    const { response } = await dialogs.showMessageBox({
      type,
      message,
      buttons: labels.length === 0 ? [] : [...labels, l10n.t("dialog.cancel")],
      ...(labels.length > 0 && { cancelId: labels.length })
    });
    return response < labels.length ? response : undefined;
  };

  return {
    showInformation: async (message, { actions = [] } = {}) => {
      // `modal` changes nothing: a system dialog is modal either way.
      const index = await notify(
        "info",
        message,
        actions.map((action) => action.label)
      );
      return index === undefined ? undefined : actions[index].value;
    },
    showWarning: (message) => {
      void notify("warning", message, []);
    },
    showError: async (message, ...actions) => {
      const index = await notify("error", message, actions);
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

    choose: async (message, { detail, actions }) => {
      const answer = await ask({
        kind: "choose",
        message,
        ...(detail !== undefined && { detail }),
        actions: actions.map((action) => action.label)
      });
      return at(actions, answer)?.value;
    },
    pick: async (items, { placeholder, matchOnDescription = false } = {}) => {
      const answer = await ask({
        kind: "pick",
        items: items.map(({ label, description, warning }) => ({ label, description, warning })),
        placeholder,
        matchOnDescription
      });
      return at(items, answer)?.value;
    },
    pickMany: async (items, { placeholder, matchOnDescription = false } = {}) => {
      const answer = await ask({
        kind: "pickMany",
        items: items.map(({ label, description, picked, warning }) => ({
          label,
          description,
          picked,
          warning
        })),
        placeholder,
        matchOnDescription
      });
      if (!Array.isArray(answer)) return undefined;
      // In the order of the rows, each once, whatever order the page listed them in.
      return items.filter((_, index) => answer.includes(index)).map((item) => item.value);
    },
    input: async ({ prompt, placeholder, password = false, value }) => {
      const answer = await ask({ kind: "input", prompt, placeholder, password, value });
      return typeof answer === "string" ? answer : undefined;
    },

    receive: (reply) => {
      if (reply.command === "hostPromptReady") {
        listening = true;
        for (const { message } of pending.values()) page.post(message);
        return;
      }
      const asked = pending.get(reply.id);
      if (asked === undefined) {
        // Answered twice, or after the instance let it go: nobody is waiting.
        logger.log(`prompts: an answer to prompt ${reply.id}, which nobody is waiting for`);
        return;
      }
      pending.delete(reply.id);
      if (pending.size === 0) onAsking(false);
      asked.settle(reply.answer);
    },
    pageLoading: () => {
      listening = false;
    },
    dispose: () => {
      disposed = true;
      listening = false;
      const asking = pending.size > 0;
      for (const { settle } of pending.values()) settle(null);
      pending.clear();
      if (asking) onAsking(false);
    }
  };
}
