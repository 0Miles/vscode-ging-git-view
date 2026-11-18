/* The desktop window's Tabs as the main process runs them (#393), apart from
 * Electron: which repository a request names among the Tabs and the known
 * repositories, opening it in a Tab or focusing the one it is open in,
 * bringing back the Tabs a session was left with, and where each Tab's view
 * goes in the window. The views and what they show are made by the factories
 * handed in — Electron's in main.ts, fakes in the tests. */

import { resolveToKnownRepo } from "@ging/core/backend/utils/repoMatch";
import type { ExtensionState } from "@ging/core/extensionState";
import type { HostLogger } from "@ging/core/host/ports";
import type { TabStates } from "@ging/core/tabStates";
import type { DesktopRepoSource } from "@ging/desktop/ports/repoSource";

import { createTabs, type Tab, type Tabs } from "./tabs";

/** What a Tab's view shows: a graph, or a notice where it cannot show one. */
export type TabPageLike = {
  /** It shows a graph: false for a notice in its place. */
  readonly graph: boolean;
  dispose(): void;
};

/** What a Tab holds: its view, its persisted state, and what its view shows. */
export type TabContent<V, P extends TabPageLike> = { view: V; state: ExtensionState; page: P };

export type TabWindowDeps<V, P extends TabPageLike> = {
  tabStates: Pick<TabStates, "restore" | "newTab" | "save">;
  repoSource: Pick<DesktopRepoSource, "getRepos" | "addRepo">;
  logger: Pick<HostLogger, "log" | "logError">;
  /** A view for a Tab, not yet loaded. */
  makeView(): V;
  /** A graph on `repo` in `view`, its Current repository kept in `state`. */
  graphPage(view: V, repo: string, state: ExtensionState): P;
  /** In place of a graph, why `persisted` cannot be shown. */
  noticePage(persisted: string): P;
  /** Load Tab `id`'s page in `view`, the first time or anew. */
  load(view: V, id: number): void;
  /** Done with a Tab's view, once its page is disposed of. */
  disposeView(view: V): void;
  /** After every change to the Tabs, their order or focus, once it is saved. */
  onChange(): void;
};

export type TabWindow<V, P extends TabPageLike> = {
  tabs: Tabs<TabContent<V, P>>;
  /** `repo` — a repository, checked — as an open Tab or the known set spells
   *  it, if it is open or known under another spelling (a symlink, say);
   *  otherwise as given. */
  resolve(repo: string): string;
  /** Open `repo`, as `resolve` spells it, in a Tab of its own, or focus the
   *  Tab it is open in. A Tab that could not show it when the app started
   *  shows it now. */
  openRepo(repo: string): Tab<TabContent<V, P>>;
  /** Bring back the Tabs the app was left with, in their order, the one in
   *  front again in front. */
  restore(): void;
};

/** Where Tab views go in a window whose content is `width` × `height`: below
 *  the strip, the focused one alone in the window (the others are taken out
 *  of it, not hidden in it: nothing draws a view that is in no window), and
 *  every one at the window's size, since a graph sizes what it loads by its
 *  viewport. */
export function layoutTabViews<T>(
  tabs: readonly T[],
  focused: T | null,
  [width, height]: readonly [number, number],
  stripHeight: number
): {
  tab: T;
  bounds: { x: number; y: number; width: number; height: number };
  inWindow: boolean;
}[] {
  const bounds = { x: 0, y: stripHeight, width, height: Math.max(0, height - stripHeight) };
  return tabs.map((tab) => ({ tab, bounds, inWindow: tab === focused }));
}

export function createTabWindow<V, P extends TabPageLike>(
  deps: TabWindowDeps<V, P>
): TabWindow<V, P> {
  const { tabStates, repoSource, logger } = deps;

  const tabs: Tabs<TabContent<V, P>> = createTabs<TabContent<V, P>>({
    dispose: ({ view, page }) => {
      try {
        page.dispose();
      } finally {
        deps.disposeView(view);
      }
    },
    onChange: () => {
      tabStates.save(
        tabs.list().map((tab) => tab.content.state),
        tabs.focused()?.content.state ?? null
      );
      deps.onChange();
    },
    onDisposeError: (e) => logger.logError(`tabs: closing a Tab failed: ${String(e)}`)
  });

  const resolve = (repo: string) =>
    resolveToKnownRepo(repo, [
      ...tabs.list().map((tab) => tab.repo),
      ...Object.keys(repoSource.getRepos())
    ]) ?? repo;

  const openRepo = (repo: string) => {
    repoSource.addRepo(repo);
    const existing = tabs.find(repo);
    if (existing !== null && !existing.content.page.graph) {
      const { content } = existing;
      content.page.dispose();
      content.state.setLastActiveRepo(repo);
      content.page = deps.graphPage(content.view, repo, content.state);
      deps.load(content.view, existing.id);
    }
    const { tab, opened } = tabs.open(repo, () => {
      const view = deps.makeView();
      const state = tabStates.newTab(repo);
      return { view, state, page: deps.graphPage(view, repo, state) };
    });
    if (opened) deps.load(tab.content.view, tab.id);
    return tab;
  };

  const restore = () => {
    const { tabs: states, active } = tabStates.restore();
    let front: Tab<TabContent<V, P>> | null = null;
    for (const state of states) {
      const persisted = state.getPersistedRepoPath();
      // A write refused (`setLastActiveRepo`) left nothing to show; a second
      // entry for a repository already brought back is the same Tab.
      if (persisted === null || tabs.find(persisted) !== null) continue;
      const repo = state.getLastActiveRepo();
      if (repo === null) {
        // Kept, saying why, until it is closed: its disk may only be
        // unmounted (GLOSSARY.md's Current repository).
        logger.log(`tabs: cannot restore ${persisted}, its folder is not there`);
      } else {
        logger.log(`tabs: restoring ${repo}`);
        repoSource.addRepo(repo);
      }
      const { tab } = tabs.open(persisted, () => {
        const view = deps.makeView();
        const page = repo === null ? deps.noticePage(persisted) : deps.graphPage(view, repo, state);
        return { view, state, page };
      });
      deps.load(tab.content.view, tab.id);
      if (state === active) front = tab;
    }
    if (front !== null) tabs.focus(front.id);
  };

  return { tabs, resolve, openRepo, restore };
}
