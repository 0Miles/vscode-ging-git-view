/* The desktop host's Tabs as they persist (GLOSSARY.md's Tab): one
 * `ExtensionState` per Tab, each with a Current repository of its own, over the
 * one storage every Tab shares — the known repositories, the dialog memory and
 * the avatars stay the app's. What is kept across sessions is the list of
 * Tabs, in order, each with its repository's path string, and which Tab was in
 * front (#393). The VS Code host has no Tabs and never reads this. */

import { ExtensionState } from "@ging/core/extensionState";
import type { HostStorage } from "@ging/core/host/ports";

const OPEN_TABS = "openTabs";

/** The list as stored: each Tab's path string as written, in order — `null`
 *  where its write was refused (`setLastActiveRepo`) — and the index of the
 *  Tab in front, if any. */
type StoredTabs = { repos: (string | null)[]; active: number | null };

/** What `storage` holds under the key, or no Tabs when it holds nothing this
 *  could have written. */
function readStored(storage: HostStorage): StoredTabs {
  const stored = storage.workspace.get<unknown>(OPEN_TABS, null);
  if (typeof stored !== "object" || stored === null) return { repos: [], active: null };
  const { repos, active } = stored as Record<string, unknown>;
  if (!Array.isArray(repos)) return { repos: [], active: null };
  const kept = repos.map((repo) => (typeof repo === "string" ? repo : null));
  return {
    repos: kept,
    active:
      typeof active === "number" && Number.isInteger(active) && active >= 0 && active < kept.length
        ? active
        : null
  };
}

export class TabStates {
  private readonly storage: HostStorage;
  /** Each Tab's path string, as its slot holds it now. */
  private readonly strings = new WeakMap<ExtensionState, () => string | null>();
  /** The list as last saved, which a Tab's own write saves again. */
  private order: readonly ExtensionState[] = [];
  private active: ExtensionState | null = null;

  constructor(storage: HostStorage) {
    this.storage = storage;
  }

  /**
   * The Tabs the app was left with, in order, and the one that was in front.
   * Each one's Current repository is resolved as any stored one is
   * (`getLastActiveRepo`, null when its path no longer names a folder), and
   * its string is kept either way (`getPersistedRepoPath`): a Tab whose disk
   * is not mounted today is still listed, and still saved, until it is closed.
   */
  restore(): { tabs: ExtensionState[]; active: ExtensionState | null } {
    const stored = readStored(this.storage);
    const tabs = stored.repos.map((repo) => this.stateOf(repo));
    this.order = tabs;
    this.active = stored.active === null ? null : tabs[stored.active];
    return { tabs, active: this.active };
  }

  /** The state of a new Tab on `repo`, written by `setLastActiveRepo`'s rule.
   *  It joins the list when the list is next saved with it in. */
  newTab(repo: string): ExtensionState {
    const state = this.stateOf(null);
    state.setLastActiveRepo(repo);
    return state;
  }

  /** Keep `tabs` as the list, in this order, with `active` in front. Tabs
   *  left out are forgotten. */
  save(tabs: readonly ExtensionState[], active: ExtensionState | null): void {
    this.order = [...tabs];
    this.active = active !== null && tabs.includes(active) ? active : null;
    this.write();
  }

  private stateOf(initial: string | null): ExtensionState {
    let value = initial;
    const slot = {
      get: () => value,
      // Never called while `state` is being built: the constructor only reads.
      set: (next: string | null) => {
        value = next;
        if (this.order.includes(state)) this.write();
      }
    };
    const state = new ExtensionState(this.storage, slot);
    this.strings.set(state, () => value);
    return state;
  }

  private write(): void {
    const stored: StoredTabs = {
      repos: this.order.map((state) => this.strings.get(state)?.() ?? null),
      active: this.active === null ? null : this.order.indexOf(this.active)
    };
    void this.storage.workspace.update(OPEN_TABS, stored);
  }
}
