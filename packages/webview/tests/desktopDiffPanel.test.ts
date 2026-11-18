import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDiffPanel, LAYOUT_STORAGE_KEY } from "@ging/webview/desktop/diff/diffPanel";
import type { ShowDiffMessage, ShowFileMessage } from "@ging/webview/desktop/diff/protocol";
import type {
  DiffLayout,
  DiffViewer,
  DiffViewerOptions,
  EditorFactory,
  FileViewer,
  FileViewerOptions,
  ThemeKind
} from "@ging/webview/desktop/editors";

// The diff viewer's panel (#404), a file shown read-only in it too (#405),
// with editors that only record what they are asked: Monaco itself is the
// Electron E2E's (apps/desktop/e2e/diffViewer.spec.ts, fileAtRevision.spec.ts).

type FakeViewer = DiffViewer & {
  container: HTMLElement;
  options: DiffViewerOptions;
  layouts: DiffLayout[];
  themes: ThemeKind[];
  disposed: boolean;
};

type FakeFileViewer = FileViewer & {
  container: HTMLElement;
  options: FileViewerOptions;
  themes: ThemeKind[];
  disposed: boolean;
};

function fakeEditors() {
  const made: FakeViewer[] = [];
  /** The files it was asked to show read-only (#405). */
  const files: FakeFileViewer[] = [];
  /** Set to hold the next viewer back until `release()` is called. */
  let gate: Promise<void> | null = null;
  const editors: EditorFactory = {
    createDiffViewer: async (container, options) => {
      if (gate !== null) await gate;
      const viewer: FakeViewer = {
        container,
        options,
        layouts: [],
        themes: [],
        disposed: false,
        setLayout: (layout) => viewer.layouts.push(layout),
        setTheme: (theme) => viewer.themes.push(theme),
        focus: () => {
          const input = document.createElement("textarea");
          container.append(input);
          input.focus();
        },
        dispose: () => {
          viewer.disposed = true;
        }
      };
      made.push(viewer);
      return viewer;
    },
    createFileViewer: async (container, options) => {
      if (gate !== null) await gate;
      const viewer: FakeFileViewer = {
        container,
        options,
        themes: [],
        disposed: false,
        setTheme: (theme) => viewer.themes.push(theme),
        focus: () => {
          const input = document.createElement("textarea");
          container.append(input);
          input.focus();
        },
        dispose: () => {
          viewer.disposed = true;
        }
      };
      files.push(viewer);
      return viewer;
    }
  };
  return {
    editors,
    made,
    files,
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    }
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(initial));
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value)
  };
}

const message = (overrides: Partial<ShowDiffMessage> = {}): ShowDiffMessage => ({
  command: "showDiff",
  title: "file.txt (abc1234^ ↔ abc1234)",
  original: { path: "src/file.txt", content: "before\n" },
  modified: { path: "src/file.txt", content: "after\n" },
  revealLine: null,
  notShown: null,
  strings: {
    sideBySide: "Side by Side",
    inline: "Inline",
    close: "Close",
    cannotShow: "No editor"
  },
  ...overrides
});

const panel = () => document.getElementById("diffViewer")!;
const layoutButton = (layout: DiffLayout) =>
  panel().querySelector<HTMLButtonElement>(`button[data-layout="${layout}"]`)!;
const key = (target: Element, type: "keydown" | "keyup", k: string) => {
  const event = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.className = "vscode-dark";
  document.body.innerHTML = '<button id="cdvFile">file.txt</button>';
});
afterEach(() => vi.restoreAllMocks());

describe("the diff viewer", () => {
  it("shows the host's diff over the graph, titled, with the editor given both sides", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });

    await diffs.show(message({ revealLine: 7 }));

    expect(panel().hidden).toBe(false);
    expect(panel().querySelector(".diffViewerTitle")!.textContent).toBe(
      "file.txt (abc1234^ ↔ abc1234)"
    );
    expect(made).toHaveLength(1);
    expect(made[0].options).toEqual({
      original: { path: "src/file.txt", content: "before\n" },
      modified: { path: "src/file.txt", content: "after\n" },
      layout: "sideBySide",
      theme: "dark",
      revealLine: 7
    });
    expect(panel().contains(made[0].container)).toBe(true);
    // The keyboard is in the diff.
    expect(made[0].container.contains(document.activeElement)).toBe(true);
  });

  it("labels its controls in the host's words", async () => {
    const diffs = createDiffPanel(fakeEditors().editors, { storage: memoryStorage() });

    await diffs.show(message());

    expect(layoutButton("sideBySide").textContent).toBe("Side by Side");
    expect(layoutButton("inline").textContent).toBe("Inline");
    expect(panel().querySelector(".diffViewerClose")!.getAttribute("aria-label")).toBe("Close");
  });

  it("switches between side by side and inline, and remembers the choice", async () => {
    const { editors, made } = fakeEditors();
    const storage = memoryStorage();
    const diffs = createDiffPanel(editors, { storage });
    await diffs.show(message());
    expect(layoutButton("sideBySide").getAttribute("aria-pressed")).toBe("true");

    layoutButton("inline").click();

    expect(made[0].layouts).toEqual(["inline"]);
    expect(layoutButton("inline").getAttribute("aria-pressed")).toBe("true");
    expect(layoutButton("sideBySide").getAttribute("aria-pressed")).toBe("false");
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).toBe("inline");

    // The next diff, and the next session's, open the way it was left.
    await diffs.show(message());
    expect(made[1].options.layout).toBe("inline");
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    const next = fakeEditors();
    await createDiffPanel(next.editors, { storage }).show(message());
    expect(next.made[0].options.layout).toBe("inline");
  });

  it("opens side by side when nothing usable was remembered", async () => {
    const { editors, made } = fakeEditors();
    const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: "sideways" });

    await createDiffPanel(editors, { storage }).show(message());

    expect(made[0].options.layout).toBe("sideBySide");
  });

  it("works without the page's storage", async () => {
    const { editors, made } = fakeEditors();
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error("denied");
    };
    broken.setItem = () => {
      throw new Error("denied");
    };
    const diffs = createDiffPanel(editors, { storage: broken });

    await diffs.show(message());
    layoutButton("inline").click();

    expect(made[0].layouts).toEqual(["inline"]);
  });

  it("closes with its close button, done with the editor, the keyboard back where it was", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    document.getElementById("cdvFile")!.focus();
    await diffs.show(message());

    panel().querySelector<HTMLButtonElement>(".diffViewerClose")!.click();

    expect(panel().hidden).toBe(true);
    expect(made[0].disposed).toBe(true);
    expect(panel().querySelector(".diffViewerEditor")!.children).toHaveLength(0);
    expect(document.activeElement!.id).toBe("cdvFile");
  });

  it("takes the keyboard out of an editor before it is done with it", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    document.getElementById("cdvFile")!.focus();
    await diffs.show(message());
    const focusAtDispose: boolean[] = [];
    const watch = (viewer: FakeViewer) => {
      const dispose = viewer.dispose;
      viewer.dispose = () => {
        focusAtDispose.push(viewer.container.contains(document.activeElement));
        dispose();
      };
    };

    watch(made[0]);
    await diffs.show(message());
    watch(made[1]);
    diffs.close();

    expect(focusAtDispose).toEqual([false, false]);
  });

  it("closes when Escape is let go, and the graph hears neither key", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    await diffs.show(message());
    const graphHeard: string[] = [];
    const listen = (e: KeyboardEvent) => graphHeard.push(`${e.type} ${e.key}`);
    document.addEventListener("keydown", listen);
    document.addEventListener("keyup", listen);
    const inEditor = document.activeElement!;

    key(inEditor, "keydown", "ArrowDown");
    key(inEditor, "keyup", "ArrowDown");
    key(inEditor, "keydown", "Escape");
    // Still open on the way down: the way up would otherwise reach the graph,
    // and Escape let go there closes its Commit Details View.
    expect(panel().hidden).toBe(false);
    key(inEditor, "keyup", "Escape");

    expect(panel().hidden).toBe(true);
    expect(made[0].disposed).toBe(true);
    expect(graphHeard).toEqual([]);
    document.removeEventListener("keydown", listen);
    document.removeEventListener("keyup", listen);
  });

  it("stays open on an Escape the editor took for itself", async () => {
    // Monaco's find widget closes on Escape, and keeps the key down to itself.
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    await diffs.show(message());
    const inEditor = document.activeElement!;
    inEditor.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    key(inEditor, "keydown", "Escape");
    key(inEditor, "keyup", "Escape");

    expect(panel().hidden).toBe(false);
    expect(made[0].disposed).toBe(false);
  });

  it("shows a second diff in place of the first, keeping the keyboard's way back", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    document.getElementById("cdvFile")!.focus();
    await diffs.show(message());

    await diffs.show(message({ title: "other.txt (def5678)" }));

    expect(made[0].disposed).toBe(true);
    expect(made[1].disposed).toBe(false);
    expect(document.querySelectorAll("#diffViewer")).toHaveLength(1);
    expect(panel().querySelector(".diffViewerTitle")!.textContent).toBe("other.txt (def5678)");
    diffs.close();
    expect(document.activeElement!.id).toBe("cdvFile");
  });

  it("does not keep an editor that came after the panel was closed", async () => {
    const { editors, made, hold } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showing = diffs.show(message());

    diffs.close();
    release();
    await showing;

    expect(panel().hidden).toBe(true);
    expect(made[0].disposed).toBe(true);
  });

  it("hands an editor still being made the layout chosen meanwhile", async () => {
    const { editors, made, hold } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showing = diffs.show(message());

    layoutButton("inline").click();
    release();
    await showing;

    expect(made[0].options.layout).toBe("sideBySide");
    expect(made[0].layouts).toEqual(["inline"]);
  });

  it("follows the page's theme", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    await diffs.show(message());

    document.body.classList.replace("vscode-dark", "vscode-light");
    await new Promise((resolve) => setTimeout(resolve));

    expect(made[0].themes).toEqual(["light"]);
  });

  it("is busy while the editor is being made, and not once it is in", async () => {
    const { editors, hold } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showing = diffs.show(message());

    expect(panel().getAttribute("aria-busy")).toBe("true");
    release();
    await showing;

    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });

  it("is not busy once closed while an editor was being made", async () => {
    const { editors, hold } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showing = diffs.show(message());

    diffs.close();
    release();
    await showing;

    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });

  it("shows the host's one line in place of an editor when there is no text to compare", async () => {
    const { editors, made } = fakeEditors();
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });

    await diffs.show(message({ notShown: "Binary file: there is no text to compare." }));

    const notice = panel().querySelector<HTMLElement>(".diffViewerNotice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("Binary file: there is no text to compare.");
    expect(made).toEqual([]);
    expect(panel().hasAttribute("aria-busy")).toBe(false);

    // The next diff with text has its editor, and not the line.
    await diffs.show(message());
    expect(notice.hidden).toBe(true);
    expect(made).toHaveLength(1);
  });

  it("lets a failure to make an editor for a diff no longer shown go unsaid", async () => {
    let fail!: (e: Error) => void;
    const editors: EditorFactory = {
      createDiffViewer: () => new Promise((_resolve, reject) => (fail = reject)),
      createFileViewer: () => Promise.reject(new Error("not asked"))
    };
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });
    const showing = diffs.show(message());

    diffs.close();
    fail(new Error("monaco.js did not load"));

    // Nothing to report: nobody is waiting on that diff any more.
    await expect(showing).resolves.toBeUndefined();
    expect(panel().querySelector<HTMLElement>(".diffViewerError")!.hidden).toBe(true);
  });

  it("says so in the panel when there is no editor to show the diff in, and rejects", async () => {
    const editors: EditorFactory = {
      createDiffViewer: () => Promise.reject(new Error("monaco.js did not load")),
      createFileViewer: () => Promise.reject(new Error("not asked"))
    };
    const diffs = createDiffPanel(editors, { storage: memoryStorage() });

    await expect(diffs.show(message())).rejects.toThrow("monaco.js did not load");

    const error = panel().querySelector<HTMLElement>(".diffViewerError")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("No editor");
    expect(error.getAttribute("role")).toBe("alert");
    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });
});

const fileMessage = (overrides: Partial<ShowFileMessage> = {}): ShowFileMessage => ({
  command: "showFile",
  title: "file.ts (abc1234)",
  file: { path: "src/file.ts", content: "const a = 1;\n" },
  notShown: null,
  strings: { close: "Close File", cannotShow: "No file editor" },
  ...overrides
});

describe("a file shown read-only in the diff viewer (#405)", () => {
  it("shows the host's file over the graph, titled, with no layouts to switch", async () => {
    const { editors, made, files } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });

    await viewer.showFile(fileMessage());

    expect(panel().hidden).toBe(false);
    expect(panel().querySelector(".diffViewerTitle")!.textContent).toBe("file.ts (abc1234)");
    expect(made).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].options).toEqual({
      document: { path: "src/file.ts", content: "const a = 1;\n" },
      theme: "dark"
    });
    expect(panel().querySelector<HTMLElement>(".diffViewerLayouts")!.hidden).toBe(true);
    expect(panel().querySelector(".diffViewerClose")!.getAttribute("aria-label")).toBe(
      "Close File"
    );
    // The keyboard is in the file.
    expect(files[0].container.contains(document.activeElement)).toBe(true);
  });

  it("takes a diff's place, and gives its own to the next diff", async () => {
    const { editors, made, files } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });
    document.getElementById("cdvFile")!.focus();
    await viewer.show(message());

    await viewer.showFile(fileMessage());
    expect(made[0].disposed).toBe(true);
    expect(files[0].disposed).toBe(false);

    await viewer.show(message());
    expect(files[0].disposed).toBe(true);
    expect(panel().querySelector<HTMLElement>(".diffViewerLayouts")!.hidden).toBe(false);
    expect(layoutButton("inline").textContent).toBe("Inline");
    expect(document.querySelectorAll("#diffViewer")).toHaveLength(1);
    viewer.close();
    expect(document.activeElement!.id).toBe("cdvFile");
  });

  it("closes when Escape is let go, done with the editor, the keyboard back where it was", async () => {
    const { editors, files } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });
    document.getElementById("cdvFile")!.focus();
    await viewer.showFile(fileMessage());
    const inEditor = document.activeElement!;

    key(inEditor, "keydown", "Escape");
    key(inEditor, "keyup", "Escape");

    expect(panel().hidden).toBe(true);
    expect(files[0].disposed).toBe(true);
    expect(document.activeElement!.id).toBe("cdvFile");
  });

  it("is busy while the editor is being made, and follows the page's theme once in", async () => {
    const { editors, files, hold } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showing = viewer.showFile(fileMessage());

    expect(panel().getAttribute("aria-busy")).toBe("true");
    release();
    await showing;
    expect(panel().hasAttribute("aria-busy")).toBe(false);

    document.body.classList.replace("vscode-dark", "vscode-light");
    await new Promise((resolve) => setTimeout(resolve));
    expect(files[0].themes).toEqual(["light"]);
  });

  it("shows the host's one line in place of an editor when there is no text to show", async () => {
    const { editors, files } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });

    await viewer.showFile(fileMessage({ notShown: "Binary file: there is no text to show." }));

    const notice = panel().querySelector<HTMLElement>(".diffViewerNotice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("Binary file: there is no text to show.");
    expect(files).toEqual([]);
  });

  it("does not keep a file's editor that came after a diff took its place", async () => {
    const { editors, made, files, hold } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showingFile = viewer.showFile(fileMessage());

    // The diff is held back too: both are made once released.
    const showingDiff = viewer.show(message());
    release();
    await Promise.all([showingFile, showingDiff]);

    expect(files[0].disposed).toBe(true);
    expect(made[0].disposed).toBe(false);
    expect(panel().querySelector(".diffViewerTitle")!.textContent).toBe(
      "file.txt (abc1234^ ↔ abc1234)"
    );
    expect(panel().querySelector<HTMLElement>(".diffViewerLayouts")!.hidden).toBe(false);
    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });

  it("does not keep a file's editor that came after the panel was closed, nor stay busy", async () => {
    const { editors, files, hold } = fakeEditors();
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });
    const release = hold();
    const showing = viewer.showFile(fileMessage());

    viewer.close();
    release();
    await showing;

    expect(panel().hidden).toBe(true);
    expect(files[0].disposed).toBe(true);
    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });

  it("says so in the panel, in its own words, when there is no editor to show it in", async () => {
    const editors: EditorFactory = {
      createDiffViewer: () => Promise.reject(new Error("not asked")),
      createFileViewer: () => Promise.reject(new Error("monaco.js did not load"))
    };
    const viewer = createDiffPanel(editors, { storage: memoryStorage() });

    await expect(viewer.showFile(fileMessage())).rejects.toThrow("monaco.js did not load");

    const error = panel().querySelector<HTMLElement>(".diffViewerError")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("No file editor");
    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });
});
