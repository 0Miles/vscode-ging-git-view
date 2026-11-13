import type { MessageBoxOptions, SaveDialogOptions } from "electron";
import { describe, expect, it } from "vitest";

import { createInterimPrompts, type NativeDialogs } from "@ging/desktop/ports/prompts";

// The interim desktop `Prompts` (#388), until the in-page host prompts (#390):
// what the dispatch asks — notices and where to save a file — as the system's
// own dialogs, reached through a seam so neither these tests nor the E2E ever
// meets a real one (ADR-0032).

/** Dialogs that record what they were asked and answer as told. */
function fakeDialogs(answers: { button?: number; savedTo?: string } = {}) {
  const shown: MessageBoxOptions[] = [];
  const saves: SaveDialogOptions[] = [];
  const dialogs: NativeDialogs = {
    showMessageBox: async (options) => {
      shown.push(options);
      return { response: answers.button ?? 0 };
    },
    showSaveDialog: async (options) => {
      saves.push(options);
      return answers.savedTo === undefined
        ? { canceled: true }
        : { canceled: false, filePath: answers.savedTo };
    }
  };
  return { dialogs, shown, saves };
}

const l10n = { t: (key: string) => `<${key}>` };

function make(answers?: { button?: number; savedTo?: string }) {
  const fake = fakeDialogs(answers);
  const errors: string[] = [];
  const prompts = createInterimPrompts({
    dialogs: fake.dialogs,
    l10n,
    logger: { logError: (message) => errors.push(message) }
  });
  return { prompts, errors, ...fake };
}

describe("the interim desktop prompts", () => {
  it("shows a plain notice in a box of its kind, with the system's own button", async () => {
    const { prompts, shown } = make();

    await prompts.showInformation("Fetched.");
    prompts.showWarning("Careful.");
    await prompts.showError("Broke.");

    expect(shown).toEqual([
      { type: "info", message: "Fetched.", buttons: [] },
      { type: "warning", message: "Careful.", buttons: [] },
      { type: "error", message: "Broke.", buttons: [] }
    ]);
  });

  it("answers a notice's action with its value, offering a way out besides", async () => {
    const { prompts, shown } = make({ button: 1 });

    const answer = await prompts.showInformation("Version 1.0", {
      modal: true,
      actions: [
        { label: "Copy", value: "copy" },
        { label: "Copy", value: "copy-all" }
      ]
    });

    expect(answer).toBe("copy-all");
    expect(shown[0]).toEqual({
      type: "info",
      message: "Version 1.0",
      buttons: ["Copy", "Copy", "<dialog.cancel>"],
      cancelId: 2
    });
  });

  it("answers an error's action with its label, and the way out with nothing", async () => {
    const chosen = make({ button: 0 });
    expect(await chosen.prompts.showError("Broke.", "Show Log")).toBe("Show Log");
    expect(chosen.shown[0]).toMatchObject({
      buttons: ["Show Log", "<dialog.cancel>"],
      cancelId: 1
    });

    const dismissed = make({ button: 1 });
    expect(await dismissed.prompts.showError("Broke.", "Show Log")).toBeUndefined();
  });

  it("asks where to save with the label, filters and default the dispatch gives", async () => {
    const { prompts, saves } = make({ savedTo: "/repo/main.zip" });

    const answer = await prompts.pickSaveLocation({
      saveLabel: "Create Archive",
      filters: { Archives: ["zip", "tar"] },
      defaultPath: "/repo/main.zip"
    });

    expect(answer).toBe("/repo/main.zip");
    expect(saves).toEqual([
      {
        buttonLabel: "Create Archive",
        filters: [{ name: "Archives", extensions: ["zip", "tar"] }],
        defaultPath: "/repo/main.zip"
      }
    ]);
  });

  it("answers a cancelled save as no location", async () => {
    const { prompts } = make();
    const answer = await prompts.pickSaveLocation({
      saveLabel: "Export",
      filters: {},
      defaultPath: "/repo/x.patch"
    });
    expect(answer).toBeUndefined();
  });

  it("answers what it cannot ask yet as dismissed, and logs that it was asked", async () => {
    const { prompts, shown, errors } = make();

    const answers = await Promise.all([
      prompts.input({ prompt: "Username" }),
      prompts.pick([{ label: "origin", value: "origin" }]),
      prompts.pickMany([{ label: "origin", value: "origin" }]),
      prompts.choose("Drop?", { actions: [{ label: "Drop", value: true }] })
    ]);

    expect(answers).toEqual([undefined, undefined, undefined, undefined]);
    expect(shown).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/input.*Username/);
  });
});
