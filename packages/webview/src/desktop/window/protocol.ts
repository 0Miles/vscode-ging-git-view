/* What the desktop host and its window's own page say to each other (#393).
 * The window's page is the tab strip along the top and, under it, the
 * Welcome page (GLOSSARY.md); each Tab's page is a view of its own laid over
 * the Welcome page, below the strip. Desktop-only, so declared under desktop/
 * and never part of `RequestMessage` / `ResponseMessage` (ADR-0031). */

import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

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
    initRepo: string;
    recent: string;
    noRecent: string;
    missing: string;
    forget: string;
  };
};

/** Host → page: the Tabs and what the Welcome page says, whole each time. */
export type WindowStateMessage = {
  command: "windowState";
  tabs: TabStripEntry[];
  notice: WelcomeNotice | null;
  /** `null` while a Tab is open: its view covers the Welcome page. */
  welcome: WelcomeContent | null;
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
  /** A repository of the recent list, by its `path`. */
  | { command: "openRecent"; path: string }
  | { command: "forgetRecent"; path: string };

/** True when `A` and `B` share no command name. */
type NoCommandShared<A extends string, B extends string> = [Extract<A, B>] extends [never]
  ? true
  : false;

/** Checked by the compiler: the window's messages share the page's `message`
 *  event and the host's channel with the graph's (ADR-0031). */
export const WINDOW_COMMANDS_STAY_APART: NoCommandShared<
  WindowStateMessage["command"],
  ResponseMessage["command"]
> &
  NoCommandShared<WindowRequest["command"], RequestMessage["command"]> = true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
