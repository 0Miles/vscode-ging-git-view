import type { OpenDialogOptions } from "electron";
import { describe, expect, it } from "vitest";

import type { CloneProgress } from "@ging/core/backend/actions/clone";
import type { CloneRun } from "@ging/core/extension/repoCloneCommand";
import { createRepoCloning, PROGRESS_INTERVAL_MS } from "@ging/desktop/repoCloning";

// Clone Repository on the desktop host (#395), with the Welcome page's prompt,
// the system's folder dialog, core's clone, the askpass route and the Tabs all
// faked: what is asked, in which order, what the Welcome page is shown, and
// what ends up opened. Core's clone itself runs on real git in
// packages/core/tests/actions/clone; the whole path in apps/desktop/e2e.

type InputOptions = {
  prompt: string;
  placeholder?: string;
  validate?: (text: string) => string | undefined;
};

/** A clone that has started, held until the test settles it. */
type Pending = {
  url: string;
  folder: string;
  run: CloneRun;
  settle: (result: { repo: string } | undefined) => void;
};

type ChooseOptions = { detail?: string; actions: readonly { label: string; value: unknown }[] };

type Answers = {
  /** What the URL prompt answers; `undefined` dismisses it. */
  url?: string;
  /** The folder the dialog answers; `null` cancels it. */
  folder?: string | null;
  /** The label of the action the credentials question is answered by;
   *  `undefined` is the host's Cancel. */
  credentials?: string;
  /** Whether taking the credentials out of the remote URL works. */
  removes?: boolean;
};

function make(answers: Answers = {}) {
  const asked: (
    | ["input", InputOptions]
    | ["open", OpenDialogOptions]
    | ["choose", string, ChooseOptions]
  )[] = [];
  const opened: string[] = [];
  const logged: string[] = [];
  const warned: string[] = [];
  /** What reached core and the Tabs, in order. */
  const events: string[] = [];
  const removed: [string, string][] = [];
  const clones: Pending[] = [];
  const routes = { made: 0, disposed: 0 };
  let changes = 0;
  let clock = 0;
  const cloning = createRepoCloning({
    prompts: {
      input: async (options) => {
        asked.push(["input", options]);
        return "url" in answers ? answers.url : "  https://example.com/owner/app.git  ";
      },
      choose: async <T>(message: string, options: ChooseOptions) => {
        asked.push(["choose", message, options]);
        return options.actions.find(({ label }) => label === answers.credentials)?.value as
          | T
          | undefined;
      },
      showWarning: (message) => {
        warned.push(message);
      }
    },
    dialogs: {
      showOpenDialog: async (options) => {
        asked.push(["open", options]);
        const folder = answers.folder === undefined ? "/work" : answers.folder;
        return folder === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [folder] };
      }
    },
    l10n: { t: (key, ...args) => [key, ...args].join("|") },
    logger: { log: (line) => logged.push(line) },
    command: {
      urlProblem: (url) => (url.trim().startsWith("-") ? "clone.url.option" : undefined),
      folderFor: (parent, url) =>
        `${parent}/${url
          .split("/")
          .at(-1)!
          .replace(/\.git$/, "")}`,
      shownUrl: (url) => url.replace(/\/\/[^@/]*@/, "//"),
      hasCredentials: (url) => /\/\/[^@/]*@/.test(url),
      removeCredentials: async (repo, url) => {
        events.push("remove");
        removed.push([repo, url]);
        return answers.removes ?? true;
      },
      cloneRepo: (url, folder, run = {}) => {
        events.push("clone");
        return new Promise((settle) => clones.push({ url, folder, run, settle }));
      }
    },
    askpassRoute: () => {
      routes.made += 1;
      return {
        env: { NEO_GIT_GRAPH_ASKPASS_TOKEN: `route-${routes.made}` },
        dispose: () => {
          routes.disposed += 1;
        }
      };
    },
    openRepo: (repo) => {
      events.push("open");
      opened.push(repo);
    },
    onChange: () => {
      changes += 1;
    },
    now: () => clock
  });
  return {
    cloning,
    asked,
    opened,
    logged,
    warned,
    events,
    removed,
    clones,
    routes,
    changes: () => changes,
    tick: (ms: number) => {
      clock += ms;
    }
  };
}

/** Until the clone `h` started has reached core's clone. */
async function started(h: ReturnType<typeof make>): Promise<Pending> {
  await expect.poll(() => h.clones.length).toBe(1);
  return h.clones[0];
}

const progress = (text: string, percent: number): CloneProgress => ({ text, percent });

describe("Clone Repository", () => {
  it("asks for the URL on the Welcome page, then for a folder, and clones into a folder named for it", async () => {
    const h = make();

    const done = h.cloning.clone();
    const clone = await started(h);

    expect(h.asked.map(([kind]) => kind)).toEqual(["input", "open"]);
    const [, input] = h.asked[0] as ["input", InputOptions];
    expect(input.prompt).toBe("desktop.clone.urlPrompt");
    expect(input.placeholder).toBe("desktop.clone.urlPlaceholder");
    // The URL is checked as it is typed, by core's rules.
    expect(input.validate?.("-x")).toBe("clone.url.option");
    expect(input.validate?.("https://example.com/a.git")).toBeUndefined();
    expect(h.asked[1]).toEqual([
      "open",
      {
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "desktop.folderDialog.clone"
      }
    ]);
    // Trimmed, and under the folder chosen.
    expect(clone.url).toBe("https://example.com/owner/app.git");
    expect(clone.folder).toBe("/work/app");

    clone.settle({ repo: "/work/app" });
    await done;
    expect(h.opened).toEqual(["/work/app"]);
    expect(h.logged).toEqual([
      "clone: https://example.com/owner/app.git into /work/app",
      "clone: cloned /work/app"
    ]);
  });

  it.each([
    ["the URL is dismissed", { url: undefined }],
    ["the folder dialog is cancelled", { folder: null }]
  ] satisfies [string, Answers][])("does nothing when %s", async (_, answers) => {
    const h = make(answers);

    await h.cloning.clone();

    expect(h.clones).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.routes.made).toBe(0);
    expect(h.cloning.busy()).toBe(false);
  });

  it("runs git with an askpass route of its own, let go once the clone has ended", async () => {
    const h = make();

    const done = h.cloning.clone();
    const clone = await started(h);
    expect(clone.run.gitEnv).toEqual({ NEO_GIT_GRAPH_ASKPASS_TOKEN: "route-1" });
    expect(h.routes).toEqual({ made: 1, disposed: 0 });

    clone.settle(undefined);
    await done;
    expect(h.routes).toEqual({ made: 1, disposed: 1 });
  });

  it("shows the Welcome page where the clone has got to, every so often and at each stage's end", async () => {
    const h = make({
      url: "https://user:token@example.com/app.git",
      // Cloned as it is (#471), as before.
      credentials: "desktop.clone.credentials.keep"
    });

    const done = h.cloning.clone();
    const clone = await started(h);
    expect(h.cloning.panel()).toEqual({
      // No credentials shown.
      title: "desktop.clone.title|https://example.com/app.git",
      folder: "desktop.clone.into|/work/app",
      stage: "desktop.clone.starting",
      percent: null,
      cancelling: false,
      cancel: "dialog.cancel"
    });

    const before = h.changes();
    clone.run.onProgress?.(progress("Receiving objects:  10% (1/10)", 10));
    clone.run.onProgress?.(progress("Receiving objects:  20% (2/10)", 20));
    // The second came too soon after the first to be shown on its own...
    expect(h.changes()).toBe(before + 1);
    // ...but the panel says the latest, whenever it is drawn.
    expect(h.cloning.panel()).toMatchObject({
      stage: "Receiving objects:  20% (2/10)",
      percent: 20
    });
    h.tick(PROGRESS_INTERVAL_MS);
    clone.run.onProgress?.(progress("Receiving objects:  30% (3/10)", 30));
    clone.run.onProgress?.(progress("Receiving objects: 100% (10/10), done.", 100));
    expect(h.changes()).toBe(before + 3);

    clone.settle({ repo: "/work/app" });
    await done;
    expect(h.cloning.panel()).toBeNull();
  });

  it("cancels the clone running: its signal aborts, the panel says so, and nothing opens", async () => {
    const h = make();

    const done = h.cloning.clone();
    const clone = await started(h);
    h.cloning.cancel();

    expect(clone.run.signal?.aborted).toBe(true);
    expect(h.cloning.panel()).toMatchObject({
      stage: "desktop.clone.cancelling",
      percent: null,
      cancelling: true
    });
    // Core answers nothing for a cancelled clone, once git is gone.
    clone.settle(undefined);
    await done;
    expect(h.opened).toEqual([]);
    expect(h.cloning.panel()).toBeNull();
    expect(h.logged).toContain("clone: cancelled");
  });

  it("opens nothing after a clone that failed", async () => {
    const h = make();

    const done = h.cloning.clone();
    (await started(h)).settle(undefined);
    await done;

    expect(h.opened).toEqual([]);
    expect(h.logged.at(-1)).toBe("clone: did not clone");
  });

  it("runs one clone at a time: another asked for meanwhile does nothing", async () => {
    const h = make();

    const first = h.cloning.clone();
    expect(h.cloning.busy()).toBe(true);
    await h.cloning.clone();
    const clone = await started(h);
    await h.cloning.clone();

    expect(h.clones).toHaveLength(1);
    expect(h.asked.filter(([kind]) => kind === "input")).toHaveLength(1);
    clone.settle({ repo: "/work/app" });
    await first;
    expect(h.cloning.busy()).toBe(false);
  });

  it("cancels the clone running when the window goes, opens nothing, and says when it has ended", async () => {
    const h = make();

    const done = h.cloning.clone();
    const clone = await started(h);
    let ended = false;
    const disposed = h.cloning.dispose().then(() => {
      ended = true;
    });

    expect(clone.run.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(ended).toBe(false);
    // Even had git finished first, nothing opens in a window that is gone.
    clone.settle({ repo: "/work/app" });
    await Promise.all([done, disposed]);
    expect(ended).toBe(true);
    expect(h.opened).toEqual([]);
    await h.cloning.clone();
    expect(h.clones).toHaveLength(1);
  });
});

describe("Clone Repository of a URL with credentials in it (#471)", () => {
  const TOKEN = "s3cr3t-token";
  const URL_WITH_TOKEN = `https://user:${TOKEN}@example.com/owner/app.git`;
  /** The actions the credentials question offers, by their labels. */
  const STRIP = "desktop.clone.credentials.remove";
  const KEEP = "desktop.clone.credentials.keep";

  /** Every line logged, warned or shown has no token in it. */
  function expectNoToken(h: ReturnType<typeof make>) {
    for (const line of [...h.logged, ...h.warned]) expect(line).not.toContain(TOKEN);
  }

  it("does not ask about credentials when the URL has none", async () => {
    const h = make({ url: "https://example.com/owner/app.git" });

    const done = h.cloning.clone();
    (await started(h)).settle({ repo: "/work/app" });
    await done;

    expect(h.asked.map(([kind]) => kind)).toEqual(["input", "open"]);
    expect(h.removed).toEqual([]);
  });

  it("asks once, after the URL and before the folder, without the credentials in the question", async () => {
    const h = make({ url: URL_WITH_TOKEN, credentials: KEEP });

    const done = h.cloning.clone();
    const clone = await started(h);

    expect(h.asked.map(([kind]) => kind)).toEqual(["input", "choose", "open"]);
    const [, message, options] = h.asked[1] as ["choose", string, ChooseOptions];
    expect(message).toBe("desktop.clone.credentials.message");
    expect(options.detail).toBe("desktop.clone.credentials.detail");
    expect(options.actions.map(({ label }) => label)).toEqual([STRIP, KEEP]);
    for (const text of [message, options.detail, ...options.actions.map(({ label }) => label)]) {
      expect(text).not.toContain(TOKEN);
    }
    clone.settle({ repo: "/work/app" });
    await done;
    expectNoToken(h);
  });

  it("does nothing on Cancel: no folder asked, no git, and a cancel logged", async () => {
    const h = make({ url: URL_WITH_TOKEN, credentials: undefined });

    await h.cloning.clone();

    expect(h.asked.map(([kind]) => kind)).toEqual(["input", "choose"]);
    expect(h.clones).toEqual([]);
    expect(h.routes.made).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.cloning.busy()).toBe(false);
    expect(h.logged).toEqual(["clone: cancelled"]);
    expectNoToken(h);
  });

  it("clones with the URL as typed, takes the credentials out of the remote URL, then opens the Tab", async () => {
    const h = make({ url: URL_WITH_TOKEN, credentials: STRIP });

    const done = h.cloning.clone();
    const clone = await started(h);
    // git is handed the credentials: they are what lets it in.
    expect(clone.url).toBe(URL_WITH_TOKEN);
    clone.settle({ repo: "/work/app" });
    await done;

    expect(h.removed).toEqual([["/work/app", URL_WITH_TOKEN]]);
    expect(h.events).toEqual(["clone", "remove", "open"]);
    expect(h.opened).toEqual(["/work/app"]);
    expect(h.warned).toEqual([]);
    expectNoToken(h);
  });

  it("clones as before when asked to keep them, and asks nothing more", async () => {
    const h = make({ url: URL_WITH_TOKEN, credentials: KEEP });

    const done = h.cloning.clone();
    const clone = await started(h);
    expect(clone.url).toBe(URL_WITH_TOKEN);
    clone.settle({ repo: "/work/app" });
    await done;

    expect(h.removed).toEqual([]);
    expect(h.events).toEqual(["clone", "open"]);
    expect(h.asked.filter(([kind]) => kind === "choose")).toHaveLength(1);
    expect(h.warned).toEqual([]);
    expectNoToken(h);
  });

  it("opens the Tab all the same when the credentials cannot be taken out, and warns that they are still there", async () => {
    const h = make({ url: URL_WITH_TOKEN, credentials: STRIP, removes: false });

    const done = h.cloning.clone();
    (await started(h)).settle({ repo: "/work/app" });
    await done;

    expect(h.opened).toEqual(["/work/app"]);
    expect(h.warned).toEqual(["desktop.clone.credentials.notRemoved|/work/app"]);
    expect(h.logged).toContain(
      "clone: could not remove the credentials from the remote URL of /work/app"
    );
    expectNoToken(h);
  });

  it("removes nothing from a clone that failed", async () => {
    const h = make({ url: URL_WITH_TOKEN, credentials: STRIP });

    const done = h.cloning.clone();
    (await started(h)).settle(undefined);
    await done;

    expect(h.removed).toEqual([]);
    expect(h.opened).toEqual([]);
    expectNoToken(h);
  });
});
