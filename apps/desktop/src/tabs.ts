/* The desktop host's Tabs (GLOSSARY.md), as a list apart from Electron: which
 * Tabs are open, in what order, which one is focused, and the rule that a
 * repository is open in at most one of them (#393). What a Tab shows — its
 * view, its webview instance — is the main process's, handed in as `C`. */

export type Tab<C> = {
  /** Unique for the life of the process; never reused. */
  readonly id: number;
  /** Its Current repository's path, as the Tab was opened on it. */
  readonly repo: string;
  content: C;
};

export type Tabs<C> = {
  /** In the order the tab strip shows them. */
  list(): readonly Tab<C>[];
  /** The Tab in front, or null when the Welcome page shows: there is no Tab,
   *  or it was brought forward over them (`focusWelcome`). */
  focused(): Tab<C> | null;
  /** The Tab open on `repo`, spelled exactly so, if any. */
  find(repo: string): Tab<C> | null;
  /** Focus the Tab open on `repo`, or else open one after the others, with
   *  what `make` makes, and focus that. `opened` says which. */
  open(repo: string, make: () => C): { tab: Tab<C>; opened: boolean };
  /** Bring Tab `id` to the front; an id no Tab has changes nothing. */
  focus(id: number): void;
  /** Close Tab `id` and dispose of what it showed. Closing the focused Tab
   *  focuses the one to its right, or else to its left. */
  close(id: number): void;
  /** Bring the Welcome page forward over the Tabs (#461): none is focused,
   *  and the one that was is the one `restoreFocus` goes back to. */
  focusWelcome(): void;
  /** What `restoreFocus` would focus while the Welcome page is in front over
   *  Tabs: the Tab that was in front, or — once it has closed — the one
   *  `close` would have focused in its place; otherwise null. */
  returnTo(): Tab<C> | null;
  /** Leave the Welcome page for `returnTo`, if there is one. */
  restoreFocus(): void;
  /** Close every Tab without a word to `onChange`: the window is going, and
   *  the list as it stood is what the next session opens. */
  disposeAll(): void;
};

type TabsDeps<C> = {
  /** Done with what a Tab showed. */
  dispose(content: C): void;
  /** Told after every change to the list, its order or its focus. */
  onChange(): void;
  /** Told when disposing of a Tab threw: the others are disposed of all the
   *  same, so one Tab's failure leaves no other's prompts, watcher or timers
   *  behind. */
  onDisposeError?(error: unknown): void;
};

export function createTabs<C>({
  dispose: disposeContent,
  onChange,
  onDisposeError = () => {}
}: TabsDeps<C>): Tabs<C> {
  const dispose = (content: C) => {
    try {
      disposeContent(content);
    } catch (e) {
      onDisposeError(e);
    }
  };
  let tabs: Tab<C>[] = [];
  /** The Tab in front, or — while `welcomeInFront` — the one behind it. */
  let focusedId: number | null = null;
  let welcomeInFront = false;
  let nextId = 0;

  const find = (repo: string) => tabs.find((tab) => tab.repo === repo) ?? null;
  const byId = (id: number | null) => tabs.find((tab) => tab.id === id) ?? null;
  const focus = (id: number) => {
    if ((focusedId === id && !welcomeInFront) || !tabs.some((tab) => tab.id === id)) return;
    focusedId = id;
    welcomeInFront = false;
    onChange();
  };

  return {
    list: () => tabs,
    focused: () => (welcomeInFront ? null : byId(focusedId)),
    find,
    open(repo, make) {
      const existing = find(repo);
      if (existing !== null) {
        focus(existing.id);
        return { tab: existing, opened: false };
      }
      const tab: Tab<C> = { id: ++nextId, repo, content: make() };
      tabs = [...tabs, tab];
      focusedId = tab.id;
      welcomeInFront = false;
      onChange();
      return { tab, opened: true };
    },
    focus,
    close(id) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const [closed] = tabs.splice(index, 1);
      tabs = [...tabs];
      if (focusedId === id) focusedId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null;
      dispose(closed.content);
      onChange();
    },
    focusWelcome() {
      if (welcomeInFront || focusedId === null) return;
      welcomeInFront = true;
      onChange();
    },
    returnTo: () => (welcomeInFront ? byId(focusedId) : null),
    restoreFocus() {
      if (welcomeInFront && focusedId !== null) focus(focusedId);
    },
    disposeAll() {
      const closing = tabs;
      tabs = [];
      focusedId = null;
      welcomeInFront = false;
      closing.forEach((tab) => dispose(tab.content));
    }
  };
}
