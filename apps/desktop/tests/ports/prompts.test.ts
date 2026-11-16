import type { MessageBoxOptions, SaveDialogOptions } from "electron";
import { describe, expect, it } from "vitest";

import { createDesktopPrompts, type NativeDialogs } from "@ging/desktop/ports/prompts";
import type { HostPromptAnswer, HostPromptMessage } from "@ging/webview/desktop/hostPrompt";

// The desktop `Prompts` (#390): notices and where to save a file as the
// system's own dialogs, reached through a seam so neither these tests nor the
// E2E ever meets a real one (ADR-0032); the questions asked in the instance's
// page, over the host prompt overlay's protocol. The page here is a fake that
// records what it was shown, and answers as the overlay would.

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
  const logged: string[] = [];
  const posted: HostPromptMessage[] = [];
  const prompts = createDesktopPrompts({
    dialogs: fake.dialogs,
    l10n,
    logger: { log: (line: string) => logged.push(line) },
    page: { post: (message) => posted.push(message) }
  });
  /** The page loaded and listening, as the desktop entry says it is. */
  const listen = () => prompts.receive({ command: "hostPromptReady" });
  /** The page's answer to the prompt it was shown last. */
  const answerLast = (answer: HostPromptAnswer) =>
    prompts.receive({ command: "hostPromptAnswer", id: posted.at(-1)!.id, answer });
  return { prompts, logged, posted, listen, answerLast, ...fake };
}

/** Let the prompt's promise run up to its next await. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the desktop prompts' notices", () => {
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
});

describe("the desktop prompts' questions, asked in the page", () => {
  it("holds a question back until the page listens, then shows it with the host's labels", async () => {
    const { prompts, posted, listen } = make();

    void prompts.input({ prompt: "Username for 'https://example.com':" });
    expect(posted).toEqual([]);

    listen();
    expect(posted).toEqual([
      {
        command: "hostPrompt",
        id: expect.any(Number),
        prompt: {
          kind: "input",
          prompt: "Username for 'https://example.com':",
          password: false,
          placeholder: undefined,
          value: undefined
        },
        labels: { ok: "<desktop.prompt.ok>", cancel: "<dialog.cancel>" }
      }
    ]);
  });

  it("sends questions in the order they were asked, each under an id of its own", () => {
    const { prompts, posted, listen } = make();
    listen();

    void prompts.input({ prompt: "first" });
    void prompts.input({ prompt: "second", password: true });

    expect(posted.map((m) => m.prompt)).toMatchObject([
      { kind: "input", prompt: "first", password: false },
      { kind: "input", prompt: "second", password: true }
    ]);
    expect(new Set(posted.map((m) => m.id)).size).toBe(2);
  });

  it("answers an input with the text the page sends, and a dismissal with nothing", async () => {
    const { prompts, listen, answerLast } = make();
    listen();

    const typed = prompts.input({ prompt: "Password", password: true, value: "start" });
    answerLast("hunter2");
    expect(await typed).toBe("hunter2");

    const dismissed = prompts.input({ prompt: "Password" });
    answerLast(null);
    expect(await dismissed).toBeUndefined();
  });

  it("answers a pick with the value of the row the page chose, by its index", async () => {
    const { prompts, posted, listen, answerLast } = make();
    listen();
    const origin = { name: "origin" };
    const upstream = { name: "upstream" };

    const picked = prompts.pick(
      [
        { label: "origin", value: origin },
        { label: "upstream", description: "github", warning: true, value: upstream }
      ],
      { placeholder: "Select a remote", matchOnDescription: true }
    );

    // Rows without their values: those stay here.
    expect(posted[0].prompt).toEqual({
      kind: "pick",
      items: [
        { label: "origin", description: undefined, warning: undefined },
        { label: "upstream", description: "github", warning: true }
      ],
      placeholder: "Select a remote",
      matchOnDescription: true
    });
    answerLast(1);
    expect(await picked).toBe(upstream);
  });

  it("answers an index that is no row as dismissed", async () => {
    const { prompts, listen, answerLast } = make();
    listen();

    const picked = prompts.pick([{ label: "origin", value: "origin" }]);
    answerLast(3);
    expect(await picked).toBeUndefined();
  });

  it("answers a pickMany with the checked rows' values in the rows' order, none included", async () => {
    const { prompts, posted, listen, answerLast } = make();
    listen();
    const items = [
      { label: "a", value: "A", picked: true },
      { label: "b", value: "B" },
      { label: "c", value: "C", picked: true }
    ];

    const some = prompts.pickMany(items);
    expect(posted[0].prompt).toMatchObject({
      kind: "pickMany",
      items: [{ picked: true }, { picked: undefined }, { picked: true }],
      matchOnDescription: false
    });
    answerLast([2, 0, 0]);
    expect(await some).toEqual(["A", "C"]);

    const none = prompts.pickMany(items);
    answerLast([]);
    expect(await none).toEqual([]);

    const dismissed = prompts.pickMany(items);
    answerLast(null);
    expect(await dismissed).toBeUndefined();
  });

  it("answers a choice with the clicked action's value, the page adding Cancel", async () => {
    const { prompts, posted, listen, answerLast } = make();
    listen();

    const chosen = prompts.choose("Pop stash@{0}?", {
      detail: "Reinstating the index…",
      actions: [
        { label: "Pop", value: false },
        { label: "Pop & Reinstate Index", value: true }
      ]
    });
    expect(posted[0].prompt).toEqual({
      kind: "choose",
      message: "Pop stash@{0}?",
      detail: "Reinstating the index…",
      actions: ["Pop", "Pop & Reinstate Index"]
    });
    answerLast(1);
    expect(await chosen).toBe(true);
  });

  it("shows again what a reloaded page was showing, once it listens again", () => {
    const { prompts, posted, listen } = make();
    listen();
    void prompts.input({ prompt: "Username" });

    prompts.pageLoading();
    void prompts.input({ prompt: "asked while it loads" });
    expect(posted).toHaveLength(1);

    listen();
    expect(posted.slice(1).map((m) => m.prompt)).toMatchObject([
      { prompt: "Username" },
      { prompt: "asked while it loads" }
    ]);
    expect(posted[1].id).toBe(posted[0].id);
  });

  it("answers what is still asked as dismissed once disposed, and asks nothing more", async () => {
    const { prompts, posted, listen } = make();
    listen();
    const asked = prompts.input({ prompt: "Username" });

    prompts.dispose();
    expect(await asked).toBeUndefined();

    expect(await prompts.pick([{ label: "origin", value: "origin" }])).toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  it("logs an answer nobody is waiting for, and settles nothing with it", async () => {
    const { prompts, logged, listen, answerLast } = make();
    listen();
    const asked = prompts.input({ prompt: "Username" });
    answerLast("alice");
    answerLast("again");
    await settled();

    expect(await asked).toBe("alice");
    expect(logged).toEqual([expect.stringContaining("nobody is waiting for")]);
  });
});
