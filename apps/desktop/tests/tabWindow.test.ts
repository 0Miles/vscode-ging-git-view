import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { ExtensionState } from "@ging/core/extensionState";
import { TabStates } from "@ging/core/tabStates";
import { createDesktopRepoSource } from "@ging/desktop/ports/repoSource";
import { openDesktopStorage } from "@ging/desktop/ports/storage";
import { createTabWindow, layoutTabViews } from "@ging/desktop/tabWindow";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

// The desktop window's Tabs as the main process runs them (#393), with the
// views and pages faked and the rest real: the Tabs' persisted list, the
// known repositories, and the folders on disk.

type FakeView = { loads: number[]; disposed: boolean };
type FakePage = { graph: boolean; shows: string; disposed: boolean; dispose(): void };

function fakePage(graph: boolean, shows: string): FakePage {
  const page: FakePage = {
    graph,
    shows,
    disposed: false,
    dispose: () => {
      page.disposed = true;
    }
  };
  return page;
}

/** A user data folder, and the Tabs of one session of the app over it. */
function setUp() {
  const userData = makeTempDir("ging-tab-window-");
  const folders: string[] = [userData];
  onTestFinished(() => folders.forEach(rmrf));
  /** A folder that is there, as a repository's top would be. */
  const folder = () => {
    const dir = makeTempDir("ging-tab-window-repo-").replace(/\\/g, "/");
    folders.push(dir);
    return dir;
  };

  const session = () => {
    const storage = openDesktopStorage(userData);
    const appState = new ExtensionState(storage);
    const repoSource = createDesktopRepoSource(appState, { gitPath: () => "git" });
    const logged: string[] = [];
    const views: FakeView[] = [];
    const window = createTabWindow<FakeView, FakePage>({
      tabStates: new TabStates(storage),
      repoSource,
      logger: {
        log: (line) => logged.push(line),
        logError: (line) => logged.push(`ERROR ${line}`)
      },
      makeView: () => {
        const view = { loads: [], disposed: false };
        views.push(view);
        return view;
      },
      graphPage: (_view, repo) => fakePage(true, repo),
      noticePage: (persisted) => fakePage(false, persisted),
      load: (view, id) => view.loads.push(id),
      disposeView: (view) => {
        view.disposed = true;
      },
      onChange: () => {}
    });
    const shown = () =>
      window.tabs.list().map((tab) => ({
        repo: tab.repo,
        page: tab.content.page.graph ? "graph" : "notice",
        focused: tab === window.tabs.focused()
      }));
    return { window, repoSource, logged, views, shown };
  };
  return { userData, folder, session };
}

/** Wait for the state file's queued write to land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("the desktop window's Tabs", () => {
  it("come back in their order, the one that was in front in front", async () => {
    const { folder, session } = setUp();
    const [a, b, c] = [folder(), folder(), folder()];
    const first = session();
    for (const repo of [a, b, c]) first.window.openRepo(repo);
    first.window.tabs.focus(first.window.tabs.find(b)!.id);
    await settled();

    const second = session();
    second.window.restore();

    expect(second.shown()).toEqual([
      { repo: a, page: "graph", focused: false },
      { repo: b, page: "graph", focused: true },
      { repo: c, page: "graph", focused: false }
    ]);
    // Each loaded once, its own Tab's page.
    expect(second.views.map((view) => view.loads)).toEqual(
      second.window.tabs.list().map((tab) => [tab.id])
    );
    expect(second.logged).toEqual([a, b, c].map((repo) => `tabs: restoring ${repo}`));
  });

  it("bring back a Tab whose folder has gone saying so, and show its graph once it is back", async () => {
    const { folder, session } = setUp();
    const [kept, gone] = [folder(), folder()];
    const first = session();
    first.window.openRepo(kept);
    first.window.openRepo(gone);
    await settled();
    const parked = `${gone}-parked`;
    fs.renameSync(gone, parked);

    const second = session();
    second.window.restore();
    expect(second.shown()).toEqual([
      { repo: kept, page: "graph", focused: false },
      { repo: gone, page: "notice", focused: true }
    ]);
    expect(second.logged).toContain(`tabs: cannot restore ${gone}, its folder is not there`);

    // The disk mounted again: opening it shows its graph in the same Tab.
    fs.renameSync(parked, gone);
    const tab = second.window.tabs.find(gone)!;
    const notice = tab.content.page;
    second.window.tabs.focus(second.window.tabs.find(kept)!.id);
    expect(second.window.openRepo(gone)).toBe(tab);
    expect(notice.disposed).toBe(true);
    expect(tab.content.page).toMatchObject({ graph: true, shows: gone });
    expect(tab.content.view.loads).toEqual([tab.id, tab.id]);
    expect(second.window.tabs.focused()).toBe(tab);
    expect(second.window.tabs.list()).toHaveLength(2);
  });

  it("bring back one Tab for a repository listed twice, and none for an entry with no path", () => {
    const { userData, folder, session } = setUp();
    const [a, b] = [folder(), folder()];
    // As a hand-edited state file might hold it: the list as TabStates keeps
    // it, in the desktop storage's file.
    fs.writeFileSync(
      path.join(userData, "state.json"),
      JSON.stringify({ "workspace:openTabs": { repos: [a, null, a, b], active: 0 } })
    );

    const { window, shown } = session();
    window.restore();

    expect(shown()).toEqual([
      { repo: a, page: "graph", focused: true },
      { repo: b, page: "graph", focused: false }
    ]);
  });

  it("open a repository named by another spelling in the Tab it is open in", () => {
    const { folder, session } = setUp();
    const a = folder();
    const link = `${a}-link`;
    fs.symlinkSync(a, link, "junction");
    // The link alone: never a removal that could follow it into the folder.
    onTestFinished(() => fs.unlinkSync(link));
    const { window, shown } = session();
    const tab = window.openRepo(window.resolve(a));
    window.openRepo(window.resolve(folder()));

    expect(window.resolve(link)).toBe(a);
    expect(window.openRepo(window.resolve(link))).toBe(tab);
    expect(shown().map(({ repo, focused }) => ({ repo, focused }))).toEqual([
      { repo: a, focused: true },
      { repo: expect.any(String), focused: false }
    ]);
  });

  it("dispose of a closed Tab's page and view", () => {
    const { folder, session } = setUp();
    const { window, views } = session();
    const tab = window.openRepo(folder());
    const page = tab.content.page;

    window.tabs.close(tab.id);

    expect(page.disposed).toBe(true);
    expect(views[0].disposed).toBe(true);
  });
});

describe("layoutTabViews", () => {
  it("puts every view below the strip at the window's size, the focused one alone in the window", () => {
    expect(layoutTabViews(["a", "b"], "b", [800, 600], 35)).toEqual([
      { tab: "a", bounds: { x: 0, y: 35, width: 800, height: 565 }, inWindow: false },
      { tab: "b", bounds: { x: 0, y: 35, width: 800, height: 565 }, inWindow: true }
    ]);
    expect(layoutTabViews(["a"], null, [800, 20], 35)[0]).toMatchObject({
      bounds: { height: 0 },
      inWindow: false
    });
  });
});
