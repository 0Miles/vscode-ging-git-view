/* What the desktop host and a Tab's working tree panel say to each other
 * (#403). The panel is a desktop-only screen beside the graph, in the same
 * page, so its messages share the page's `message` event and the host's
 * channel with the graph's, and stay out of `RequestMessage` /
 * `ResponseMessage` (ADR-0031). */

import type {
  AmendBasis,
  AmendRefusal,
  CommitRefusal,
  WorkingTreeChange,
  WorkingTreeStatus
} from "@ging/shared/backend/types";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

/** The panel's words, in the host's language: they come with every status,
 *  so the panel needs none of the graph's strings. */
export type WorkingTreeStrings = {
  title: string;
  close: string;
  /** The commit message box's placeholder, naming the platform's shortcut. */
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
  /** Under a list cut short: `{0}` is how many rows were left out. */
  more: string;
  /** On a submodule's row, which the panel does not stage. */
  submodule: string;
  /** Each kind of change, for the letter's tooltip. */
  changes: Record<WorkingTreeChange, string>;
  /** The amend tick box (#407), and the commit button's label while it is ticked. */
  amend: string;
  amendCommit: string;
  /** The sign-off tick box, and its tooltip. */
  signOff: string;
  signOffDetail: string;
  /** Why HEAD cannot be amended: the tick box's tooltip, and what a refused
   *  amend says. */
  cannotAmend: Record<AmendRefusal, string>;
  /** Asked before amending a pushed HEAD: `{0}` is the remote branches it is on. */
  amendPushed: string;
  /** The button that goes on with it. */
  amendPushedConfirm: string;
  /** git knows no committer. */
  identityUnknown: string;
};

/** A commit, or an amend of HEAD (#407). Each flag is sent only when set, so
 *  a plain commit is just its message. */
export type WorkingTreeCommitRequest = {
  command: "workingTreeCommit";
  message: string;
  amend?: true;
  signOff?: true;
  /** The commit the user was told is pushed, and said to amend all the
   *  same: HEAD must still be it, or the host asks again. */
  rewritePushed?: string;
};

/** Page → host. */
export type WorkingTreeRequest =
  | { command: "workingTreeLoad" }
  /** Whole files, each named: "Stage All" names every file listed, never
   *  "everything", which would take in the conflicted ones too. */
  | { command: "workingTreeStage"; paths: string[] }
  | { command: "workingTreeUnstage"; paths: string[] }
  | WorkingTreeCommitRequest;

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
      /** What an amend of HEAD would start from; `null` when it could not
       *  be read. */
      amend: AmendBasis | null;
      error: string | null;
      /** A commit the host declined to make, and why (#407). */
      refused?: CommitRefusal;
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

const isPaths = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((path) => typeof path === "string");

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
      return (
        typeof data.message === "string" &&
        [data.amend, data.signOff].every((flag) => flag === undefined || flag === true) &&
        (data.rewritePushed === undefined || typeof data.rewritePushed === "string")
      );
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
