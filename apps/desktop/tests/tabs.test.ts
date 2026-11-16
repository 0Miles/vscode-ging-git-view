import { describe, expect, it } from "vitest";

import { createTabs } from "@ging/desktop/tabs";

// The desktop host's Tabs as a list (#393): open, focus and close, and a
// repository open in at most one Tab (GLOSSARY.md's Tab).

function setUp() {
  const disposed: string[] = [];
  let changes = 0;
  const tabs = createTabs<string>({
    dispose: (content) => disposed.push(content),
    onChange: () => changes++
  });
  /** Open `repo`, its Tab showing `repo` itself. */
  const open = (repo: string) => tabs.open(repo, () => repo);
  const repos = () => tabs.list().map((tab) => tab.repo);
  return { tabs, open, repos, disposed, changes: () => changes };
}

describe("the desktop host's Tabs", () => {
  it("open a repository in a Tab of its own, after the others, and focus it", () => {
    const { tabs, open, repos } = setUp();
    open("/a");
    const { tab, opened } = open("/b");

    expect(opened).toBe(true);
    expect(repos()).toEqual(["/a", "/b"]);
    expect(tabs.focused()).toBe(tab);
  });

  it("focus the Tab a repository is open in rather than open it twice", () => {
    const { tabs, open, repos, changes } = setUp();
    const first = open("/a").tab;
    open("/b");
    const before = changes();
    let made = false;

    const again = tabs.open("/a", () => {
      made = true;
      return "another";
    });

    expect(again).toEqual({ tab: first, opened: false });
    expect(made).toBe(false);
    expect(repos()).toEqual(["/a", "/b"]);
    expect(tabs.focused()).toBe(first);
    expect(changes()).toBe(before + 1);
  });

  it("close the focused Tab to the one on its right, or else its left", () => {
    const { tabs, open, repos, disposed } = setUp();
    const [a, b, c] = ["/a", "/b", "/c"].map((repo) => open(repo).tab);
    tabs.focus(b.id);

    tabs.close(b.id);
    expect(tabs.focused()).toBe(c);
    tabs.close(c.id);
    expect(tabs.focused()).toBe(a);
    expect(repos()).toEqual(["/a"]);
    expect(disposed).toEqual(["/b", "/c"]);
  });

  it("leave the focus where it is when another Tab closes", () => {
    const { tabs, open } = setUp();
    const a = open("/a").tab;
    const b = open("/b").tab;

    tabs.close(a.id);

    expect(tabs.focused()).toBe(b);
  });

  it("have none focused, and the Welcome page showing, once the last one closes", () => {
    const { tabs, open, disposed } = setUp();
    const a = open("/a").tab;

    tabs.close(a.id);

    expect(tabs.list()).toEqual([]);
    expect(tabs.focused()).toBeNull();
    expect(disposed).toEqual(["/a"]);
  });

  it("let a repository open again once its Tab has closed", () => {
    const { tabs, open } = setUp();
    const first = open("/a").tab;
    tabs.close(first.id);

    const { tab, opened } = open("/a");

    expect(opened).toBe(true);
    expect(tab.id).not.toBe(first.id);
  });

  it("change nothing for a Tab that is not there", () => {
    const { tabs, open, changes } = setUp();
    const a = open("/a").tab;
    const before = changes();

    tabs.focus(a.id + 100);
    tabs.close(a.id + 100);
    tabs.focus(a.id);

    expect(changes()).toBe(before);
    expect(tabs.focused()).toBe(a);
  });

  it("dispose of every Tab when the window goes, even after one of them throws", () => {
    const disposed: string[] = [];
    const errors: unknown[] = [];
    const tabs = createTabs<string>({
      dispose: (content) => {
        disposed.push(content);
        if (content === "/a") throw new Error("gone already");
      },
      onChange: () => {},
      onDisposeError: (e) => errors.push(e)
    });
    for (const repo of ["/a", "/b", "/c"]) tabs.open(repo, () => repo);

    tabs.disposeAll();

    expect(disposed).toEqual(["/a", "/b", "/c"]);
    expect(errors).toEqual([new Error("gone already")]);
  });

  it("dispose of every Tab when the window goes, without a change to save", () => {
    const { tabs, open, disposed, changes } = setUp();
    open("/a");
    open("/b");
    const before = changes();

    tabs.disposeAll();

    expect(disposed).toEqual(["/a", "/b"]);
    expect(tabs.list()).toEqual([]);
    expect(changes()).toBe(before);
  });
});
