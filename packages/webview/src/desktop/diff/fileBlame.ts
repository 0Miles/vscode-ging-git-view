/* The blame of a file shown read-only (#409), as the diff viewer's panel
 * shows it: a Blame toggle in the panel's bar, and, while it is on, each
 * line's annotation drawn by the file's viewer (`FileViewer.setBlame`). The
 * host blames the file it offered (`ShowFileMessage.blame`) when asked, and
 * writes each line's hover when the pointer first comes to it. Clicking an
 * annotation takes the user to its commit in the graph, under the panel,
 * which closes for it.
 *
 * Whether the toggle is on is the user's to choose, and remembered in the
 * page's own storage, as the diff's layout is. */

import type { BlameGutterEvents, FileViewer } from "@ging/webview/desktop/editors";

import type {
  FileBlame,
  FileBlameHostMessage,
  FileBlameOffer,
  FileBlameRequest
} from "./blameProtocol";

/** Where the toggle's state is kept: the page's own origin, for this user,
 *  across sessions. A convenience — lost, blame starts off. */
export const BLAME_STORAGE_KEY = "ging.fileViewer.blame";

/** How long something said beside the toggle (a hash copied) stays. */
export const SAID_MS = 3000;

export type FileBlameControl = {
  /** The toggle and what it says, for the panel's bar. */
  elements: HTMLElement[];
  /** What the file's viewer is to be made with: what the user does with its
   *  annotations. */
  events: BlameGutterEvents;
  /** A file is about to be shown, with `offer` its blame; or a diff, or
   *  nothing (null). Whatever was blamed before is let go. */
  showing(offer: FileBlameOffer | null): void;
  /** The file's viewer is in the panel. */
  viewerReady(viewer: FileViewer): void;
  /** The host's answer. */
  receive(message: FileBlameHostMessage): void;
};

export type FileBlameControlDeps = {
  /** Hand the host a request. */
  post: (request: FileBlameRequest) => void;
  /** Close the panel: the graph under it is where a commit is shown. */
  closePanel: () => void;
  storage: Storage | null;
};

function storedOn(storage: Storage | null): boolean {
  try {
    return storage?.getItem(BLAME_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function storeOn(storage: Storage | null, on: boolean): void {
  try {
    storage?.setItem(BLAME_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not kept: it is only a convenience.
  }
}

export function createFileBlameControl(deps: FileBlameControlDeps): FileBlameControl {
  const { post, storage } = deps;
  let on = storedOn(storage);
  /** The file shown, if it can be blamed. */
  let offer: FileBlameOffer | null = null;
  let viewer: FileViewer | null = null;
  /** Its blame, once in. */
  let blame: FileBlame | null = null;
  /** The host was asked to blame the file shown, and not told to stop. */
  let asked = false;
  /** The lines whose hover was asked for, of the blame shown. */
  let hovered = new Set<number>();
  let saidTimer: ReturnType<typeof setTimeout> | undefined;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "diffViewerBlame";
  toggle.hidden = true;
  toggle.addEventListener("click", () => setOn(!on));
  const status = document.createElement("span");
  status.className = "diffViewerBlameStatus";
  status.setAttribute("role", "status");

  function say(text: string) {
    if (saidTimer !== undefined) clearTimeout(saidTimer);
    saidTimer = undefined;
    status.textContent = text;
  }

  /** Stop what the host blames for the file shown, and draw none of it. */
  function letGo() {
    if (asked && offer !== null) post({ command: "fileBlameClose", file: offer.file });
    asked = false;
    blame = null;
    hovered = new Set();
    say("");
  }

  function ask() {
    if (offer === null || viewer === null || asked) return;
    asked = true;
    say(offer.strings.blaming);
    post({ command: "fileBlameOpen", file: offer.file });
  }

  function setOn(value: boolean) {
    on = value;
    storeOn(storage, value);
    toggle.setAttribute("aria-pressed", String(value));
    if (value) ask();
    else {
      letGo();
      viewer?.setBlame(null);
    }
  }

  /** The commit of line `line`, when it is one: not a line not committed. */
  function commitAt(line: number) {
    const commit = blame === null ? undefined : blame.commits[blame.lines[line]];
    return commit === undefined || commit.uncommitted ? null : commit;
  }

  /** Take the user to `arg`'s commit in the graph: asked of the host before
   *  the panel closes over it, which lets the blame go. */
  function locate(file: number, arg: unknown) {
    post({ command: "fileBlameRun", file, link: "locateCommit", arg });
    deps.closePanel();
  }

  return {
    elements: [toggle, status],
    events: {
      hover(line) {
        if (offer === null || blame === null || hovered.has(line)) return;
        if (line >= blame.lines.length) return;
        hovered.add(line);
        post({ command: "fileBlameHoverOf", file: offer.file, line });
      },
      click(line) {
        const commit = commitAt(line);
        if (offer === null || blame === null || commit === null) return;
        locate(offer.file, { repo: blame.repo, sha: commit.sha });
      },
      link({ link, arg }) {
        if (offer === null) return;
        if (link === "locateCommit") locate(offer.file, arg);
        else post({ command: "fileBlameRun", file: offer.file, link, arg });
      }
    },
    showing(next) {
      letGo();
      viewer = null;
      offer = next;
      toggle.hidden = next === null;
      if (next === null) return;
      toggle.textContent = next.strings.toggle;
      // Opened to be blamed: on, and left on.
      if (next.show && !on) {
        on = true;
        storeOn(storage, true);
      }
      toggle.setAttribute("aria-pressed", String(on));
    },
    viewerReady(made) {
      viewer = made;
      if (on) ask();
    },
    receive(message) {
      if (offer === null || message.file !== offer.file || !asked) return;
      switch (message.command) {
        case "fileBlame":
          blame = message.blame;
          say(message.blame === null ? offer.strings.failed : "");
          viewer?.setBlame(message.blame);
          return;
        case "fileBlameHover":
          if (blame !== null) viewer?.setBlameHover(message.line, message.markdown);
          return;
        case "fileBlameSaid":
          say(message.text);
          saidTimer = setTimeout(() => say(""), SAID_MS);
          return;
      }
    }
  };
}
