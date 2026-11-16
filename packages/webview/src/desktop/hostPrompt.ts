/* The desktop host's prompts (#390): what the main process asks the page to put
 * in front of the user — the questions of `Prompts` (`@ging/core/host/ports`)
 * that are not the system's own dialogs — and what the page answers. Both sides
 * share these types: the page draws them (`hostPromptOverlay.ts`), the main
 * process asks and reads the answers (`apps/desktop/src/ports/prompts.ts`).
 *
 * They travel the graph's own `message` channel but stay out of
 * `ResponseMessage` and `RequestMessage` (ADR-0031), so neither the VS Code
 * entry nor the host's dispatch ever learns of them. */

import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

/** One row of a pick or pickMany, without its value: the page answers with
 *  the row's index, and the host holds the values. */
export type HostPromptItem = {
  label: string;
  description?: string;
  /** A second line under the label (`PickItem.detail`); not filtered on. */
  detail?: string;
  /** A rule above the row (`PickItem.separatorAbove`). */
  separatorAbove?: boolean;
  /** Checked when a pickMany opens. */
  picked?: boolean;
  /** Marked as a warning (`PickItem.warning`); the page draws the mark. */
  warning?: boolean;
};

export type HostPrompt =
  | {
      kind: "pick" | "pickMany";
      items: HostPromptItem[];
      placeholder?: string;
      /** Filter on the descriptions as well as the labels. */
      matchOnDescription: boolean;
    }
  | {
      kind: "choose";
      message: string;
      detail?: string;
      /** The buttons besides Cancel, which the page adds. */
      actions: string[];
    }
  | {
      kind: "input";
      prompt: string;
      placeholder?: string;
      /** Mask what is typed. */
      password: boolean;
      /** Text the answer starts from. */
      value?: string;
      /** Why the text last answered was refused (`Prompts.input`'s
       *  `validate`): the host asks again from it, saying why. */
      error?: string;
    };

/** The words on the overlay's own buttons, in the host's language: they come
 *  with each prompt, so the overlay needs no strings of the page's. */
export type HostPromptLabels = { ok: string; cancel: string };

/** Host → page: show `prompt`, after any shown or waiting before it. */
export type HostPromptMessage = {
  command: "hostPrompt";
  /** Unique within the page's host instance; the answer carries it back. */
  id: number;
  prompt: HostPrompt;
  labels: HostPromptLabels;
};

/** The answer to each kind of prompt; `null` is the prompt dismissed. */
export type HostPromptAnswers = {
  /** The index of the row chosen. */
  pick: number;
  /** The indices of the rows checked — none is an answer too. */
  pickMany: number[];
  /** The index of the action clicked. */
  choose: number;
  /** The text entered. */
  input: string;
};
export type HostPromptAnswer = HostPromptAnswers[keyof HostPromptAnswers] | null;

/** Page → host. */
export type HostPromptReply =
  /** The page is listening for prompts: until it says so after each load,
   *  the host holds them back rather than send them into nothing. */
  | { command: "hostPromptReady" }
  | { command: "hostPromptAnswer"; id: number; answer: HostPromptAnswer };

/** True when `A` and `B` share no command name. */
type NoCommandShared<A extends string, B extends string> = [Extract<A, B>] extends [never]
  ? true
  : false;

/**
 * Checked by the compiler, not at runtime: a host prompt message named like
 * one of the graph's would be taken by the graph's dispatch for its own, and a
 * reply named like a request would be handled by the host's (ADR-0031).
 */
export const COMMANDS_STAY_APART: NoCommandShared<
  HostPromptMessage["command"],
  ResponseMessage["command"]
> &
  NoCommandShared<HostPromptReply["command"], RequestMessage["command"]> = true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const KINDS: ReadonlySet<unknown> = new Set<HostPrompt["kind"]>([
  "pick",
  "pickMany",
  "choose",
  "input"
]);

/** Whether `data`, heard on the page's `message` channel, is a host prompt. */
export function isHostPromptMessage(data: unknown): data is HostPromptMessage {
  return (
    isRecord(data) &&
    data.command === "hostPrompt" &&
    typeof data.id === "number" &&
    isRecord(data.prompt) &&
    KINDS.has(data.prompt.kind) &&
    isRecord(data.labels)
  );
}

/** Whether `data`, posted by the page, is a reply to the host's prompts. */
export function isHostPromptReply(data: unknown): data is HostPromptReply {
  if (!isRecord(data)) return false;
  if (data.command === "hostPromptReady") return true;
  return data.command === "hostPromptAnswer" && typeof data.id === "number" && "answer" in data;
}

/**
 * The rows of `items` that `query` matches, by index, in their order: those
 * whose label — and description, when `matchOnDescription` — contains the
 * query, ignoring case and the spaces around it. An empty query matches all.
 */
export function matchingItems(
  items: readonly HostPromptItem[],
  query: string,
  matchOnDescription: boolean
): number[] {
  const needle = query.trim().toLowerCase();
  const matches: number[] = [];
  items.forEach((item, index) => {
    const haystacks = [item.label, ...(matchOnDescription ? [item.description ?? ""] : [])];
    if (haystacks.some((text) => text.toLowerCase().includes(needle))) matches.push(index);
  });
  return matches;
}
