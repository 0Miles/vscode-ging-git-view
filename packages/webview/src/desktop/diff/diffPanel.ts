/* The diff viewer (#404): a panel over the graph's area showing the diff the
 * host sent (`ShowDiffMessage`), drawn by the editor `apps/desktop` hands the
 * desktop entry (editors.ts). Two layouts, side by side and inline, switched
 * from its bar and remembered in the page's own storage; closed with its
 * close button or Escape, the keyboard then back where it was before.
 *
 * It does not take the page over: the graph stays where it is under it, and
 * a dialog the graph raises meanwhile shows over it (diffPanelStyles.ts).
 * The keys pressed in it stay in it — the graph's own shortcuts listen on the
 * document, and an arrow key or Escape meant for the diff must not move the
 * graph's selection or close its Commit Details View. */

import type {
  DiffLayout,
  DiffViewer,
  EditorFactory,
  HunkActions,
  ThemeKind
} from "@ging/webview/desktop/editors";

import { DIFF_PANEL_STYLES } from "./diffPanelStyles";
import type { DiffHunkRequest, ShowDiffMessage } from "./protocol";

/** Where the layout last chosen is kept: the page's own origin, for this
 *  user, across sessions. A convenience — lost, the viewer opens side by side. */
export const LAYOUT_STORAGE_KEY = "ging.diffViewer.layout";

const LAYOUTS: readonly DiffLayout[] = ["sideBySide", "inline"];

export type DiffPanel = {
  /** Show `message`'s diff, in place of any shown. Rejects when the editor
   *  could not be made, after saying so in the panel. */
  show(message: ShowDiffMessage): Promise<void>;
  /** Close it, if it is open. */
  close(): void;
};

function storedLayout(storage: Storage | null): DiffLayout {
  try {
    const value = storage?.getItem(LAYOUT_STORAGE_KEY);
    return LAYOUTS.find((layout) => layout === value) ?? "sideBySide";
  } catch {
    return "sideBySide";
  }
}

function storeLayout(storage: Storage | null, layout: DiffLayout): void {
  try {
    storage?.setItem(LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Not kept: it is only a convenience.
  }
}

function pageStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's theme, as the host writes it on `<body>`. */
function themeOf(doc: Document): ThemeKind {
  return doc.body.classList.contains("vscode-light") ? "light" : "dark";
}

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>';

export type DiffPanelOptions = {
  /** Where the layout is remembered; the page's own storage when not given. */
  storage?: Storage | null;
  /** Ask the host to stage or unstage a hunk (#406). Without it, no diff
   *  offers any. */
  askHunk?: (request: DiffHunkRequest) => void;
};

export function createDiffPanel(editors: EditorFactory, options: DiffPanelOptions = {}): DiffPanel {
  const storage = options.storage === undefined ? pageStorage() : options.storage;
  let parts: ReturnType<typeof build> | null = null;
  let viewer: DiffViewer | null = null;
  let layout = storedLayout(storage);
  /** Bumped by every show and close: a viewer that comes after its show was
   *  overtaken is not wanted any more. */
  let generation = 0;
  /** What had the keyboard before the panel opened. */
  let returnFocus: Element | null = null;
  /** Escape went down in the panel, and nothing in it took it: its going up
   *  closes the panel. Closing on the way down would hand the key's going up
   *  to the graph, which closes what is open there on it (`documentKeyup`). */
  let escapeDown = false;

  function build() {
    const style = document.createElement("style");
    style.textContent = DIFF_PANEL_STYLES;
    document.head.append(style);

    const panel = document.createElement("section");
    panel.id = "diffViewer";
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "diffViewerTitle");

    const bar = document.createElement("div");
    bar.className = "diffViewerBar";
    const title = document.createElement("h2");
    title.id = "diffViewerTitle";
    title.className = "diffViewerTitle";
    const layouts = document.createElement("div");
    layouts.className = "diffViewerLayouts";
    layouts.setAttribute("role", "group");
    const layoutButtons = LAYOUTS.map((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.layout = value;
      button.addEventListener("click", () => chooseLayout(value));
      return button;
    });
    layouts.append(...layoutButtons);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "diffViewerClose";
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", () => closePanel());
    bar.append(title, layouts, close);

    const error = document.createElement("p");
    error.className = "diffViewerError";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const notice = document.createElement("p");
    notice.className = "diffViewerNotice";
    notice.hidden = true;
    // Over the editor: why the diff offers no hunk, or what became of the
    // last one asked for (#406).
    const said = document.createElement("p");
    said.className = "diffViewerSaid";
    said.setAttribute("role", "status");
    said.hidden = true;
    const editorArea = document.createElement("div");
    editorArea.className = "diffViewerEditor";
    panel.append(bar, error, notice, said, editorArea);

    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        escapeDown = true;
      }
      e.stopPropagation();
    });
    panel.addEventListener("keyup", (e) => {
      if (e.key === "Escape" && escapeDown) {
        escapeDown = false;
        closePanel();
      }
      e.stopPropagation();
    });

    // The theme changes on <body>'s class, after the colours on <html>.
    new MutationObserver(() => viewer?.setTheme(themeOf(document))).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
    });

    document.body.append(panel);
    return { panel, title, layoutButtons, close, error, notice, said, editorArea };
  }

  function showLayout(p: NonNullable<typeof parts>) {
    for (const button of p.layoutButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
    }
  }

  function chooseLayout(value: DiffLayout) {
    layout = value;
    storeLayout(storage, value);
    if (parts !== null) showLayout(parts);
    viewer?.setLayout(value);
  }

  /** Done with the viewer shown. The keyboard is taken out of it first, by
   *  the callers: an editor losing the keyboard reacts to it, and should
   *  still be there to. */
  function disposeViewer() {
    viewer?.dispose();
    viewer = null;
  }

  /** The hunks `message` offers, for the diff shown as `generation` `mine`.
   *  One hunk is asked for at a time: the host answers with the file's diff
   *  shown anew, and a second click on this one would name a hunk of a diff
   *  that is no longer there. */
  function hunkActions(message: ShowDiffMessage, mine: number): HunkActions | undefined {
    const offered = message.hunks;
    const askHunk = options.askHunk;
    if (offered === undefined || askHunk === undefined || offered.hunks.length === 0) {
      return undefined;
    }
    let asked = false;
    return {
      label: offered.label,
      hunks: offered.hunks,
      choose: (index) => {
        if (asked || mine !== generation || parts === null) return;
        asked = true;
        // Busy until the diff comes back, as while an editor is made.
        parts.panel.setAttribute("aria-busy", "true");
        askHunk({
          command: "diffHunk",
          path: offered.path,
          area: offered.area,
          token: offered.token,
          hunk: index
        });
      }
    };
  }

  function closePanel() {
    if (parts === null || parts.panel.hidden) return;
    generation++;
    escapeDown = false;
    const back = returnFocus;
    returnFocus = null;
    // Back where it was, if that is still in the page; out of the panel
    // otherwise. Before the viewer is done with: see `disposeViewer`.
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    if (parts.panel.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
    parts.panel.hidden = true;
    parts.panel.removeAttribute("aria-busy");
    disposeViewer();
    parts.editorArea.replaceChildren();
  }

  return {
    async show(message) {
      parts ??= build();
      const p = parts;
      const mine = ++generation;
      if (p.panel.hidden) {
        returnFocus = document.activeElement;
        p.panel.hidden = false;
      }
      // The keyboard out of the last diff's viewer before it is done with,
      // and on the panel until the new one has it.
      p.panel.focus();
      disposeViewer();
      p.title.textContent = message.title;
      p.title.title = message.title;
      p.layoutButtons[0].textContent = message.strings.sideBySide;
      p.layoutButtons[1].textContent = message.strings.inline;
      p.close.title = message.strings.close;
      p.close.setAttribute("aria-label", message.strings.close);
      showLayout(p);
      p.error.hidden = true;
      p.notice.hidden = true;
      p.said.textContent = message.said ?? "";
      p.said.hidden = message.said === undefined;
      p.editorArea.replaceChildren();
      if (message.notShown !== null) {
        // No text to compare: said in one line, and no editor made.
        p.notice.textContent = message.notShown;
        p.notice.hidden = false;
        p.panel.removeAttribute("aria-busy");
        return;
      }
      // A new element for each diff: nothing of the last one's editor is left.
      const container = document.createElement("div");
      container.style.position = "absolute";
      container.style.inset = "0";
      p.editorArea.append(container);
      // Until the editor is in it: the first diff on a page loads the editor's
      // code first, which takes seconds on a slow machine.
      p.panel.setAttribute("aria-busy", "true");

      const asked = { layout, theme: themeOf(document) };
      const hunks = hunkActions(message, mine);
      let made: DiffViewer;
      try {
        made = await editors.createDiffViewer(container, {
          original: message.original,
          modified: message.modified,
          ...asked,
          revealLine: message.revealLine,
          ...(hunks !== undefined && { hunks })
        });
      } catch (e) {
        // A diff closed or replaced meanwhile has nobody to tell: no failure
        // of the page's either, as far as the viewer shown now goes.
        if (mine !== generation) return;
        p.panel.removeAttribute("aria-busy");
        p.error.textContent = message.strings.cannotShow;
        p.error.hidden = false;
        throw e;
      }
      if (mine !== generation) {
        // Closed, or another diff shown, while this one was being made.
        made.dispose();
        return;
      }
      p.panel.removeAttribute("aria-busy");
      viewer = made;
      // Changed while it was being made (the editor's code loads on the
      // first diff): what was asked for then is not what is shown now.
      if (asked.layout !== layout) made.setLayout(layout);
      if (asked.theme !== themeOf(document)) made.setTheme(themeOf(document));
      made.focus();
    },
    close: closePanel
  };
}
