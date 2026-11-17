import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionState } from "@ging/core/extensionState";
import type { HostStorage } from "@ging/core/host/ports";
import { TabStates } from "@ging/core/tabStates";

import { fakeStorage } from "./fakeHost";
import { makeTempDir, rmrf } from "./helpers";

// The desktop host's Tabs (#393): an ExtensionState per Tab, each with a
// Current repository of its own, kept as a list across sessions. The write
// rule is setLastActiveRepo's, and the VS Code host's key is not touched.

const made: string[] = [];
afterEach(() => made.splice(0).forEach(rmrf));

/** A folder that is there, as a repository's would be. */
function folder(): string {
  const dir = makeTempDir("ging-tabs-");
  made.push(dir);
  return dir;
}

/** Storage in memory, with its avatar folder somewhere real, so the
 *  ExtensionStates built over it make it where a test cleans up. Each
 *  `open()` is another session over the same tiers. */
function storage() {
  const memory = fakeStorage();
  const globalStoragePath = folder();
  return { open: (): HostStorage => ({ ...memory.open(), globalStoragePath }) };
}

describe("TabStates", () => {
  it("keeps the Tabs in order, each with its Current repository, and which is in front", () => {
    const store = storage();
    const [a, b] = [folder(), folder()];
    const tabs = new TabStates(store.open());
    const first = tabs.newTab(a);
    const second = tabs.newTab(b);
    tabs.save([first, second], second);

    const restored = new TabStates(store.open()).restore();

    expect(restored.tabs.map((tab) => tab.getLastActiveRepo())).toEqual([a, b]);
    expect(restored.active).toBe(restored.tabs[1]);
  });

  it("forgets a Tab left out of the list", () => {
    const store = storage();
    const [a, b] = [folder(), folder()];
    const tabs = new TabStates(store.open());
    const first = tabs.newTab(a);
    const second = tabs.newTab(b);
    tabs.save([first, second], first);
    tabs.save([second], second);

    const restored = new TabStates(store.open()).restore();

    expect(restored.tabs.map((tab) => tab.getLastActiveRepo())).toEqual([b]);
  });

  it("writes a Tab's own Current repository by setLastActiveRepo's rule", () => {
    const store = storage();
    const [a, b] = [folder(), folder()];
    const tabs = new TabStates(store.open());
    const tab = tabs.newTab(a);
    tabs.save([tab], tab);

    tab.setLastActiveRepo(b);
    expect(new TabStates(store.open()).restore().tabs[0].getLastActiveRepo()).toBe(b);

    // Neither known nor a folder: written down as no selection, as for VS Code.
    tab.setLastActiveRepo(path.join(b, "not-there"));
    const restored = new TabStates(store.open()).restore().tabs[0];
    expect(restored.getLastActiveRepo()).toBeNull();
    expect(restored.getPersistedRepoPath()).toBeNull();
  });

  it("keeps the string of a Tab whose folder has gone, and resolves it to none", () => {
    const store = storage();
    const gone = folder();
    const tabs = new TabStates(store.open());
    const tab = tabs.newTab(gone);
    tabs.save([tab], tab);
    rmrf(gone);

    const restoring = new TabStates(store.open());
    const restored = restoring.restore();
    expect(restored.tabs[0].getLastActiveRepo()).toBeNull();
    expect(restored.tabs[0].getPersistedRepoPath()).toBe(gone);

    // Saved again with the others, it is still there for the next session.
    const another = restoring.newTab(folder());
    restoring.save([restored.tabs[0], another], another);
    expect(new TabStates(store.open()).restore().tabs[0].getPersistedRepoPath()).toBe(gone);
  });

  it("shares everything but the Current repository with the app's ExtensionState", () => {
    const store = storage();
    const app = new ExtensionState(store.open());
    const a = folder();
    app.setLastActiveRepo(a);
    const tabs = new TabStates(store.open());
    const tab = tabs.newTab(folder());
    tabs.save([tab], tab);

    tab.saveDialogMemory("merge", { squash: "true" });

    expect(app.getDialogMemory()).toEqual({ merge: { squash: "true" } });
    // The VS Code host's key is the app's, and no Tab writes it.
    expect(new ExtensionState(store.open()).getLastActiveRepo()).toBe(a);
  });

  it("starts with no Tabs from storage that holds none, or something else", () => {
    const store = storage();
    expect(new TabStates(store.open()).restore()).toEqual({ tabs: [], active: null });

    void store.open().workspace.update("openTabs", { repos: "not a list", active: 0 });
    expect(new TabStates(store.open()).restore()).toEqual({ tabs: [], active: null });
  });
});
