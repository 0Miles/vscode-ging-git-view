/* What the desktop host and its window's own page say to each other (#393).
 * The window's page is the tab strip along the top and, under it, the
 * Welcome page (GLOSSARY.md); each Tab's page is a view of its own laid over
 * the Welcome page, below the strip. Desktop-only, so declared under desktop/
 * and never part of `RequestMessage` / `ResponseMessage` (ADR-0031). */

import type { RequestMessage, ResponseMessage } from "@ging/shared/types";
import { isRecord, type NoCommandShared } from "@ging/webview/desktop/protocolGuards";

/** The tab strip's height in CSS pixels: the page draws the strip this tall,
 *  and the main process lays each Tab's view out below it. */
export const TAB_STRIP_HEIGHT = 35;

/** One Tab, as the strip shows it. */
export type TabStripEntry = {
  id: number;
  /** The repository's name. */
  title: string;
  /** Its path, in full. */
  tooltip: string;
  /** The Tab in front. */
  focused: boolean;
  /** A prompt of the Tab's is waiting for an answer in its page. */
  asking: boolean;
};

/** Why the Welcome page shows no repository: a heading and a line under it. */
export type WelcomeNotice = { title: string; detail: string };

/** One repository of the recently opened list (#394): the desktop host's
 *  known repositories (GLOSSARY.md), most recently opened first. */
export type RecentRepoEntry = {
  /** As the app knows it: what the page hands back to open or forget it. */
  path: string;
  /** Its custom name, or its folder's. */
  name: string;
  /** Its folder is not there (`resolveCurrentRepo`): deleted, or a disk not
   *  mounted now. Listed all the same, since nothing tells the two apart. */
  missing: boolean;
};

/** What the Welcome page offers (#394): its entries, and the recent list. */
export type WelcomeContent = {
  recent: RecentRepoEntry[];
  strings: {
    openFolder: string;
    cloneRepo: string;
    initRepo: string;
    recent: string;
    noRecent: string;
    missing: string;
    forget: string;
  };
};

/** A clone running (#395), as the Welcome page shows it over its entries:
 *  every word the host's, the page only lays them out. */
export type ClonePanel = {
  /** What is cloned: its URL, without any credentials in it. */
  title: string;
  /** Where to. */
  folder: string;
  /** Where it has got to: git's own progress line, or the host's words
   *  before git has said anything, or while it is being cancelled. */
  stage: string;
  /** How far through that stage, 0 to 100; `null` when not known. */
  percent: number | null;
  /** Cancel was asked for: the button stays, disabled, until it is done. */
  cancelling: boolean;
  /** The Cancel button's label. */
  cancel: string;
};

/** Host → page: the Tabs and what the Welcome page says, whole each time. */
export type WindowStateMessage = {
  command: "windowState";
  tabs: TabStripEntry[];
  notice: WelcomeNotice | null;
  /** `null` while a Tab is in front: its view covers the Welcome page. */
  welcome: WelcomeContent | null;
  /** The clone running, `null` with none (#395). Drawn on the Welcome page,
   *  and with Tabs open as an entry of the strip's too (#461): in front, with
   *  no Tab marked focused, while the Welcome page is. */
  clone: ClonePanel | null;
  strings: { closeTab: string };
};

/** Page → host. */
export type WindowRequest =
  /** The page listens: until it says so after each load, the host holds the
   *  state back rather than send it into nothing. */
  | { command: "windowReady" }
  | { command: "focusTab"; id: number }
  | { command: "closeTab"; id: number }
  /** The Welcome page's entries (#394): the host asks for the folder. */
  | { command: "openFolder" }
  | { command: "initRepo" }
  /** The Welcome page's Clone Repository (#395), and the Cancel of the
   *  clone it shows running. */
  | { command: "cloneRepo" }
  | { command: "cancelClone" }
  /** The strip's entry for the clone running (#461): bring the Welcome page
   *  and its clone panel forward over the Tabs. */
  | { command: "showClone" }
  /** A repository of the recent list, by its `path`. */
  | { command: "openRecent"; path: string }
  | { command: "forgetRecent"; path: string };

/** Checked by the compiler: the window's messages share the page's `message`
 *  event and the host's channel with the graph's (ADR-0031). */
export const WINDOW_COMMANDS_STAY_APART: NoCommandShared<
  WindowStateMessage["command"],
  ResponseMessage["command"]
> &
  NoCommandShared<WindowRequest["command"], RequestMessage["command"]> = true;

/** Whether `data`, heard on the page's `message` channel, is the window's state. */
export function isWindowStateMessage(data: unknown): data is WindowStateMessage {
  return (
    isRecord(data) &&
    data.command === "windowState" &&
    Array.isArray(data.tabs) &&
    isRecord(data.strings)
  );
}

/** Whether `data`, posted by the window's page, is one of its requests. */
export function isWindowRequest(data: unknown): data is WindowRequest {
  if (!isRecord(data)) return false;
  switch (data.command) {
    case "windowReady":
    case "openFolder":
    case "initRepo":
    case "cloneRepo":
    case "cancelClone":
    case "showClone":
      return true;
    case "focusTab":
    case "closeTab":
      return typeof data.id === "number";
    case "openRecent":
    case "forgetRecent":
      return typeof data.path === "string";
    default:
      return false;
  }
}
