/* What the desktop host and a Tab's working tree panel say to each other
 * (#403). The panel is a desktop-only screen beside the graph, in the same
 * page, so its messages share the page's `message` event and the host's
 * channel with the graph's, and stay out of `RequestMessage` /
 * `ResponseMessage` (ADR-0031). */

import type { WorkingTreeChange, WorkingTreeStatus } from "@ging/shared/backend/types";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

/** The panel's words, in the host's language: they come with every status,
 *  so the panel needs none of the graph's strings. */
export type WorkingTreeStrings = {
  title: string;
  close: string;
  /** The commit message box's placeholder. */
  message: string;
  commit: string;
  staged: string;
  unstaged: string;
  conflicted: string;
  stage: string;
  stageAll: string;
  unstage: string;
  unstageAll: string;
  /** Said in place of the lists when nothing has changed. */
  clean: string;
  /** Each kind of change, for the letter's tooltip. */
  changes: Record<WorkingTreeChange, string>;
};

/** Page → host. */
export type WorkingTreeRequest =
  | { command: "workingTreeLoad" }
  /** Whole files; `paths: null` is every change. */
  | { command: "workingTreeStage"; paths: string[] | null }
  | { command: "workingTreeUnstage"; paths: string[] | null }
  | { command: "workingTreeCommit"; message: string };

/** Host → page. */
export type WorkingTreeMessage =
  /** Show the panel: what the graph's Open Source Control View opens. */
  | { command: "workingTreeShow" }
  /** The answer to each request: the working tree as it is after it, and why
   *  it failed, if it did. */
  | {
      command: "workingTreeStatus";
      /** What it answers. */
      request: WorkingTreeRequest["command"];
      /** `null` when it could not be read. */
      status: WorkingTreeStatus | null;
      error: string | null;
      strings: WorkingTreeStrings;
    };

export type WorkingTreeStatusMessage = Extract<
  WorkingTreeMessage,
  { command: "workingTreeStatus" }
>;

/** True when `A` and `B` share no command name. */
type NoCommandShared<A extends string, B extends string> = [Extract<A, B>] extends [never]
  ? true
  : false;

/** Checked by the compiler: a message named like one of the graph's would be
 *  taken by the graph's dispatch, or the host's, for its own (ADR-0031). */
export const WORKING_TREE_COMMANDS_STAY_APART: NoCommandShared<
  WorkingTreeMessage["command"],
  ResponseMessage["command"]
> &
  NoCommandShared<WorkingTreeRequest["command"], RequestMessage["command"]> = true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isPaths = (value: unknown): value is string[] | null =>
  value === null || (Array.isArray(value) && value.every((path) => typeof path === "string"));

/** Whether `data`, posted by a Tab's page, is one of the panel's requests. */
export function isWorkingTreeRequest(data: unknown): data is WorkingTreeRequest {
  if (!isRecord(data)) return false;
  switch (data.command) {
    case "workingTreeLoad":
      return true;
    case "workingTreeStage":
    case "workingTreeUnstage":
      return isPaths(data.paths);
    case "workingTreeCommit":
      return typeof data.message === "string";
    default:
      return false;
  }
}

/** Whether `data`, heard on the page's `message` channel, is the panel's. */
export function isWorkingTreeMessage(data: unknown): data is WorkingTreeMessage {
  if (!isRecord(data)) return false;
  if (data.command === "workingTreeShow") return true;
  return data.command === "workingTreeStatus" && isRecord(data.strings);
}
